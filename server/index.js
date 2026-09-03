import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const PORT = 3000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

// High-throughput but bounded defaults for hundreds of video links.
const GLOBAL_NETWORK_LIMIT = 16;
const PER_HOST_NETWORK_LIMIT = 4;
const REQUEST_TIMEOUT_MS = 9000;
const HTML_LIMIT_BYTES = 512 * 1024;
const JSON_LIMIT_BYTES = 256 * 1024;
const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;
const IMAGE_NETWORK_LIMIT = 6;
const MAX_REDIRECTS = 5;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1500;

// Alternate/mirror discovery is intentionally small and user-triggered. It reuses
// the same bounded network stack as previews instead of becoming a second crawler.
const ALTERNATE_SEARCH_TIMEOUT_MS = 8000;
const ALTERNATE_SEARCH_MAX_RESULTS = 12;
const ALTERNATE_CANDIDATE_PREVIEW_LIMIT = 12;
const ALTERNATE_CANDIDATE_CONCURRENCY = 3;
const ALTERNATE_CACHE_TTL_MS = 10 * 60 * 1000;
const ALTERNATE_CACHE_MAX_ENTRIES = 100;

// Browser fallback is deliberately much narrower than metadata fetching.
const BROWSER_FALLBACK_LIMIT = 1;
const BROWSER_PROXY_NETWORK_LIMIT = 8;
const BROWSER_FALLBACK_TIMEOUT_MS = 12_000;
const BROWSER_DOM_LIMIT_BYTES = 2 * 1024 * 1024;
const BROWSER_HTTP_RESOURCE_LIMIT_BYTES = 4 * 1024 * 1024;

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
const browserFallback = new Semaphore(BROWSER_FALLBACK_LIMIT);
const browserProxyNetwork = new Semaphore(BROWSER_PROXY_NETWORK_LIMIT);
const hostSemaphores = new Map();
const hostThrottleState = new Map();
const previewCache = new Map();
const alternateCache = new Map();

function getHostSemaphore(hostname) {
  const key = hostname.toLowerCase();
  if (!hostSemaphores.has(key)) hostSemaphores.set(key, new Semaphore(PER_HOST_NETWORK_LIMIT));
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
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
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

function validateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".internal")
  ) {
    throw new Error("private_network_url_blocked");
  }
  if (net.isIP(normalized) && isBlockedAddress(normalized)) {
    throw new Error("private_network_url_blocked");
  }
  return normalized;
}

function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported_protocol");
  if (url.username || url.password) throw new Error("url_credentials_not_allowed");
  validateHostname(url.hostname);
  return url;
}

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

async function resolvePublicAddress(hostname) {
  validateHostname(hostname);
  if (net.isIP(hostname)) return { address: hostname, family: net.isIP(hostname) };
  const addresses = await dns.promises.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("private_network_dns_blocked");
  }
  return addresses[0];
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

function browserLikeHeaders(kind, extraHeaders = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Connection: "keep-alive",
    ...extraHeaders
  };

  if (kind === "json") {
    headers.Accept = "application/json,text/json;q=0.9,*/*;q=0.1";
  } else if (kind === "image") {
    headers.Accept = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
  } else {
    headers.Accept =
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    headers["Upgrade-Insecure-Requests"] = "1";
    headers["Sec-Fetch-Dest"] = "document";
    headers["Sec-Fetch-Mode"] = "navigate";
    headers["Sec-Fetch-Site"] = "none";
    headers["Sec-Fetch-User"] = "?1";
  }
  return headers;
}

async function fetchBounded(
  rawUrl,
  { kind = "html", timeoutMs = REQUEST_TIMEOUT_MS, headers = {}, retries = MAX_RETRIES } = {}
) {
  let currentUrl = validateUrl(rawUrl);
  let redirects = 0;
  let lastError = null;

  while (redirects <= MAX_REDIRECTS) {
    const hostname = currentUrl.hostname.toLowerCase();
    let redirected = false;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
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
          headers: browserLikeHeaders(kind, headers)
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          response.body?.destroy?.();
          if (!location) throw new Error("redirect_without_location");
          currentUrl = validateUrl(new URL(location, currentUrl).toString());
          redirects += 1;
          redirected = true;
          markHostHealthy(hostname);
          break;
        }

        if (response.status === 429 || response.status === 503) {
          response.body?.destroy?.();
          const delay = markHostThrottled(hostname, response.headers.get("retry-after"));
          lastError = new Error(`upstream_throttled_${response.status}`);
          if (attempt < retries) {
            await sleep(delay);
            continue;
          }
          return {
            ok: false,
            status: response.status,
            finalUrl: currentUrl.toString(),
            error: lastError.message,
            contentType: "",
            bytes: 0,
            truncated: false
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
        if (attempt >= retries || String(error?.message).includes("private_network")) {
          return {
            ok: false,
            status: 0,
            finalUrl: currentUrl.toString(),
            error: error?.name === "AbortError" ? "request_timeout" : error?.message || "request_failed",
            contentType: "",
            bytes: 0,
            truncated: false
          };
        }
        await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 250));
      } finally {
        clearTimeout(timer);
        releaseHost();
        releaseGlobal();
        releaseImage?.();
      }
    }

    if (redirected) continue;
    break;
  }

  return {
    ok: false,
    status: 0,
    finalUrl: currentUrl.toString(),
    error: lastError?.message || "too_many_redirects",
    contentType: "",
    bytes: 0,
    truncated: false
  };
}

function resolveUrl(value, baseUrl) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value.trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function uniqueUrls(values, baseUrl) {
  const seen = new Set();
  const result = [];
  for (const value of values.flat(Infinity)) {
    const resolved = resolveUrl(value, baseUrl);
    if (!resolved) continue;
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
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
  if (types.some((entry) => String(entry || "").toLowerCase() === "videoobject")) return value;
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
  return Math.round(
    Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)
  );
}

function extractHtmlMetadata(html, pageUrl) {
  const $ = cheerio.load(html || "");
  const meta = (selector) => $(selector).first().attr("content")?.trim() || null;
  const metas = (selector) =>
    $(selector)
      .map((_, element) => $(element).attr("content")?.trim() || null)
      .get()
      .filter(Boolean);

  let videoObject = null;
  const jsonImages = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const text = $(element).text();
    if (!text || text.length > 512_000) return;
    try {
      const parsed = JSON.parse(text);
      if (!videoObject) videoObject = findVideoObject(parsed);
      const found = findVideoObject(parsed);
      const thumbs = found?.thumbnailUrl;
      if (Array.isArray(thumbs)) jsonImages.push(...thumbs);
      else if (typeof thumbs === "string") jsonImages.push(thumbs);
    } catch {
      // Invalid JSON-LD is common.
    }
  });

  const images = uniqueUrls(
    [
      metas('meta[property="og:image:secure_url"]'),
      metas('meta[property="og:image"]'),
      metas('meta[property="og:image:url"]'),
      metas('meta[name="twitter:image"]'),
      metas('meta[name="twitter:image:src"]'),
      metas('meta[itemprop="thumbnailUrl"]'),
      jsonImages,
      $("video[poster]")
        .map((_, element) => $(element).attr("poster"))
        .get(),
      $('link[rel="image_src"]')
        .map((_, element) => $(element).attr("href"))
        .get()
    ],
    pageUrl
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
    image: images[0] || null,
    images,
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
    return { name: "Vimeo", oembedUrl: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(targetUrl)}` };
  }
  if (host === "dailymotion.com" || host.endsWith(".dailymotion.com") || host === "dai.ly") {
    return {
      name: "Dailymotion",
      oembedUrl: `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(targetUrl)}&format=json`
    };
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return { name: "TikTok", oembedUrl: `https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}` };
  }
  if (host === "streamable.com" || host.endsWith(".streamable.com")) {
    return {
      name: "Streamable",
      oembedUrl: `https://api.streamable.com/oembed.json?url=${encodeURIComponent(targetUrl)}`
    };
  }
  if (host === "loom.com" || host.endsWith(".loom.com")) {
    return { name: "Loom", oembedUrl: `https://www.loom.com/v1/oembed?url=${encodeURIComponent(targetUrl)}` };
  }
  if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) {
    return { name: "X", oembedUrl: `https://publish.x.com/oembed?url=${encodeURIComponent(targetUrl)}` };
  }
  if (host === "reddit.com" || host.endsWith(".reddit.com")) {
    return { name: "Reddit", oembedUrl: `https://www.reddit.com/oembed?url=${encodeURIComponent(targetUrl)}` };
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

function providerDerivedImages(targetUrl) {
  const id = youtubeVideoId(targetUrl);
  if (!id) return [];
  const safe = encodeURIComponent(id);
  return [
    `https://i.ytimg.com/vi/${safe}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${safe}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${safe}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${safe}/mqdefault.jpg`
  ];
}

async function fetchOEmbed(oembedUrl, targetUrl, providerFallback = null) {
  const result = await fetchBounded(oembedUrl, { kind: "json", timeoutMs: 7000 });
  if (!result.ok) return null;
  try {
    const data = JSON.parse(result.text);
    const images = uniqueUrls([data.thumbnail_url, data.thumbnail_url_with_play_button], targetUrl);
    return {
      title: firstNonEmpty(data.title),
      description: firstNonEmpty(data.description),
      image: images[0] || null,
      images,
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
  while (previewCache.size > CACHE_MAX_ENTRIES) previewCache.delete(previewCache.keys().next().value);
}

function mergeMetadata(primary, secondary, pageUrl) {
  const images = uniqueUrls([primary?.images || [], primary?.image, secondary?.images || [], secondary?.image], pageUrl);
  return {
    title: primary?.title || secondary?.title || null,
    description: primary?.description || secondary?.description || null,
    image: images[0] || null,
    images,
    provider: primary?.provider || secondary?.provider || null,
    durationSeconds: primary?.durationSeconds || secondary?.durationSeconds || null,
    oembedUrl: primary?.oembedUrl || secondary?.oembedUrl || null
  };
}

async function findEdgeExecutable() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next path.
    }
  }
  return null;
}

function isLikelyMediaPath(pathname = "") {
  return /\.(?:mp4|m4v|mov|webm|mkv|avi|mp3|m4a|aac|wav|flac|m3u8|mpd|ts)(?:$|[?#])/i.test(pathname);
}

async function startBrowserSafetyProxy() {
  const proxy = http.createServer(async (req, res) => {
    let target;
    try {
      if (!["GET", "HEAD"].includes(req.method || "GET")) {
        res.writeHead(204);
        res.end();
        return;
      }
      target = validateUrl(req.url);
      if (target.protocol !== "http:") throw new Error("proxy_http_only");
      if (isLikelyMediaPath(target.pathname)) {
        res.writeHead(204);
        res.end();
        return;
      }
    } catch {
      res.writeHead(403);
      res.end("blocked");
      return;
    }

    const hostname = target.hostname.toLowerCase();
    const releaseBrowser = await browserProxyNetwork.acquire();
    const releaseGlobal = await globalNetwork.acquire();
    const releaseHost = await getHostSemaphore(hostname).acquire();
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      releaseHost();
      releaseGlobal();
      releaseBrowser();
    };

    const headers = { ...req.headers, host: target.host };
    delete headers["proxy-connection"];
    headers.connection = "keep-alive";

    const upstream = http.request(
      target,
      { method: req.method, headers, agent: httpAgent },
      (upstreamRes) => {
        const contentType = String(upstreamRes.headers["content-type"] || "").toLowerCase();
        if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
          upstreamRes.destroy();
          res.writeHead(204);
          res.end();
          finalize();
          return;
        }

        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        let bytes = 0;
        upstreamRes.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > BROWSER_HTTP_RESOURCE_LIMIT_BYTES) {
            upstreamRes.destroy();
            res.end();
          } else {
            res.write(chunk);
          }
        });
        upstreamRes.on("end", () => {
          res.end();
          finalize();
        });
        upstreamRes.on("error", () => {
          res.destroy();
          finalize();
        });
      }
    );

    upstream.setTimeout(8000, () => upstream.destroy(new Error("proxy_timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
      finalize();
    });
    req.on("aborted", () => {
      upstream.destroy();
      finalize();
    });
    req.pipe(upstream);
  });

  proxy.on("connect", (req, clientSocket, head) => {
    (async () => {
      let authority;
      try {
        authority = new URL(`http://${req.url}`);
        const hostname = validateHostname(authority.hostname);
        const port = Number(authority.port || 443);
        if (port !== 443) throw new Error("connect_port_blocked");

        const resolved = await resolvePublicAddress(hostname);
        const releaseBrowser = await browserProxyNetwork.acquire();
        const releaseGlobal = await globalNetwork.acquire();
        const releaseHost = await getHostSemaphore(hostname).acquire();
        let finalized = false;
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          releaseHost();
          releaseGlobal();
          releaseBrowser();
        };

        const upstreamSocket = net.connect({
          host: resolved.address,
          port,
          family: resolved.family
        });
        upstreamSocket.setTimeout(BROWSER_FALLBACK_TIMEOUT_MS + 4000, () => upstreamSocket.destroy());
        clientSocket.setTimeout(BROWSER_FALLBACK_TIMEOUT_MS + 4000, () => clientSocket.destroy());

        upstreamSocket.once("connect", () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: LinkPreviewSafeProxy\r\n\r\n");
          if (head?.length) upstreamSocket.write(head);
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);
        });

        upstreamSocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstreamSocket.destroy());
        upstreamSocket.on("close", finalize);
        clientSocket.on("close", finalize);
      } catch {
        clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
    })().catch(() => clientSocket.destroy());
  });

  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  return { server: proxy, port: typeof address === "object" && address ? address.port : null };
}

const browserProxy = await startBrowserSafetyProxy();

async function renderMetadataWithEdge(targetUrl) {
  const release = await browserFallback.acquire();
  let profileDir = null;
  try {
    const edgePath = await findEdgeExecutable();
    if (!edgePath || !browserProxy.port) return { ok: false, error: "edge_fallback_unavailable" };

    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "link-preview-edge-"));
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--disable-quic",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--metrics-recording-only",
      "--mute-audio",
      "--autoplay-policy=user-gesture-required",
      "--blink-settings=imagesEnabled=false",
      `--proxy-server=http://127.0.0.1:${browserProxy.port}`,
      "--proxy-bypass-list=<-loopback>",
      `--user-data-dir=${profileDir}`,
      "--window-size=1280,720",
      "--dump-dom",
      targetUrl
    ];

    const result = await new Promise((resolve) => {
      const child = spawn(edgePath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const chunks = [];
      const errors = [];
      let bytes = 0;
      let overflow = false;
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, error: "edge_fallback_timeout" });
      }, BROWSER_FALLBACK_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > BROWSER_DOM_LIMIT_BYTES) {
          overflow = true;
          child.kill();
          finish({ ok: false, error: "edge_dom_too_large" });
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        if (errors.reduce((sum, item) => sum + item.length, 0) < 16 * 1024) errors.push(chunk);
      });
      child.once("error", (error) => finish({ ok: false, error: error.message || "edge_launch_failed" }));
      child.once("close", () => {
        const html = Buffer.concat(chunks).toString("utf8");
        if (!html.trim()) {
          finish({ ok: false, error: "edge_empty_dom", diagnostic: Buffer.concat(errors).toString("utf8").slice(0, 500) });
        } else {
          finish({ ok: true, html, bytes });
        }
      });
    });

    if (!result.ok) return result;
    const metadata = extractHtmlMetadata(result.html, targetUrl);
    return { ok: true, metadata, bytes: result.bytes };
  } finally {
    if (profileDir) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

async function createPreview(rawUrl, { allowBrowserFallback = true } = {}) {
  const started = Date.now();
  const targetUrl = validateUrl(rawUrl).toString();
  const cacheKey = normalizeCacheKey(targetUrl);
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, elapsedMs: Date.now() - started };

  const provider = knownProvider(targetUrl);
  const derivedImages = providerDerivedImages(targetUrl);
  let providerMetadata = null;

  // Fast lane: provider oEmbed first. This often avoids anti-bot HTML pages entirely.
  if (provider?.oembedUrl) {
    providerMetadata = await fetchOEmbed(provider.oembedUrl, targetUrl, provider.name);
    if (providerMetadata?.image) {
      const images = uniqueUrls([providerMetadata.images, derivedImages], targetUrl);
      const value = {
        url: targetUrl,
        ...providerMetadata,
        image: images[0] || null,
        images,
        elapsedMs: Date.now() - started,
        cached: false,
        warning: null,
        browserFallback: false
      };
      cacheSet(cacheKey, value);
      return value;
    }
  }

  // YouTube is special: deterministic thumbnail candidates are reliable and cheap.
  if (derivedImages.length) {
    const value = {
      url: targetUrl,
      title: providerMetadata?.title || null,
      description: providerMetadata?.description || null,
      image: derivedImages[0],
      images: derivedImages,
      provider: providerMetadata?.provider || "YouTube",
      durationSeconds: providerMetadata?.durationSeconds || null,
      method: providerMetadata ? "oembed+provider-derived" : "provider-derived",
      upstreamStatus: providerMetadata?.upstreamStatus ?? null,
      bytesRead: providerMetadata?.bytesRead || 0,
      elapsedMs: Date.now() - started,
      cached: false,
      warning: null,
      browserFallback: false
    };
    cacheSet(cacheKey, value);
    return value;
  }

  const htmlResult = await fetchBounded(targetUrl, { kind: "html" });
  let metadata = htmlResult.ok
    ? extractHtmlMetadata(htmlResult.text, htmlResult.finalUrl || targetUrl)
    : {
        title: providerMetadata?.title || null,
        description: providerMetadata?.description || null,
        image: null,
        images: providerMetadata?.images || [],
        provider: providerMetadata?.provider || provider?.name || null,
        durationSeconds: providerMetadata?.durationSeconds || null,
        oembedUrl: null
      };

  metadata = mergeMetadata(metadata, providerMetadata, htmlResult.finalUrl || targetUrl);
  let usedBrowserFallback = false;
  let browserError = null;

  // 401/403/405 commonly mean "real browser required" rather than "URL is invalid".
  // Also use the browser when plain HTML succeeded but exposed no usable thumbnail.
  const needsBrowserFallback =
    [401, 403, 405].includes(htmlResult.status) ||
    (htmlResult.ok && !metadata.image && !metadata.oembedUrl);
  const shouldTryBrowser = allowBrowserFallback && needsBrowserFallback;

  if (shouldTryBrowser) {
    const browser = await renderMetadataWithEdge(targetUrl);
    if (browser.ok) {
      usedBrowserFallback = true;
      metadata = mergeMetadata(browser.metadata, metadata, targetUrl);
    } else {
      browserError = browser.error || "edge_fallback_failed";
    }
  }

  // Respect explicit upstream throttling; do not try to bulldoze through 429/503.
  if (!htmlResult.ok && [429, 503].includes(htmlResult.status) && !metadata.image) {
    const error = new Error(htmlResult.error || `upstream_status_${htmlResult.status}`);
    error.status = htmlResult.status;
    throw error;
  }

  if (!metadata.image && metadata.oembedUrl) {
    const discovered = await fetchOEmbed(metadata.oembedUrl, targetUrl, metadata.provider);
    if (discovered) metadata = mergeMetadata(discovered, metadata, targetUrl);
  }

  const images = uniqueUrls([metadata.images, metadata.image], targetUrl);
  const warning = !htmlResult.ok
    ? htmlResult.error || `upstream_status_${htmlResult.status}`
    : browserError && !images.length
      ? browserError
      : null;

  const value = {
    url: targetUrl,
    title: metadata.title,
    description: metadata.description,
    image: images[0] || null,
    images,
    provider: metadata.provider || provider?.name || null,
    durationSeconds: metadata.durationSeconds,
    method: usedBrowserFallback
      ? images.length
        ? "edge-rendered-metadata"
        : "edge-no-thumbnail"
      : images.length
        ? "video-metadata"
        : htmlResult.ok
          ? "metadata-no-thumbnail"
          : "blocked-no-thumbnail",
    upstreamStatus: htmlResult.status || providerMetadata?.upstreamStatus || null,
    bytesRead: (htmlResult.bytes || 0) + (providerMetadata?.bytesRead || 0),
    elapsedMs: Date.now() - started,
    cached: false,
    warning,
    browserFallback: usedBrowserFallback,
    needsBrowserFallback: needsBrowserFallback && !usedBrowserFallback
  };

  if ((value.image || value.title) && !value.needsBrowserFallback) cacheSet(cacheKey, value);
  return value;
}


function alternateCacheGet(key) {
  const entry = alternateCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > ALTERNATE_CACHE_TTL_MS) {
    alternateCache.delete(key);
    return null;
  }
  alternateCache.delete(key);
  alternateCache.set(key, entry);
  return { ...entry.value, cached: true };
}

function alternateCacheSet(key, value) {
  alternateCache.set(key, { time: Date.now(), value });
  while (alternateCache.size > ALTERNATE_CACHE_MAX_ENTRIES) {
    alternateCache.delete(alternateCache.keys().next().value);
  }
}

function cleanSearchTitle(rawTitle) {
  return String(rawTitle || "")
    .replace(/\s*[|\-–—]\s*(?:youtube|vimeo|dailymotion|tiktok|streamable|reddit|x|twitter)\s*$/i, "")
    .replace(/\[(?:official\s*)?(?:video|clip|audio|hd|4k)\]/gi, " ")
    .replace(/\((?:official\s*)?(?:video|clip|audio|hd|4k)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TITLE_STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "video", "official", "watch", "clip", "hd", "4k", "short", "shorts"
]);

function titleTokens(value) {
  return cleanSearchTitle(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !TITLE_STOPWORDS.has(token));
}

function titleSimilarity(a, b) {
  const aTokens = titleTokens(a);
  const bTokens = titleTokens(b);
  if (!aTokens.length || !bTokens.length) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let intersection = 0;
  for (const token of aSet) if (bSet.has(token)) intersection += 1;
  const dice = (2 * intersection) / (aSet.size + bSet.size);
  const aFlat = aTokens.join(" ");
  const bFlat = bTokens.join(" ");
  const containment = aFlat.includes(bFlat) || bFlat.includes(aFlat) ? 0.12 : 0;
  return Math.min(1, dice + containment);
}

function canonicalDiscoveryUrl(rawUrl) {
  try {
    const url = validateUrl(rawUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$|mc_|ref$|referrer$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function discoveryHost(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const VIDEO_DISCOVERY_HOSTS = [
  "youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "dai.ly", "tiktok.com", "streamable.com", "loom.com",
  "x.com", "twitter.com", "reddit.com", "rumble.com", "bitchute.com", "odysee.com", "archive.org", "twitch.tv",
  "facebook.com", "fb.watch", "instagram.com", "vk.com", "ok.ru", "kick.com"
];

function isLikelyVideoResult(rawUrl, resultTitle = "", sourceHost = "") {
  let url;
  try {
    url = validateUrl(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === sourceHost) return true;
  if (VIDEO_DISCOVERY_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;
  if (knownProvider(url.toString())) return true;
  if (/\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i.test(url.pathname)) return true;
  if (/(?:^|\/)(?:watch|video|videos|clip|clips|shorts|reel|reels|embed|v)(?:\/|$)/i.test(url.pathname)) return true;
  return /\b(?:video|watch|full|clip|mirror|reupload|re-upload)\b/i.test(resultTitle);
}

function unwrapSearchResultHref(rawHref, baseUrl) {
  if (!rawHref) return null;
  try {
    const resolved = new URL(rawHref, baseUrl);
    const host = resolved.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
      const uddg = resolved.searchParams.get("uddg");
      if (uddg) return validateUrl(uddg).toString();
      return null;
    }
    if (host === "bing.com" || host.endsWith(".bing.com")) {
      // Bing sometimes wraps organic URLs in /ck/a links with a base64-encoded `u` value.
      if (resolved.pathname.startsWith("/ck/")) {
        const encoded = resolved.searchParams.get("u");
        if (encoded) {
          try {
            const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
            const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
            const decoded = Buffer.from(padded, "base64").toString("utf8");
            if (/^https?:\/\//i.test(decoded)) return validateUrl(decoded).toString();
          } catch {
            return null;
          }
        }
        return null;
      }
      // Organic Bing links are often direct. Ignore internal navigation links.
      if (resolved.pathname.startsWith("/search") || resolved.pathname.startsWith("/images")) return null;
    }
    return validateUrl(resolved.toString()).toString();
  } catch {
    return null;
  }
}

function parseDuckDuckGoResults(html, sourceHost) {
  const $ = cheerio.load(html || "");
  const results = [];
  const seen = new Set();
  $(".result").each((_, element) => {
    const anchor = $(element).find("a.result__a").first();
    const url = unwrapSearchResultHref(anchor.attr("href"), "https://html.duckduckgo.com/html/");
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const snippet = $(element).find(".result__snippet").first().text().replace(/\s+/g, " ").trim();
    if (!url || !isLikelyVideoResult(url, title, sourceHost)) return;
    const key = canonicalDiscoveryUrl(url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ url, searchTitle: title || null, snippet: snippet || null, engine: "DuckDuckGo" });
  });
  return results;
}

function parseBingResults(html, sourceHost) {
  const $ = cheerio.load(html || "");
  const results = [];
  const seen = new Set();
  $("li.b_algo").each((_, element) => {
    const anchor = $(element).find("h2 a").first();
    const url = unwrapSearchResultHref(anchor.attr("href"), "https://www.bing.com/search");
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const snippet = $(element).find(".b_caption p").first().text().replace(/\s+/g, " ").trim();
    if (!url || !isLikelyVideoResult(url, title, sourceHost)) return;
    const key = canonicalDiscoveryUrl(url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ url, searchTitle: title || null, snippet: snippet || null, engine: "Bing" });
  });
  return results;
}

async function searchDuckDuckGo(query, sourceHost) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
  const response = await fetchBounded(url, {
    kind: "search",
    timeoutMs: ALTERNATE_SEARCH_TIMEOUT_MS,
    retries: 1,
    headers: { Referer: "https://duckduckgo.com/" }
  });
  if (!response.ok) return { ok: false, status: response.status, results: [], error: response.error || `search_status_${response.status}` };
  return { ok: true, status: response.status, results: parseDuckDuckGoResults(response.text, sourceHost) };
}

async function searchBing(query, sourceHost) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&setlang=en-US`;
  const response = await fetchBounded(url, { kind: "search", timeoutMs: ALTERNATE_SEARCH_TIMEOUT_MS, retries: 1 });
  if (!response.ok) return { ok: false, status: response.status, results: [], error: response.error || `search_status_${response.status}` };
  return { ok: true, status: response.status, results: parseBingResults(response.text, sourceHost) };
}

async function runLimited(items, concurrency, worker) {
  let nextIndex = 0;
  const output = new Array(items.length);
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        output[index] = await worker(items[index], index);
      }
    })
  );
  return output;
}

function classifyAlternate(source, candidate, similarity) {
  const sourceDuration = Number(source.durationSeconds) || 0;
  const candidateDuration = Number(candidate.durationSeconds) || 0;
  const sourceHost = discoveryHost(source.url);
  const candidateHost = discoveryHost(candidate.url);
  const differentSource = Boolean(sourceHost && candidateHost && sourceHost !== candidateHost);
  let durationRatio = null;
  if (sourceDuration > 0 && candidateDuration > 0) durationRatio = candidateDuration / sourceDuration;

  const longerWords = /\b(?:full|complete|extended|uncut|full[- ]?length|long(?:er)? version)\b/i;
  const candidateLongerHint = longerWords.test(candidate.title || "");
  const sourceAlreadyLongHint = longerWords.test(source.title || "");
  const lexicalLongerHint = candidateLongerHint && !sourceAlreadyLongHint;

  let confidence = similarity * 70;
  if (differentSource) confidence += 9;
  if (durationRatio !== null) {
    if (durationRatio >= 1.15 && similarity >= 0.34) confidence += 16;
    else if (durationRatio >= 0.9 && durationRatio <= 1.1) confidence += 12;
    else if (durationRatio >= 0.65 && durationRatio <= 1.35) confidence += 5;
  } else if (lexicalLongerHint && similarity >= 0.34) {
    confidence += 7;
  }
  if (candidate.provider || knownProvider(candidate.url)) confidence += 3;
  confidence = Math.max(0, Math.min(98, Math.round(confidence)));

  let relation = "Possible match";
  if (durationRatio !== null && durationRatio >= 1.15 && similarity >= 0.34) relation = "Likely longer";
  else if (durationRatio === null && lexicalLongerHint && similarity >= 0.34) relation = "Possible longer";
  else if (similarity >= 0.62 && (durationRatio === null || (durationRatio >= 0.88 && durationRatio <= 1.12))) relation = "Likely mirror";
  else if (similarity < 0.34) relation = "Weak match";

  return { relation, confidence, durationRatio, differentSource, lexicalLongerHint };
}

async function findAlternates({ url, title, description, provider, durationSeconds }) {
  const sourceUrl = validateUrl(url).toString();
  let source = {
    url: sourceUrl,
    title: cleanSearchTitle(title),
    description: description || null,
    provider: provider || null,
    durationSeconds: Number(durationSeconds) || null
  };

  if (!source.title) {
    const preview = await createPreview(sourceUrl, { allowBrowserFallback: true });
    source = {
      ...source,
      title: cleanSearchTitle(preview.title),
      description: source.description || preview.description || null,
      provider: source.provider || preview.provider || null,
      durationSeconds: source.durationSeconds || preview.durationSeconds || null
    };
  }

  if (!source.title && source.description) {
    source.title = cleanSearchTitle(String(source.description).split(/[.!?]/)[0].slice(0, 140));
  }

  if (!source.title || titleTokens(source.title).length < 2) {
    const error = new Error("not_enough_title_metadata_for_search");
    error.status = 422;
    throw error;
  }

  const cacheKey = `${canonicalDiscoveryUrl(sourceUrl)}|${source.title}|${source.durationSeconds || 0}`;
  const cached = alternateCacheGet(cacheKey);
  if (cached) return cached;

  const escapedTitle = source.title.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  const queries = [
    `"${escapedTitle}" video`,
    `"${escapedTitle}" full complete extended video`
  ];
  const sourceHost = discoveryHost(sourceUrl);
  const gathered = [];
  const gatheredKeys = new Set([canonicalDiscoveryUrl(sourceUrl).toLowerCase()]);
  const searchDiagnostics = [];

  for (const query of queries) {
    const result = await searchDuckDuckGo(query, sourceHost);
    searchDiagnostics.push({ engine: "DuckDuckGo", query, status: result.status || 0, error: result.error || null, found: result.results.length });
    for (const item of result.results) {
      const key = canonicalDiscoveryUrl(item.url).toLowerCase();
      if (gatheredKeys.has(key)) continue;
      gatheredKeys.add(key);
      gathered.push(item);
    }
    if (gathered.length >= ALTERNATE_CANDIDATE_PREVIEW_LIMIT * 2) break;
  }

  // DuckDuckGo's HTML endpoint is convenient but can occasionally challenge automated clients.
  // Use one Bing request only when the primary search produced too little to evaluate.
  if (gathered.length < 4) {
    const query = queries[0];
    const result = await searchBing(query, sourceHost);
    searchDiagnostics.push({ engine: "Bing", query, status: result.status || 0, error: result.error || null, found: result.results.length });
    for (const item of result.results) {
      const key = canonicalDiscoveryUrl(item.url).toLowerCase();
      if (gatheredKeys.has(key)) continue;
      gatheredKeys.add(key);
      gathered.push(item);
    }
  }

  // Search-title similarity is cheap; use it to choose which URLs deserve metadata calls.
  const prioritized = gathered
    .map((item) => ({ ...item, searchSimilarity: titleSimilarity(source.title, item.searchTitle || "") }))
    .sort((a, b) => b.searchSimilarity - a.searchSimilarity)
    .slice(0, ALTERNATE_CANDIDATE_PREVIEW_LIMIT);

  const candidates = await runLimited(prioritized, ALTERNATE_CANDIDATE_CONCURRENCY, async (item) => {
    let preview = null;
    let previewError = null;
    try {
      preview = await createPreview(item.url, { allowBrowserFallback: false });
    } catch (error) {
      previewError = error?.message || "candidate_preview_failed";
    }

    const candidate = {
      url: item.url,
      title: cleanSearchTitle(preview?.title || item.searchTitle) || item.searchTitle || item.url,
      description: preview?.description || item.snippet || null,
      provider: preview?.provider || null,
      durationSeconds: preview?.durationSeconds || null,
      image: preview?.image || null,
      images: preview?.images || [],
      method: preview?.method || "search-result",
      previewError,
      searchEngine: item.engine
    };
    const similarity = Math.max(item.searchSimilarity, titleSimilarity(source.title, candidate.title));
    const classification = classifyAlternate(source, candidate, similarity);
    return { ...candidate, similarity, ...classification };
  });

  const results = candidates
    .filter(Boolean)
    .filter((candidate) => canonicalDiscoveryUrl(candidate.url).toLowerCase() !== canonicalDiscoveryUrl(sourceUrl).toLowerCase())
    .filter((candidate) => candidate.confidence >= 24)
    .sort((a, b) => {
      const relationRank = (value) => value === "Likely longer" ? 4 : value === "Possible longer" ? 3 : value === "Likely mirror" ? 2 : value === "Possible match" ? 1 : 0;
      return relationRank(b.relation) - relationRank(a.relation) || b.confidence - a.confidence || (b.durationSeconds || 0) - (a.durationSeconds || 0);
    })
    .slice(0, ALTERNATE_SEARCH_MAX_RESULTS);

  const value = {
    source,
    results,
    queries,
    searchDiagnostics,
    candidateCount: gathered.length,
    evaluatedCount: prioritized.length,
    manualSearchUrl: `https://duckduckgo.com/?q=${encodeURIComponent(`"${escapedTitle}" video full complete extended`)}`,
    cached: false,
    note: "Matches are inferred from public search results, metadata, title similarity, duration, and source diversity; video identity is not fingerprint-verified."
  };
  alternateCacheSet(cacheKey, value);
  return value;
}

function originReferer(rawUrl) {
  try {
    const url = validateUrl(rawUrl);
    return `${url.protocol}//${url.host}/`;
  } catch {
    return null;
  }
}

function sniffImageContentType(buffer, declaredType = "") {
  const declared = String(declaredType || "").split(";")[0].trim().toLowerCase();
  if (declared.startsWith("image/")) return declared;
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const box = buffer.subarray(4, 12).toString("ascii");
  if (box.includes("ftypavif") || box.includes("ftypavis")) return "image/avif";
  return null;
}

async function fetchImageWithStrategies(imageUrl, sourceUrl = null) {
  const imageOrigin = originReferer(imageUrl);
  const sourceOrigin = sourceUrl ? originReferer(sourceUrl) : null;
  const strategies = [];

  if (sourceUrl) {
    strategies.push({
      name: "source-page",
      headers: {
        Referer: sourceUrl,
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site"
      }
    });
  }
  if (sourceOrigin && sourceOrigin !== sourceUrl) strategies.push({ name: "source-origin", headers: { Referer: sourceOrigin } });
  if (imageOrigin) strategies.push({ name: "image-origin", headers: { Referer: imageOrigin } });
  strategies.push({ name: "no-referrer", headers: {} });

  let lastResult = null;
  for (const strategy of strategies) {
    const result = await fetchBounded(imageUrl, {
      kind: "image",
      timeoutMs: 10_000,
      retries: 0,
      headers: strategy.headers
    });
    lastResult = { ...result, strategy: strategy.name };
    if (result.ok) return lastResult;
    // Alternate referrer strategies are specifically useful for hotlink 401/403.
    if (![401, 403].includes(result.status)) break;
  }
  return lastResult;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    version: "2.2",
    limits: {
      globalNetwork: GLOBAL_NETWORK_LIMIT,
      perHostNetwork: PER_HOST_NETWORK_LIMIT,
      imageNetwork: IMAGE_NETWORK_LIMIT,
      browserFallback: BROWSER_FALLBACK_LIMIT,
      browserProxyNetwork: BROWSER_PROXY_NETWORK_LIMIT,
      htmlBytes: HTML_LIMIT_BYTES,
      imageBytes: IMAGE_LIMIT_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: MAX_RETRIES
    },
    activeNetwork: globalNetwork.active,
    queuedNetwork: globalNetwork.waiters.length,
    activeImages: imageNetwork.active,
    queuedImages: imageNetwork.waiters.length,
    activeBrowserFallbacks: browserFallback.active,
    queuedBrowserFallbacks: browserFallback.waiters.length,
    activeBrowserProxyConnections: browserProxyNetwork.active,
    cachedPreviews: previewCache.size,
    cachedAlternateSearches: alternateCache.size
  });
});

async function previewHandler(req, res) {
  const targetUrl = req.method === "GET" ? req.query.url : req.body?.url;
  if (!targetUrl || typeof targetUrl !== "string") return res.status(400).json({ error: "missing_url" });

  try {
    const allowBrowserFallback =
      req.method === "POST" ? req.body?.allowBrowserFallback !== false : req.query.browser !== "0";
    const preview = await createPreview(targetUrl.trim(), { allowBrowserFallback });
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
    return res.status(clientError ? 400 : 502).json({ error: message, url: targetUrl });
  }
}

app.get("/api/image", async (req, res) => {
  const imageUrl = req.query.url;
  const sourceUrl = typeof req.query.source === "string" ? req.query.source : null;
  if (!imageUrl || typeof imageUrl !== "string") return res.status(400).send("missing_url");

  try {
    validateUrl(imageUrl);
    if (sourceUrl) validateUrl(sourceUrl);
    const result = await fetchImageWithStrategies(imageUrl, sourceUrl);
    if (!result?.ok) {
      res.setHeader("X-Preview-Image-Strategy", result?.strategy || "none");
      return res.status(502).send(result?.error || `upstream_image_status_${result?.status || 0}`);
    }
    if (result.truncated) return res.status(413).send("image_too_large");

    const contentType = sniffImageContentType(result.buffer, result.contentType);
    if (!contentType) return res.status(415).send("not_an_image");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=1800");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Preview-Image-Strategy", result.strategy || "unknown");
    return res.send(result.buffer);
  } catch (error) {
    return res.status(400).send(error?.message || "image_fetch_failed");
  }
});

app.post("/api/alternates", async (req, res) => {
  const sourceUrl = req.body?.url;
  if (!sourceUrl || typeof sourceUrl !== "string") return res.status(400).json({ error: "missing_url" });
  try {
    const result = await findAlternates({
      url: sourceUrl.trim(),
      title: req.body?.title,
      description: req.body?.description,
      provider: req.body?.provider,
      durationSeconds: req.body?.durationSeconds
    });
    return res.json(result);
  } catch (error) {
    const message = error?.message || "alternate_search_failed";
    const clientStatus = error?.status || ([
      "invalid_url",
      "unsupported_protocol",
      "url_credentials_not_allowed",
      "private_network_url_blocked",
      "private_network_dns_blocked",
      "not_enough_title_metadata_for_search"
    ].some((code) => message.includes(code)) ? 400 : 502);
    return res.status(clientStatus).json({ error: message, url: sourceUrl });
  }
});

app.get("/api/preview", previewHandler);
app.post("/api/preview", previewHandler);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Video preview engine v2.2 listening on http://127.0.0.1:${PORT}`);
  console.log(`Network limits: ${GLOBAL_NETWORK_LIMIT} global / ${PER_HOST_NETWORK_LIMIT} per host.`);
  console.log(`Edge fallback: ${BROWSER_FALLBACK_LIMIT} worker via safety proxy on 127.0.0.1:${browserProxy.port}.`);
});
