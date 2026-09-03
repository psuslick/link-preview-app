import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";

const PORT = 3000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 LinkPreviewApp/2.0";

// Network-pressure guardrails. These values are intentionally conservative enough
// for hundreds of links while still allowing much higher throughput than serial work.
const GLOBAL_NETWORK_LIMIT = 16;
const PER_HOST_NETWORK_LIMIT = 4;
const REQUEST_TIMEOUT_MS = 9000;
const HTML_LIMIT_BYTES = 512 * 1024;
const JSON_LIMIT_BYTES = 256 * 1024;
const IMAGE_LIMIT_BYTES = 6 * 1024 * 1024;
const IMAGE_NETWORK_LIMIT = 6;
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1500;

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    return new Promise((resolve) => {
      const grant = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          const next = this.waiters.shift();
          if (next) next();
        });
      };

      if (this.active < this.limit) grant();
      else this.waiters.push(grant);
    });
  }
}

const globalNetwork = new Semaphore(GLOBAL_NETWORK_LIMIT);
const imageNetwork = new Semaphore(IMAGE_NETWORK_LIMIT);
const hostSemaphores = new Map();
const hostThrottleState = new Map();
const previewCache = new Map();

function getHostSemaphore(hostname) {
  const key = hostname.toLowerCase();
  if (!hostSemaphores.has(key)) {
    hostSemaphores.set(key, new Semaphore(PER_HOST_NETWORK_LIMIT));
  }
  return hostSemaphores.get(key);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

async function waitForHostCooldown(hostname) {
  const state = hostThrottleState.get(hostname);
  if (!state || state.until <= Date.now()) return;
  await sleep(state.until - Date.now());
}

function markHostThrottled(hostname, retryAfterHeader) {
  const previous = hostThrottleState.get(hostname) || { strikes: 0, until: 0 };
  const strikes = Math.min(previous.strikes + 1, 6);
  const retryAfter = parseRetryAfter(retryAfterHeader);
  const exponential = Math.min(30_000, 1500 * 2 ** (strikes - 1));
  const jitter = Math.floor(Math.random() * 500);
  const delay = Math.min(30_000, Math.max(retryAfter, exponential) + jitter);
  hostThrottleState.set(hostname, {
    strikes,
    until: Math.max(previous.until, Date.now() + delay)
  });
  return delay;
}

function markHostHealthy(hostname) {
  const state = hostThrottleState.get(hostname);
  if (!state) return;
  const strikes = Math.max(0, state.strikes - 1);
  if (strikes === 0 && state.until <= Date.now()) hostThrottleState.delete(hostname);
  else hostThrottleState.set(hostname, { ...state, strikes });
}

function isBlockedIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  // Documentation / benchmark / non-routable ranges: never useful for this app.
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function isBlockedIPv6(address) {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith("ff")) return true;
  if (lower.startsWith("2001:db8")) return true;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) return isBlockedIPv4(mapped);
  }
  return false;
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsupported_protocol");
  }
  if (url.username || url.password) throw new Error("url_credentials_not_allowed");

  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("private_network_url_blocked");
  }

  if (net.isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error("private_network_url_blocked");
  }

  return url;
}

// The Agent lookup check is intentionally performed at connection time, not only
// before fetch(), so DNS names cannot normally resolve to a private/LAN address.
function safeLookup(hostname, options, callback) {
  const opts = typeof options === "number" ? { family: options } : { ...(options || {}) };
  dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const publicAddresses = addresses.filter((entry) => !isBlockedAddress(entry.address));
    if (publicAddresses.length !== addresses.length || publicAddresses.length === 0) {
      return callback(new Error("private_network_dns_blocked"));
    }

    if (opts.all) return callback(null, publicAddresses);
    const preferred = opts.family
      ? publicAddresses.find((entry) => entry.family === opts.family)
      : publicAddresses[0];
    if (!preferred) return callback(new Error("no_public_address_for_family"));
    return callback(null, preferred.address, preferred.family);
  });
}

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 5000,
  maxSockets: PER_HOST_NETWORK_LIMIT,
  maxTotalSockets: GLOBAL_NETWORK_LIMIT,
  maxFreeSockets: PER_HOST_NETWORK_LIMIT,
  lookup: safeLookup
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 5000,
  maxSockets: PER_HOST_NETWORK_LIMIT,
  maxTotalSockets: GLOBAL_NETWORK_LIMIT,
  maxFreeSockets: PER_HOST_NETWORK_LIMIT,
  lookup: safeLookup
});

function agentFor(url) {
  return url.protocol === "http:" ? httpAgent : httpsAgent;
}

async function readLimitedBody(body, maxBytes, stopAtHeadEnd = false) {
  if (!body) return { buffer: Buffer.alloc(0), bytes: 0, truncated: false };

  const chunks = [];
  let bytes = 0;
  let truncated = false;
  let asciiProbe = "";

  for await (const rawChunk of body) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const used = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    chunks.push(used);
    bytes += used.length;

    if (stopAtHeadEnd) {
      asciiProbe += used.toString("utf8").toLowerCase();
      if (asciiProbe.length > 64 * 1024) asciiProbe = asciiProbe.slice(-64 * 1024);
      if (asciiProbe.includes("</head>")) break;
    }

    if (chunk.length > remaining || bytes >= maxBytes) {
      truncated = true;
      break;
    }
  }

  if (truncated || stopAtHeadEnd) body.destroy?.();
  return { buffer: Buffer.concat(chunks), bytes, truncated };
}

async function fetchBounded(rawUrl, { kind = "html", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let currentUrl = validateUrl(rawUrl);
  let redirects = 0;
  let lastError = null;

  while (redirects <= MAX_REDIRECTS) {
    const hostname = currentUrl.hostname.toLowerCase();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await waitForHostCooldown(hostname);
      const releaseImage = kind === "image" ? await imageNetwork.acquire() : null;
      const releaseGlobal = await globalNetwork.acquire();
      const releaseHost = await getHostSemaphore(hostname).acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          agent: agentFor,
          headers: {
            "User-Agent": USER_AGENT,
            Accept:
              kind === "json"
                ? "application/json,text/json;q=0.9,*/*;q=0.1"
                : kind === "image"
                  ? "image/avif,image/webp,image/apng,image/*,*/*;q=0.1"
                  : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "Accept-Language": "en-US,en;q=0.8",
            Connection: "keep-alive"
          }
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          response.body?.destroy?.();
          if (!location) throw new Error("redirect_without_location");
          currentUrl = validateUrl(new URL(location, currentUrl).toString());
          redirects += 1;
          markHostHealthy(hostname);
          break;
        }

        if (response.status === 429 || response.status === 503) {
          response.body?.destroy?.();
          const delay = markHostThrottled(hostname, response.headers.get("retry-after"));
          lastError = new Error(`upstream_throttled_${response.status}`);
          if (attempt < MAX_RETRIES) {
            clearTimeout(timer);
            releaseHost();
            releaseGlobal();
            releaseImage?.();
            await sleep(delay);
            continue;
          }
          return {
            ok: false,
            status: response.status,
            finalUrl: currentUrl.toString(),
            error: lastError.message
          };
        }

        const maxBytes =
          kind === "json" ? JSON_LIMIT_BYTES : kind === "image" ? IMAGE_LIMIT_BYTES : HTML_LIMIT_BYTES;
        const body = await readLimitedBody(response.body, maxBytes, kind === "html");
        const text = kind === "image" ? null : body.buffer.toString("utf8");

        if (response.ok) markHostHealthy(hostname);
        return {
          ok: response.ok,
          status: response.status,
          finalUrl: currentUrl.toString(),
          contentType: response.headers.get("content-type") || "",
          text,
          buffer: kind === "image" ? body.buffer : null,
          bytes: body.bytes,
          truncated: body.truncated,
          headers: {
            retryAfter: response.headers.get("retry-after") || null,
            server: response.headers.get("server") || null
          }
        };
      } catch (error) {
        lastError = error;
        if (attempt >= MAX_RETRIES || String(error?.message).includes("private_network")) {
          return {
            ok: false,
            status: 0,
            finalUrl: currentUrl.toString(),
            error: error?.name === "AbortError" ? "request_timeout" : error?.message || "request_failed"
          };
        }
        await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 250));
      } finally {
        clearTimeout(timer);
        // Calling a release twice is harmless because the returned release functions are idempotent.
        releaseHost();
        releaseGlobal();
        releaseImage?.();
      }
    }

    // A redirect updates currentUrl and breaks the retry loop. Continue outer loop.
    if (redirects > 0) continue;
    break;
  }

  return {
    ok: false,
    status: 0,
    finalUrl: currentUrl.toString(),
    error: lastError?.message || "too_many_redirects"
  };
}

function resolveUrl(value, baseUrl) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function findVideoObject(value, depth = 0) {
  if (!value || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoObject(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  const type = value["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((entry) => String(entry || "").toLowerCase() === "videoobject")) {
    return value;
  }

  for (const child of Object.values(value)) {
    const found = findVideoObject(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseDurationSeconds(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return Number(value);
  const match = String(value).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return null;
  return Math.round((Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0));
}

function extractHtmlMetadata(html, pageUrl) {
  const $ = cheerio.load(html);
  const meta = (selector) => $(selector).first().attr("content")?.trim() || null;

  let videoObject = null;
  $('script[type="application/ld+json"]').each((_, element) => {
    if (videoObject) return;
    const text = $(element).text();
    if (!text || text.length > 512_000) return;
    try {
      videoObject = findVideoObject(JSON.parse(text));
    } catch {
      // Invalid JSON-LD is common and should not fail the preview.
    }
  });

  const jsonThumb = Array.isArray(videoObject?.thumbnailUrl)
    ? videoObject.thumbnailUrl[0]
    : videoObject?.thumbnailUrl;

  const image = firstNonEmpty(
    meta('meta[property="og:image:secure_url"]'),
    meta('meta[property="og:image"]'),
    meta('meta[property="og:image:url"]'),
    meta('meta[name="twitter:image"]'),
    meta('meta[name="twitter:image:src"]'),
    meta('meta[itemprop="thumbnailUrl"]'),
    jsonThumb,
    $("video[poster]").first().attr("poster"),
    $('link[rel="image_src"]').first().attr("href")
  );

  const oembedLink = $('link[rel="alternate"][type="application/json+oembed"]')
    .first()
    .attr("href");

  return {
    title: firstNonEmpty(
      meta('meta[property="og:title"]'),
      meta('meta[name="twitter:title"]'),
      videoObject?.name,
      videoObject?.headline,
      $("title").first().text()
    ),
    description: firstNonEmpty(
      meta('meta[property="og:description"]'),
      meta('meta[name="twitter:description"]'),
      meta('meta[name="description"]'),
      videoObject?.description
    ),
    image: resolveUrl(image, pageUrl),
    provider: firstNonEmpty(meta('meta[property="og:site_name"]')),
    durationSeconds:
      parseDurationSeconds(videoObject?.duration) ||
      parseDurationSeconds(meta('meta[property="video:duration"]')) ||
      parseDurationSeconds(meta('meta[property="og:video:duration"]')),
    oembedUrl: resolveUrl(oembedLink, pageUrl)
  };
}

function knownProvider(targetUrl) {
  const url = new URL(targetUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
    return {
      name: "YouTube",
      oembedUrl: `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`
    };
  }
  if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
    return {
      name: "Vimeo",
      oembedUrl: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(targetUrl)}`
    };
  }
  if (host === "dailymotion.com" || host.endsWith(".dailymotion.com") || host === "dai.ly") {
    return {
      name: "Dailymotion",
      oembedUrl: `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(targetUrl)}&format=json`
    };
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return {
      name: "TikTok",
      oembedUrl: `https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`
    };
  }
  return null;
}

function youtubeVideoId(targetUrl) {
  try {
    const url = new URL(targetUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live"].includes(parts[0])) return parts[1] || null;
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchOEmbed(oembedUrl, targetUrl, providerFallback = null) {
  const result = await fetchBounded(oembedUrl, { kind: "json", timeoutMs: 7000 });
  if (!result.ok) return null;
  try {
    const data = JSON.parse(result.text);
    return {
      title: firstNonEmpty(data.title),
      description: firstNonEmpty(data.description),
      image: resolveUrl(data.thumbnail_url, targetUrl),
      provider: firstNonEmpty(data.provider_name, providerFallback),
      durationSeconds: parseDurationSeconds(data.duration),
      method: "oembed",
      upstreamStatus: result.status,
      bytesRead: result.bytes
    };
  } catch {
    return null;
  }
}

function normalizeCacheKey(rawUrl) {
  try {
    const url = validateUrl(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function cacheGet(key) {
  const entry = previewCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL_MS) {
    previewCache.delete(key);
    return null;
  }
  previewCache.delete(key);
  previewCache.set(key, entry);
  return { ...entry.value, cached: true };
}

function cacheSet(key, value) {
  previewCache.set(key, { time: Date.now(), value });
  while (previewCache.size > CACHE_MAX_ENTRIES) {
    previewCache.delete(previewCache.keys().next().value);
  }
}

async function createPreview(rawUrl) {
  const started = Date.now();
  const targetUrl = validateUrl(rawUrl).toString();
  const cacheKey = normalizeCacheKey(targetUrl);
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, elapsedMs: Date.now() - started };

  const provider = knownProvider(targetUrl);

  // Fast lane: known video providers frequently expose a single lightweight oEmbed request.
  if (provider?.oembedUrl) {
    const oembed = await fetchOEmbed(provider.oembedUrl, targetUrl, provider.name);
    if (oembed?.image) {
      const value = {
        url: targetUrl,
        ...oembed,
        elapsedMs: Date.now() - started,
        cached: false
      };
      cacheSet(cacheKey, value);
      return value;
    }
  }

  // YouTube has deterministic thumbnails, so even a throttled oEmbed endpoint can still
  // produce a useful preview without loading the full video page.
  const ytId = youtubeVideoId(targetUrl);
  if (ytId) {
    const value = {
      url: targetUrl,
      title: null,
      description: null,
      image: `https://i.ytimg.com/vi/${encodeURIComponent(ytId)}/hqdefault.jpg`,
      provider: "YouTube",
      durationSeconds: null,
      method: "provider-derived",
      upstreamStatus: null,
      bytesRead: 0,
      elapsedMs: Date.now() - started,
      cached: false
    };
    cacheSet(cacheKey, value);
    return value;
  }

  const htmlResult = await fetchBounded(targetUrl, { kind: "html" });
  if (!htmlResult.ok) {
    const error = new Error(htmlResult.error || `upstream_status_${htmlResult.status}`);
    error.status = htmlResult.status || 502;
    throw error;
  }

  const metadata = extractHtmlMetadata(htmlResult.text, htmlResult.finalUrl || targetUrl);

  // If the page itself advertises an oEmbed endpoint and HTML did not provide a thumbnail,
  // make one additional bounded request rather than rendering the whole page.
  if (!metadata.image && metadata.oembedUrl) {
    const discovered = await fetchOEmbed(metadata.oembedUrl, targetUrl, metadata.provider);
    if (discovered?.image) {
      const value = {
        url: targetUrl,
        title: discovered.title || metadata.title,
        description: discovered.description || metadata.description,
        image: discovered.image,
        provider: discovered.provider || metadata.provider,
        durationSeconds: discovered.durationSeconds || metadata.durationSeconds,
        method: "oembed-discovered",
        upstreamStatus: htmlResult.status,
        bytesRead: htmlResult.bytes + (discovered.bytesRead || 0),
        elapsedMs: Date.now() - started,
        cached: false
      };
      cacheSet(cacheKey, value);
      return value;
    }
  }

  const value = {
    url: targetUrl,
    title: metadata.title,
    description: metadata.description,
    image: metadata.image,
    provider: metadata.provider || provider?.name || null,
    durationSeconds: metadata.durationSeconds,
    method: metadata.image ? "video-metadata" : "metadata-no-thumbnail",
    upstreamStatus: htmlResult.status,
    bytesRead: htmlResult.bytes,
    elapsedMs: Date.now() - started,
    cached: false
  };

  if (value.image || value.title) cacheSet(cacheKey, value);
  return value;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    limits: {
      globalNetwork: GLOBAL_NETWORK_LIMIT,
      perHostNetwork: PER_HOST_NETWORK_LIMIT,
      imageNetwork: IMAGE_NETWORK_LIMIT,
      htmlBytes: HTML_LIMIT_BYTES,
      imageBytes: IMAGE_LIMIT_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: MAX_RETRIES
    },
    activeNetwork: globalNetwork.active,
    queuedNetwork: globalNetwork.waiters.length,
    activeImages: imageNetwork.active,
    queuedImages: imageNetwork.waiters.length,
    cachedPreviews: previewCache.size
  });
});

async function previewHandler(req, res) {
  const targetUrl = req.method === "GET" ? req.query.url : req.body?.url;
  if (!targetUrl || typeof targetUrl !== "string") {
    return res.status(400).json({ error: "missing_url" });
  }

  try {
    const preview = await createPreview(targetUrl.trim());
    return res.json(preview);
  } catch (error) {
    const message = error?.message || "preview_failed";
    const clientError = [
      "invalid_url",
      "unsupported_protocol",
      "url_credentials_not_allowed",
      "private_network_url_blocked",
      "private_network_dns_blocked"
    ].some((code) => message.includes(code));

    const status = clientError ? 400 : error?.status && error.status >= 400 ? 502 : 502;
    return res.status(status).json({
      error: message,
      url: targetUrl
    });
  }
}

app.get("/api/image", async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || typeof imageUrl !== "string") {
    return res.status(400).send("missing_url");
  }

  try {
    const result = await fetchBounded(imageUrl, { kind: "image", timeoutMs: 10_000 });
    if (!result.ok) return res.status(502).send(result.error || "image_fetch_failed");
    if (!result.contentType.toLowerCase().startsWith("image/")) {
      return res.status(415).send("not_an_image");
    }
    if (result.truncated) return res.status(413).send("image_too_large");

    res.setHeader("Content-Type", result.contentType.split(";")[0]);
    res.setHeader("Cache-Control", "private, max-age=1800");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(result.buffer);
  } catch (error) {
    return res.status(400).send(error?.message || "image_fetch_failed");
  }
});

app.get("/api/preview", previewHandler);
app.post("/api/preview", previewHandler);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Video preview engine listening on http://127.0.0.1:${PORT}`);
  console.log(
    `Network limits: ${GLOBAL_NETWORK_LIMIT} global / ${PER_HOST_NETWORK_LIMIT} per host; keep-alive enabled.`
  );
});
