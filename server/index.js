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
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const PORT = 3000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";

// High-throughput but bounded defaults for hundreds of video links.
const GLOBAL_NETWORK_LIMIT = 16;
const PER_HOST_NETWORK_LIMIT = 4;
const REQUEST_TIMEOUT_MS = 9000;
const HTML_LIMIT_BYTES = 512 * 1024;
const MEDIA_DISCOVERY_HTML_LIMIT_BYTES = 1024 * 1024;
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
const ALTERNATE_SEARCH_MAX_RESULTS = 60;
const ALTERNATE_CANDIDATE_PREVIEW_LIMIT = 72;
const ALTERNATE_RAW_DISCOVERY_LIMIT = 1000;
const ALTERNATE_CANDIDATE_CONCURRENCY = 3;
const ALTERNATE_CACHE_TTL_MS = 10 * 60 * 1000;
const ALTERNATE_CACHE_MAX_ENTRIES = 100;
const ARCHIVE_LOOKUP_TIMEOUT_MS = 8000;
const ARCHIVE_CAPTURE_LIMIT = 3;
const HOST_DEAD_TTL_MS = 30 * 60 * 1000;
const HOST_ALIVE_TTL_MS = 5 * 60 * 1000;

// Browser fallback is deliberately much narrower than metadata fetching.
const BROWSER_FALLBACK_LIMIT = 1;
const BROWSER_PROXY_NETWORK_LIMIT = 8;
const BROWSER_FALLBACK_TIMEOUT_MS = 7_000;
const BROWSER_CHALLENGE_COOLDOWN_MS = 10 * 60 * 1000;
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
const frameCompare = new Semaphore(1);
const hostSemaphores = new Map();
const hostThrottleState = new Map();
const previewCache = new Map();
const alternateCache = new Map();
const browserChallengeHosts = new Map();
const authorizedBrowserProfiles = new Map();
const hostReachability = new Map();
const hostReachabilityChecks = new Map();
const hostFirstRequestFlights = new Map();

const DEFAULT_PRIVACY = Object.freeze({
  browserFallback: true,
  interactiveAuthorization: true,
  mediaTools: true,
  searchDuckDuckGo: true,
  searchBing: true,
  searchMojeek: true,
  searchBrave: true,
  archiveLookups: true,
  searchTitleUploader: true,
  searchMediaIds: true,
  searchDescription: true,
  searchTranscript: true,
  sampleComparison: true
});

function normalizePrivacy(value) {
  const input = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_PRIVACY).map(([key, defaultValue]) => [key, typeof input[key] === "boolean" ? input[key] : defaultValue])
  );
}


function reachabilityKey(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function reachabilityStateFor(rawUrl) {
  const key = reachabilityKey(rawUrl);
  if (!key) return null;
  const state = hostReachability.get(key);
  if (!state) return null;
  if (state.until <= Date.now()) { hostReachability.delete(key); return null; }
  return state;
}

function isNetworkUnavailableError(value) {
  const text = String(value || "").toLowerCase();
  return /(?:enotfound|eai_again|econnrefused|econnreset|enetunreach|ehostunreach|request_timeout|socket hang up|network timeout|tls|certificate|fetch failed)/.test(text);
}

async function confirmHostReachability(rawUrl, triggerResult = null) {
  const target = validateUrl(rawUrl);
  const key = reachabilityKey(target.toString());
  const existing = reachabilityStateFor(target.toString());
  if (existing) return existing;
  if (hostReachabilityChecks.has(key)) return await hostReachabilityChecks.get(key);

  const check = (async () => {
    const schemes = target.protocol === "https:" ? ["https:", "http:"] : ["http:", "https:"];
    const roots = [...new Set(schemes.map((scheme) => `${scheme}//${target.host}/`))];
    const attempts = [];
    for (const root of roots) {
      const result = await fetchBounded(root, { kind: "html", timeoutMs: 3500, retries: 0 });
      attempts.push({ url: root, status: result.status || 0, error: result.error || null });
      // Any HTTP response proves the host is reachable, even 401/403/404/5xx.
      if (result.status > 0) {
        const state = { state: "alive", host: key, until: Date.now() + HOST_ALIVE_TTL_MS, attempts };
        hostReachability.set(key, state);
        return state;
      }
    }
    const triggerNetworkFailure = triggerResult?.status === 0 && isNetworkUnavailableError(triggerResult?.error);
    const allNetworkFailures = attempts.length > 0 && attempts.every((item) => item.status === 0 && isNetworkUnavailableError(item.error));
    const state = (triggerNetworkFailure || allNetworkFailures)
      ? { state: "dead", host: key, until: Date.now() + HOST_DEAD_TTL_MS, attempts, reason: triggerResult?.error || attempts[0]?.error || "host_unreachable" }
      : { state: "unknown", host: key, until: Date.now() + 60_000, attempts };
    if (state.state !== "unknown") hostReachability.set(key, state);
    return state;
  })().finally(() => hostReachabilityChecks.delete(key));

  hostReachabilityChecks.set(key, check);
  return await check;
}

async function fetchHostAwareInitialHtml(targetUrl) {
  const key = reachabilityKey(targetUrl);
  const known = reachabilityStateFor(targetUrl);
  if (known?.state === "dead") return { deadState: known, htmlResult: null };
  if (known?.state === "alive" || !key) {
    return { deadState: null, htmlResult: await fetchBounded(targetUrl, { kind: "html" }) };
  }

  // For a previously-unknown host, allow only one URL to establish whether the
  // site is reachable. Hundreds of sibling URLs then wait for that answer rather
  // than all creating DNS/TCP attempts against a dead domain at once.
  const existingFlight = hostFirstRequestFlights.get(key);
  if (existingFlight) {
    await existingFlight.catch(() => {});
    const after = reachabilityStateFor(targetUrl);
    if (after?.state === "dead") return { deadState: after, htmlResult: null };
    return { deadState: null, htmlResult: await fetchBounded(targetUrl, { kind: "html" }) };
  }

  let releaseFlight;
  const flight = new Promise((resolve) => { releaseFlight = resolve; });
  hostFirstRequestFlights.set(key, flight);
  try {
    const htmlResult = await fetchBounded(targetUrl, { kind: "html" });
    if (htmlResult.status > 0) {
      hostReachability.set(key, { state: "alive", host: key, until: Date.now() + HOST_ALIVE_TTL_MS, attempts: [{ url: targetUrl, status: htmlResult.status, error: null }] });
      return { deadState: null, htmlResult };
    }
    const reachability = await confirmHostReachability(targetUrl, htmlResult);
    if (reachability?.state === "dead") return { deadState: reachability, htmlResult };
    return { deadState: null, htmlResult };
  } finally {
    try { releaseFlight(); } catch {}
    hostFirstRequestFlights.delete(key);
  }
}

function deadHostPreview(targetUrl, started, state, { skipped = true } = {}) {
  return {
    url: targetUrl,
    title: null,
    description: null,
    image: null,
    images: [],
    provider: null,
    durationSeconds: null,
    method: skipped ? "dead-host-skipped" : "dead-host-confirmed",
    upstreamStatus: 0,
    bytesRead: 0,
    elapsedMs: Date.now() - started,
    cached: false,
    warning: "host_unreachable",
    error: null,
    deadLink: true,
    deadHost: true,
    hostSuppressed: skipped,
    deadReason: state?.reason || "host_unreachable",
    deadHostName: state?.host || reachabilityKey(targetUrl),
    siteSessionRecommended: false,
    browserFallback: false,
    browserFallbackAttempted: false,
    browserFallbackError: null,
    needsBrowserFallback: false,
    extractorStats: null,
    browserExtractorStats: null
  };
}

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
          kind === "json" ? JSON_LIMIT_BYTES :
          kind === "image" ? IMAGE_LIMIT_BYTES :
          kind === "media-page" ? MEDIA_DISCOVERY_HTML_LIMIT_BYTES : HTML_LIMIT_BYTES;
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

function decodeEmbeddedValue(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003[aA]/g, ":")
    .replace(/\\u003[dD]/g, "=")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .trim();
}

function collectJsonImageCandidates(value, out, depth = 0, videoContext = false) {
  if (!value || depth > 10 || out.length >= 80) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonImageCandidates(item, out, depth + 1, videoContext);
    return;
  }
  if (typeof value !== "object") return;

  const rawType = value["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  const isVideo = videoContext || types.some((entry) => String(entry || "").toLowerCase() === "videoobject");
  const strongKeys = new Set([
    "thumbnailurl", "thumbnail_url", "thumbnail", "thumbnailuri",
    "poster", "posterurl", "poster_url", "posterimage", "posterimageurl",
    "previewimage", "preview_image", "previewimageurl", "preview_image_url",
    "imageurl", "image_url"
  ]);

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
    const imageKey = strongKeys.has(normalized) || (isVideo && normalized === "image");
    if (imageKey) {
      if (typeof child === "string") out.push(decodeEmbeddedValue(child));
      else if (Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === "string") out.push(decodeEmbeddedValue(item));
          else if (item && typeof item === "object") {
            for (const candidateKey of ["url", "contentUrl", "src", "href"]) {
              if (typeof item[candidateKey] === "string") out.push(decodeEmbeddedValue(item[candidateKey]));
            }
          }
        }
      } else if (child && typeof child === "object") {
        for (const candidateKey of ["url", "contentUrl", "src", "href"]) {
          if (typeof child[candidateKey] === "string") out.push(decodeEmbeddedValue(child[candidateKey]));
        }
      }
    }
    collectJsonImageCandidates(child, out, depth + 1, isVideo);
  }
}

function extractScriptImageCandidates($) {
  const results = [];
  const keyPattern = /["'](?:thumbnail(?:Url|_url)?|poster(?:Url|_url)?|posterImage(?:Url)?|preview(?:Image|_image)(?:Url|_url)?|imageUrl|image_url)["']\s*:\s*["']([^"'<>]{4,2048})["']/gi;

  $("script").each((_, element) => {
    if (results.length >= 80) return;
    const text = $(element).html() || $(element).text() || "";
    if (!text || text.length > 1_500_000) return;

    const type = String($(element).attr("type") || "").toLowerCase();
    const id = String($(element).attr("id") || "").toLowerCase();
    const looksJson = type.includes("json") || id.includes("next_data") || id.includes("initial") || id.includes("state");
    if (looksJson) {
      try {
        const parsed = JSON.parse(text.trim());
        collectJsonImageCandidates(parsed, results);
      } catch {
        // Many frameworks wrap state in JavaScript instead of pure JSON.
      }
    }

    let match;
    keyPattern.lastIndex = 0;
    while ((match = keyPattern.exec(text)) && results.length < 80) {
      results.push(decodeEmbeddedValue(match[1]));
    }
  });

  return results;
}

function extractDomImageCandidates($) {
  const scored = [];
  const seen = new Set();
  const add = (value, score, reason) => {
    if (!value || typeof value !== "string") return;
    const key = value.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    scored.push({ value: key, score, reason });
  };

  $("video[poster]").each((_, element) => add($(element).attr("poster"), 30, "video-poster"));

  $("img").slice(0, 400).each((_, element) => {
    const el = $(element);
    const attrs = ["src", "data-src", "data-lazy-src", "data-original", "data-image", "data-thumb", "data-thumbnail", "data-poster"];
    const haystack = [el.attr("id"), el.attr("class"), el.attr("alt")].filter(Boolean).join(" ").toLowerCase();
    const width = Number.parseInt(el.attr("width") || el.attr("data-width") || "", 10);
    const height = Number.parseInt(el.attr("height") || el.attr("data-height") || "", 10);

    for (const attr of attrs) {
      const value = el.attr(attr);
      if (!value) continue;
      const probe = `${haystack} ${value}`.toLowerCase();
      let score = 0;
      if (/poster|thumbnail|thumb|preview|video|player|cover|hero/.test(probe)) score += 10;
      if (/logo|icon|avatar|emoji|sprite|badge|favicon/.test(probe)) score -= 12;
      if (Number.isFinite(width) && Number.isFinite(height)) {
        if (width >= 300 && height >= 160) score += 5;
        if (width > height && width / Math.max(height, 1) >= 1.25) score += 2;
        if (width <= 96 || height <= 96) score -= 6;
      }
      if (/\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/i.test(value)) score += 1;
      if (score >= 1) add(value, score, attr);
    }
  });

  $("[style*='background']").slice(0, 250).each((_, element) => {
    const el = $(element);
    const hint = `${el.attr("id") || ""} ${el.attr("class") || ""}`.toLowerCase();
    if (!/poster|thumbnail|thumb|preview|video|player|cover|hero/.test(hint)) return;
    const style = el.attr("style") || "";
    const matches = style.matchAll(/background(?:-image)?\s*:\s*url\((['"]?)(.*?)\1\)/gi);
    for (const match of matches) add(match[2], 8, "background");
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 24).map((entry) => entry.value);
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
    if (!text || text.length > 1_000_000) return;
    try {
      const parsed = JSON.parse(text);
      if (!videoObject) videoObject = findVideoObject(parsed);
      collectJsonImageCandidates(parsed, jsonImages);
      const found = findVideoObject(parsed);
      const thumbs = found?.thumbnailUrl;
      if (Array.isArray(thumbs)) jsonImages.push(...thumbs);
      else if (typeof thumbs === "string") jsonImages.push(thumbs);
      if (typeof found?.image === "string") jsonImages.push(found.image);
    } catch {
      // Invalid JSON-LD is common.
    }
  });

  const metaImages = [
    ...metas('meta[property="og:image:secure_url"]'),
    ...metas('meta[property="og:image"]'),
    ...metas('meta[property="og:image:url"]'),
    ...metas('meta[name="twitter:image"]'),
    ...metas('meta[name="twitter:image:src"]'),
    ...metas('meta[property="twitter:image"]'),
    ...metas('meta[itemprop="thumbnailUrl"]'),
    ...metas('meta[name="thumbnail"]'),
    ...metas('meta[name="thumbnail_url"]')
  ];
  const posterImages = $("video[poster]")
    .map((_, element) => $(element).attr("poster"))
    .get()
    .filter(Boolean);
  const scriptImages = extractScriptImageCandidates($);
  const domImages = extractDomImageCandidates($);
  const imageSrcLinks = $('link[rel="image_src"], link[rel="preload"][as="image"]')
    .map((_, element) => $(element).attr("href"))
    .get()
    .filter(Boolean);

  const images = uniqueUrls(
    [metaImages, jsonImages, posterImages, scriptImages, domImages, imageSrcLinks],
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
    oembedUrl: resolveUrl(oembedLink, pageUrl),
    extractorStats: {
      meta: uniqueUrls(metaImages, pageUrl).length,
      json: uniqueUrls(jsonImages, pageUrl).length,
      script: uniqueUrls(scriptImages, pageUrl).length,
      poster: uniqueUrls(posterImages, pageUrl).length,
      dom: uniqueUrls(domImages, pageUrl).length,
      total: images.length
    }
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

function detectChallengePage(html = "", status = null) {
  const text = String(html || "");
  if (!text) return null;
  const lower = text.toLowerCase();
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const titleLower = title.toLowerCase();
  const strongTitle = [
    "just a moment",
    "attention required",
    "verify you are human",
    "checking your browser",
    "security check"
  ].some((needle) => titleLower.includes(needle));
  const strongBody = [
    "cf-chl-",
    "challenge-platform",
    "cf-turnstile",
    "enable javascript and cookies to continue",
    "checking if the site connection is secure",
    "performing security verification",
    "verify you are human"
  ].some((needle) => lower.includes(needle));
  const accessDenied = titleLower.includes("access denied") && Number(status) >= 400;
  if (!strongTitle && !strongBody && !accessDenied) return null;
  return {
    title: title || null,
    provider: lower.includes("cloudflare") || lower.includes("cf-chl-") ? "cloudflare" : null
  };
}

function challengeCircuitFor(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    const until = browserChallengeHosts.get(host) || 0;
    if (until <= Date.now()) { browserChallengeHosts.delete(host); return null; }
    return { host, until };
  } catch { return null; }
}

function markChallengeCircuit(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    browserChallengeHosts.set(host, Date.now() + BROWSER_CHALLENGE_COOLDOWN_MS);
  } catch {}
}

function authorizationHost(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

function authorizationEntryFor(rawUrl) {
  const host = authorizationHost(rawUrl);
  return host ? authorizedBrowserProfiles.get(host) || null : null;
}

function authorizationProfileFor(rawUrl) {
  const entry = authorizationEntryFor(rawUrl);
  return entry?.status === "ready" ? entry.path : null;
}

function authorizationLiveSessionFor(rawUrl) {
  const entry = authorizationEntryFor(rawUrl);
  return entry?.status === "authorizing" && Number.isInteger(entry.debugPort)
    ? { path: entry.path, debugPort: entry.debugPort }
    : null;
}

async function reserveLocalPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function ensureAuthorizationProfile(rawUrl) {
  const host = authorizationHost(rawUrl);
  if (!host) throw new Error("invalid_url");
  const existing = authorizedBrowserProfiles.get(host);
  if (existing) return existing;
  const safeHost = host.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);
  const root = path.join(os.tmpdir(), "link-preview-authorized-edge");
  await fs.mkdir(root, { recursive: true });
  const profile = path.join(root, safeHost);
  await fs.mkdir(profile, { recursive: true });
  const entry = { path: profile, status: "idle", startedAt: null, finishedAt: null, debugPort: null };
  authorizedBrowserProfiles.set(host, entry);
  return entry;
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

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const EDGE_HELPER_PATH = path.join(SERVER_DIR, "edge-fallback.js");
const EDGE_AUTH_HELPER_PATH = path.join(SERVER_DIR, "edge-authorize.js");
const EDGE_SESSION_HELPER_PATH = path.join(SERVER_DIR, "edge-session-probe.js");
const FRAME_COMPARE_HELPER_PATH = path.join(SERVER_DIR, "media-frame-compare.js");

async function renderMetadataFromAuthorizedSession(targetUrl, debugPort) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--experimental-websocket",
      EDGE_SESSION_HELPER_PATH,
      targetUrl,
      String(debugPort),
      String(BROWSER_DOM_LIMIT_BYTES)
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: "authorized_session_probe_timeout" });
    }, 9000);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > BROWSER_DOM_LIMIT_BYTES * 2 + 256 * 1024) {
        try { child.kill(); } catch {}
        finish({ ok: false, error: "authorized_session_output_too_large" });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errBytes >= 24 * 1024) return;
      const remaining = 24 * 1024 - errBytes;
      const used = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      errBytes += used.length;
      stderr.push(used);
    });
    child.once("error", (error) => finish({ ok: false, error: error?.message || "authorized_session_probe_launch_failed" }));
    child.once("close", () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8") || "{}");
        if (!parsed.ok) {
          finish({ ok: false, error: parsed.error || "authorized_session_probe_failed", diagnostic: Buffer.concat(stderr).toString("utf8").slice(0, 1000) });
          return;
        }
        const html = String(parsed.html || "");
        const challenge = detectChallengePage(html);
        if (challenge) {
          finish({ ok: false, error: "authorized_session_challenge_page", challenge: true, challengeProvider: challenge.provider, challengeTitle: challenge.title });
          return;
        }
        const pageUrl = parsed.pageUrl || targetUrl;
        finish({
          ok: true,
          metadata: extractHtmlMetadata(html, pageUrl),
          mediaSignals: extractMediaDiscoverySignals(html, pageUrl),
          bytes: Buffer.byteLength(html),
          liveAuthorizedSession: true,
          pageUrl,
          diagnostic: parsed.title ? `authorized site session: ${parsed.title}` : null
        });
      } catch {
        finish({ ok: false, error: "authorized_session_invalid_output", diagnostic: Buffer.concat(stderr).toString("utf8").slice(0, 1000) });
      }
    });
  });
}

async function renderMetadataWithEdge(targetUrl) {
  const authProfile = authorizationProfileFor(targetUrl);
  const liveSession = authorizationLiveSessionFor(targetUrl);
  const openCircuit = challengeCircuitFor(targetUrl);
  if (openCircuit && !authProfile && !liveSession) {
    return { ok: false, error: "edge_challenge_circuit_open", challenge: true };
  }

  const release = await browserFallback.acquire();
  try {
    const activeLiveSession = authorizationLiveSessionFor(targetUrl);
    if (activeLiveSession) {
      const liveResult = await renderMetadataFromAuthorizedSession(targetUrl, activeLiveSession.debugPort);
      if (liveResult.ok || liveResult.challenge) return liveResult;
      // Do not start another Edge instance with the same profile while the visible
      // authorization window owns it. Return a useful transient error instead.
      return liveResult;
    }

    const activeProfile = authorizationProfileFor(targetUrl);
    const recheckCircuit = challengeCircuitFor(targetUrl);
    if (recheckCircuit && !activeProfile) {
      return { ok: false, error: "edge_challenge_circuit_open", challenge: true };
    }
    const helperResult = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          EDGE_HELPER_PATH,
          targetUrl,
          String(BROWSER_FALLBACK_TIMEOUT_MS),
          String(BROWSER_PROXY_NETWORK_LIMIT),
          String(PER_HOST_NETWORK_LIMIT),
          String(BROWSER_DOM_LIMIT_BYTES),
          activeProfile || ""
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );

      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      // Parent timeout is intentionally longer than the helper's own Edge timeout.
      // If the entire helper wedges, terminate it without risking the main API process.
      const terminateHelperTree = () => {
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore"
          });
          killer.on("error", () => child.kill());
        } else {
          child.kill();
        }
      };

      const timer = setTimeout(() => {
        terminateHelperTree();
        finish({ ok: false, error: "edge_helper_timeout" });
      }, BROWSER_FALLBACK_TIMEOUT_MS + 8000);

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > BROWSER_DOM_LIMIT_BYTES * 2 + 512 * 1024) {
          terminateHelperTree();
          finish({ ok: false, error: "edge_helper_output_too_large" });
          return;
        }
        stdout.push(chunk);
      });

      child.stderr.on("data", (chunk) => {
        if (stderrBytes >= 32 * 1024) return;
        const remaining = 32 * 1024 - stderrBytes;
        const used = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        stderrBytes += used.length;
        stderr.push(used);
      });

      child.once("error", (error) => {
        finish({ ok: false, error: error?.message || "edge_helper_launch_failed" });
      });

      child.once("close", (code) => {
        if (settled) return;
        const text = Buffer.concat(stdout).toString("utf8").trim();
        try {
          const parsed = JSON.parse(text || "{}");
          if (!parsed.ok) {
            finish({
              ok: false,
              error: parsed.error || `edge_helper_exit_${code ?? "unknown"}`,
              diagnostic: parsed.diagnostic || Buffer.concat(stderr).toString("utf8").slice(0, 1000),
              challenge: Boolean(parsed.challenge),
              challengeTitle: parsed.challengeTitle || null,
              challengeProvider: parsed.challengeProvider || null
            });
            return;
          }
          finish(parsed);
        } catch {
          finish({
            ok: false,
            error: `edge_helper_invalid_output_${code ?? "unknown"}`,
            diagnostic: `${text.slice(0, 500)} ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`.trim()
          });
        }
      });
    });

    if (!helperResult.ok) {
      if (helperResult.challenge) markChallengeCircuit(targetUrl);
      return helperResult;
    }
    const html = String(helperResult.html || "");
    if (!html.trim()) return { ok: false, error: "edge_empty_dom" };
    const metadata = extractHtmlMetadata(html, targetUrl);
    return {
      ok: true,
      metadata,
      mediaSignals: extractMediaDiscoverySignals(html, targetUrl),
      bytes: Buffer.byteLength(html),
      diagnostic: helperResult.diagnostic || null
    };
  } finally {
    release();
  }
}

async function createPreview(rawUrl, { allowBrowserFallback = true } = {}) {
  const started = Date.now();
  const targetUrl = validateUrl(rawUrl).toString();
  const cacheKey = normalizeCacheKey(targetUrl);
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, elapsedMs: Date.now() - started };

  const knownReachability = reachabilityStateFor(targetUrl);
  if (knownReachability?.state === "dead") return deadHostPreview(targetUrl, started, knownReachability, { skipped: true });

  const provider = knownProvider(targetUrl);
  const derivedImages = providerDerivedImages(targetUrl);
  let providerMetadata = null;

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
        browserFallback: false,
        browserFallbackAttempted: false,
        browserFallbackError: null,
        needsBrowserFallback: false,
        extractorStats: null,
        browserExtractorStats: null
      };
      cacheSet(cacheKey, value);
      return value;
    }
  }

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
      browserFallback: false,
      browserFallbackAttempted: false,
      browserFallbackError: null,
      needsBrowserFallback: false,
      extractorStats: null,
      browserExtractorStats: null
    };
    cacheSet(cacheKey, value);
    return value;
  }

  const initialHostFetch = await fetchHostAwareInitialHtml(targetUrl);
  if (initialHostFetch.deadState) {
    return deadHostPreview(targetUrl, started, initialHostFetch.deadState, { skipped: !initialHostFetch.htmlResult });
  }
  const htmlResult = initialHostFetch.htmlResult;
  const httpChallenge = detectChallengePage(htmlResult.text, htmlResult.status);
  if (httpChallenge) markChallengeCircuit(targetUrl);
  const httpMetadata = htmlResult.ok && !httpChallenge
    ? extractHtmlMetadata(htmlResult.text, htmlResult.finalUrl || targetUrl)
    : null;
  let metadata = httpMetadata || {
    title: providerMetadata?.title || null,
    description: providerMetadata?.description || null,
    image: null,
    images: providerMetadata?.images || [],
    provider: providerMetadata?.provider || provider?.name || null,
    durationSeconds: providerMetadata?.durationSeconds || null,
    oembedUrl: null,
    extractorStats: null
  };

  metadata = mergeMetadata(metadata, providerMetadata, htmlResult.finalUrl || targetUrl);
  let discoveredOembedAttempted = false;

  // Discovery order matters: try an advertised oEmbed endpoint first, then decide
  // whether a real browser is required. v2.2.1 incorrectly treated the mere
  // presence of an oEmbed link as proof that browser fallback was unnecessary.
  if (!metadata.image && httpMetadata?.oembedUrl) {
    discoveredOembedAttempted = true;
    const discovered = await fetchOEmbed(httpMetadata.oembedUrl, targetUrl, metadata.provider);
    if (discovered) metadata = mergeMetadata(discovered, metadata, targetUrl);
  }

  let usedBrowserFallback = false;
  let browserFallbackAttempted = false;
  let browserError = null;
  let browserDiagnostic = null;
  let browserExtractorStats = null;
  let browserChallenge = false;

  const restrictedStatus = [401, 403, 405, 406, 418].includes(htmlResult.status);
  const authorizedProfile = authorizationProfileFor(targetUrl);
  const authorizedLiveSession = authorizationLiveSessionFor(targetUrl);
  const hasAuthorizedSession = Boolean(authorizedProfile || authorizedLiveSession);
  const needsBrowserFallback = Boolean(
    (httpChallenge && hasAuthorizedSession) ||
    (!httpChallenge && (restrictedStatus || (htmlResult.ok && !metadata.image)))
  );
  const shouldTryBrowser = allowBrowserFallback && needsBrowserFallback;

  if (shouldTryBrowser) {
    browserFallbackAttempted = true;
    const browser = await renderMetadataWithEdge(targetUrl);
    if (browser.ok) {
      usedBrowserFallback = true;
      browserExtractorStats = browser.metadata?.extractorStats || null;
      const browserOembedUrl = browser.metadata?.oembedUrl || null;
      metadata = mergeMetadata(browser.metadata, metadata, targetUrl);

      if (!metadata.image && browserOembedUrl && (!discoveredOembedAttempted || browserOembedUrl !== httpMetadata?.oembedUrl)) {
        const discovered = await fetchOEmbed(browserOembedUrl, targetUrl, metadata.provider);
        if (discovered) metadata = mergeMetadata(discovered, metadata, targetUrl);
      }
    } else {
      browserError = browser.error || "edge_fallback_failed";
      browserDiagnostic = browser.diagnostic || null;
      browserChallenge = Boolean(browser.challenge);
    }
  }

  if (!htmlResult.ok && [429, 503].includes(htmlResult.status) && !metadata.image) {
    const error = new Error(htmlResult.error || `upstream_status_${htmlResult.status}`);
    error.status = htmlResult.status;
    throw error;
  }

  const images = uniqueUrls([metadata.images, metadata.image], targetUrl);
  const warning = httpChallenge && !usedBrowserFallback
    ? "challenge_page_detected"
    : !htmlResult.ok
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
    authorizedBrowserProfile: Boolean(authorizedProfile),
    authorizedBrowserSession: Boolean(authorizedLiveSession),
    browserFallback: usedBrowserFallback,
    browserFallbackAttempted,
    browserFallbackError: browserError,
    browserFallbackDiagnostic: browserDiagnostic,
    challengeDetected: Boolean((httpChallenge && !usedBrowserFallback) || browserChallenge),
    challengeProvider: httpChallenge?.provider || null,
    browserFallbackSkippedReason: httpChallenge && !hasAuthorizedSession ? "challenge_page_detected" : null,
    // Some video hosts do not present an anti-bot challenge at all. Instead, the
    // real player/thumbnail is hidden behind an interactive consent, age, cookie,
    // or "accept" overlay. A headless timeout/no-thumbnail is therefore also a
    // valid reason to offer the reusable visible Sandbox site session.
    siteSessionRecommended: Boolean(
      !images.length && (
        httpChallenge ||
        browserChallenge ||
        needsBrowserFallback ||
        (browserFallbackAttempted && browserError)
      )
    ),
    needsBrowserFallback: needsBrowserFallback && !allowBrowserFallback,
    extractorStats: httpMetadata?.extractorStats || null,
    browserExtractorStats,
    deadLink: Boolean([404, 410].includes(htmlResult.status)),
    deadHost: false,
    hostSuppressed: false,
    deadReason: [404, 410].includes(htmlResult.status) ? `url_gone_${htmlResult.status}` : null,
    deadHostName: null
  };

  if ((value.image || value.title) && !value.needsBrowserFallback && !value.deadLink) cacheSet(cacheKey, value);
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

const PHRASE_STOPWORDS = new Set([
  ...TITLE_STOPWORDS, "this", "that", "these", "those", "you", "your", "we", "our", "they", "their", "was", "were", "will",
  "have", "has", "had", "not", "but", "can", "could", "would", "should", "about", "into", "over", "after", "before", "when",
  "where", "what", "who", "how"
]);

function titleTokens(value) {
  return cleanSearchTitle(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
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
      if (resolved.pathname.startsWith("/search") || resolved.pathname.startsWith("/images")) return null;
    }
    return validateUrl(resolved.toString()).toString();
  } catch {
    return null;
  }
}

// Deliberately do not apply a video-host allowlist or a "looks like video" URL filter here.
// Mirrors can live on arbitrary public sites; relevance is established later from evidence.
function parseDuckDuckGoResults(html) {
  const $ = cheerio.load(html || "");
  const results = [];
  const seen = new Set();
  $(".result, .results_links, .web-result").each((_, element) => {
    const anchor = $(element).find("a.result__a, h2 a, a[data-testid='result-title-a']").first();
    const url = unwrapSearchResultHref(anchor.attr("href"), "https://html.duckduckgo.com/html/");
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const snippet = $(element).find(".result__snippet, .result-snippet, [data-result='snippet']").first().text().replace(/\s+/g, " ").trim();
    if (!url) return;
    const key = canonicalDiscoveryUrl(url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ url, searchTitle: title || null, snippet: snippet || null, engine: "DuckDuckGo" });
  });
  return results.slice(0, 30);
}

function parseBingResults(html) {
  const $ = cheerio.load(html || "");
  const results = [];
  const seen = new Set();
  $("li.b_algo, .b_algo").each((_, element) => {
    const anchor = $(element).find("h2 a").first();
    const url = unwrapSearchResultHref(anchor.attr("href"), "https://www.bing.com/search");
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const snippet = $(element).find(".b_caption p, .b_lineclamp2, .b_lineclamp3").first().text().replace(/\s+/g, " ").trim();
    if (!url) return;
    const key = canonicalDiscoveryUrl(url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ url, searchTitle: title || null, snippet: snippet || null, engine: "Bing" });
  });
  return results.slice(0, 30);
}

function parseMojeekResults(html) {
  const $ = cheerio.load(html || "");
  const results = [];
  const seen = new Set();
  // Mojeek's standard result layout: ul.results-standard > li, with h2/a title,
  // p.s snippet and (in newer layouts) a.ob carrying the result URL.
  $("ul.results-standard > li").each((_, element) => {
    const row = $(element);
    const anchor = row.find("h2 a").first();
    const outbound = row.find("a.ob").first();
    const rawHref = outbound.attr("href") || anchor.attr("href");
    let url;
    try {
      url = new URL(rawHref, "https://www.mojeek.com/search");
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "mojeek.com" || host.endsWith(".mojeek.com")) return;
      url = validateUrl(url.toString());
    } catch { return; }
    const key = canonicalDiscoveryUrl(url.toString()).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const snippet = row.find("p.s").first().text().replace(/\s+/g, " ").trim();
    results.push({ url: url.toString(), searchTitle: title || null, snippet: snippet || null, engine: "Mojeek" });
  });
  return results.slice(0, 30);
}

function urlDiscoveryClues(rawUrl) {
  try {
    const url = validateUrl(rawUrl);
    const decodedSegments = url.pathname.split("/").filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
    const generic = new Set(["video","videos","watch","view","embed","player","media","clip","clips","content","index","html","htm","php"]);
    const phrases = [];
    const ids = [];
    const filenames = [];
    for (const segment of decodedSegments) {
      const stem = segment.replace(/\.(?:html?|php|aspx?|mp4|m4v|mov|webm|mkv|m3u8|mpd)$/i, "");
      const phrase = stem.replace(/[._+~-]+/g, " ").replace(/\s+/g, " ").trim();
      if (phrase && phrase.length >= 3 && !generic.has(phrase.toLowerCase())) phrases.push(phrase);
      const id = signalIdCandidate(stem);
      if (id && !generic.has(id.toLowerCase())) ids.push(id);
      const fileStem = mediaFilenameStem(`${url.origin}/${segment}`);
      if (fileStem) filenames.push(fileStem);
    }
    for (const [key, value] of url.searchParams) {
      if (/^(?:title|name|video|video_id|videoid|media|media_id|mediaid|asset|asset_id|assetid|clip|clip_id|clipid|id|slug|file|filename)$/i.test(key)) {
        const decoded = String(value || "").replace(/[._+~-]+/g, " ").replace(/\s+/g, " ").trim();
        if (decoded.length >= 3) phrases.push(decoded);
        const id = signalIdCandidate(value);
        if (id) ids.push(id);
      }
    }
    const scored = [...new Set(phrases)].sort((a, b) => {
      const score = (v) => (/[\p{L}]/u.test(v) ? 20 : 0) + Math.min(v.length, 80) + (v.split(/\s+/).length >= 3 ? 20 : 0);
      return score(b) - score(a);
    });
    return {
      slugPhrase: scored[0] || null,
      phrases: scored.slice(0, 6),
      ids: [...new Set(ids)].slice(0, 16),
      filenames: [...new Set(filenames)].slice(0, 8),
      host: url.hostname.toLowerCase().replace(/^www\./, "")
    };
  } catch {
    return { slugPhrase: null, phrases: [], ids: [], filenames: [], host: "" };
  }
}

function unwrapArchivedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "web.archive.org") {
      const match = url.pathname.match(/^\/web\/[^/]+\/(https?:\/\/.*)$/i);
      if (match) return validateUrl(match[1] + url.search + url.hash).toString();
    }
    return validateUrl(url.toString()).toString();
  } catch { return null; }
}

function archiveOutgoingCandidates(html, pageUrl, sourceHost) {
  const $ = cheerio.load(html || "");
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || out.length >= 60) return;
    let resolved;
    try { resolved = new URL(value, pageUrl).toString(); } catch { return; }
    resolved = unwrapArchivedUrl(resolved) || resolveUrl(resolved, pageUrl);
    if (!resolved) return;
    try {
      const target = validateUrl(resolved);
      const host = target.hostname.toLowerCase().replace(/^www\./, "");
      if (!host || host === sourceHost || host === "web.archive.org" || host.endsWith(".archive.org") || host.endsWith(".commoncrawl.org")) return;
      const key = canonicalDiscoveryUrl(target.toString()).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key); out.push(target.toString());
    } catch {}
  };
  $("a[href],iframe[src],embed[src],video[src],source[src]").slice(0, 600).each((_, el) => add($(el).attr("href") || $(el).attr("src")));
  return out;
}

async function lookupWaybackSource(rawUrl) {
  const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(rawUrl)}&output=json&fl=timestamp,original,statuscode,mimetype,digest&filter=statuscode:200&filter=mimetype:text/html&collapse=digest&limit=-${ARCHIVE_CAPTURE_LIMIT}`;
  const index = await fetchBounded(cdx, { kind: "json", timeoutMs: ARCHIVE_LOOKUP_TIMEOUT_MS, retries: 1 });
  if (!index.ok || !index.text) return { ok: false, provider: "Wayback", error: index.error || `status_${index.status}`, captures: [] };
  let rows;
  try { rows = JSON.parse(index.text); } catch { return { ok: false, provider: "Wayback", error: "wayback_invalid_json", captures: [] }; }
  if (!Array.isArray(rows) || rows.length < 2) return { ok: false, provider: "Wayback", error: "wayback_no_capture", captures: [] };
  const headers = rows[0];
  const captures = rows.slice(1).map((row) => Object.fromEntries(headers.map((key, i) => [key, row[i]]))).reverse();
  for (const capture of captures) {
    const original = capture.original || rawUrl;
    const snapshotUrl = `https://web.archive.org/web/${capture.timestamp}id_/${original}`;
    const page = await fetchBounded(snapshotUrl, { kind: "media-page", timeoutMs: ARCHIVE_LOOKUP_TIMEOUT_MS, retries: 0 });
    if (!page.ok || !page.text) continue;
    const metadata = extractHtmlMetadata(page.text, original);
    const signals = extractMediaDiscoverySignals(page.text, original);
    const candidates = archiveOutgoingCandidates(page.text, original, discoveryHost(rawUrl));
    return { ok: true, provider: "Wayback", capture: capture.timestamp, snapshotUrl, metadata, signals, candidates };
  }
  return { ok: false, provider: "Wayback", error: "wayback_capture_fetch_failed", captures };
}

async function fetchRangeRecord(rawUrl, offset, length) {
  const url = validateUrl(rawUrl);
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0 || length > 4 * 1024 * 1024) throw new Error("archive_record_too_large");
  const hostname = url.hostname.toLowerCase();
  const releaseGlobal = await globalNetwork.acquire();
  const releaseHost = await getHostSemaphore(hostname).acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCHIVE_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET", redirect: "manual", signal: controller.signal, agent: agentFor,
      headers: browserLikeHeaders("json", { Range: `bytes=${offset}-${offset + length - 1}`, "Accept-Encoding": "identity" })
    });
    if (!(response.ok || response.status === 206)) return null;
    const body = await readLimitedBody(response.body, Math.min(length + 1024, 4 * 1024 * 1024), false);
    return body.buffer;
  } catch { return null; }
  finally { clearTimeout(timer); releaseHost(); releaseGlobal(); }
}

function extractCommonCrawlHtml(buffer) {
  if (!buffer?.length) return null;
  let raw;
  try { raw = zlib.gunzipSync(buffer); } catch { return null; }
  const text = raw.toString("utf8");
  const httpStart = Math.max(text.indexOf("\r\n\r\nHTTP/"), text.indexOf("\n\nHTTP/"));
  const slice = httpStart >= 0 ? text.slice(httpStart + (text.startsWith("\r\n\r\n", httpStart) ? 4 : 2)) : text;
  const split = slice.indexOf("\r\n\r\n") >= 0 ? slice.indexOf("\r\n\r\n") + 4 : slice.indexOf("\n\n") + 2;
  return split > 1 ? slice.slice(split) : slice;
}

async function lookupCommonCrawlSource(rawUrl) {
  const info = await fetchBounded("https://index.commoncrawl.org/collinfo.json", { kind: "json", timeoutMs: ARCHIVE_LOOKUP_TIMEOUT_MS, retries: 0 });
  if (!info.ok || !info.text) return { ok: false, provider: "Common Crawl", error: info.error || `status_${info.status}` };
  let collections;
  try { collections = JSON.parse(info.text); } catch { return { ok: false, provider: "Common Crawl", error: "commoncrawl_invalid_collections" }; }
  for (const collection of (collections || []).slice(0, 4)) {
    const id = collection.id;
    if (!id) continue;
    const queryUrl = `https://index.commoncrawl.org/${id}-index?url=${encodeURIComponent(rawUrl)}&output=json&filter=status:200&filter=mime:text/html&collapse=digest`;
    const index = await fetchBounded(queryUrl, { kind: "json", timeoutMs: ARCHIVE_LOOKUP_TIMEOUT_MS, retries: 0 });
    if (!index.ok || !index.text.trim()) continue;
    const lines = index.text.trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-2).reverse()) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const length = Number(record.length), offset = Number(record.offset);
      if (!record.filename || !Number.isFinite(length) || !Number.isFinite(offset)) continue;
      const segment = await fetchRangeRecord(`https://data.commoncrawl.org/${record.filename}`, offset, length);
      const html = extractCommonCrawlHtml(segment);
      if (!html) continue;
      const metadata = extractHtmlMetadata(html, rawUrl);
      const signals = extractMediaDiscoverySignals(html, rawUrl);
      const candidates = archiveOutgoingCandidates(html, rawUrl, discoveryHost(rawUrl));
      return { ok: true, provider: "Common Crawl", capture: record.timestamp || id, metadata, signals, candidates };
    }
  }
  return { ok: false, provider: "Common Crawl", error: "commoncrawl_no_capture" };
}

async function recoverArchivedSource(rawUrl) {
  const wayback = await lookupWaybackSource(rawUrl).catch((error) => ({ ok: false, provider: "Wayback", error: error?.message || "wayback_failed" }));
  if (wayback.ok && (wayback.metadata?.title || wayback.signals?.ids?.length || wayback.signals?.mediaUrls?.length || wayback.candidates?.length)) {
    return { ...wayback, attempts: [wayback] };
  }
  const common = await lookupCommonCrawlSource(rawUrl).catch((error) => ({ ok: false, provider: "Common Crawl", error: error?.message || "commoncrawl_failed" }));
  return common.ok ? { ...common, attempts: [wayback, common] } : { ok: false, provider: null, error: common.error || wayback.error || "archive_not_found", attempts: [wayback, common] };
}

function parseBraveResults(html) {
  const $ = cheerio.load(html || "");
  const results = [];
  const seen = new Set();
  $("a[href]").each((_, anchorEl) => {
    if (results.length >= 30) return false;
    const anchor = $(anchorEl);
    const titleNode = anchor.find(".snippet-title").first();
    if (!titleNode.length) return;
    const url = unwrapSearchResultHref(anchor.attr("href"), "https://search.brave.com/search");
    if (!url) return;
    const host = discoveryHost(url);
    if (!host || host === "search.brave.com" || host.endsWith(".brave.com")) return;
    const key = canonicalDiscoveryUrl(url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const container = anchor.closest(".snippet, .result, [data-type='web']");
    const title = titleNode.text().replace(/\s+/g, " ").trim();
    const snippet = container.find(".snippet-description, .snippet-content, p").first().text().replace(/\s+/g, " ").trim();
    results.push({ url, searchTitle: title || null, snippet: snippet || null, engine: "Brave" });
  });
  return results;
}

async function searchBrave(query) {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&safesearch=off&source=web`;
  const response = await fetchBounded(url, { kind: "search", timeoutMs: ALTERNATE_SEARCH_TIMEOUT_MS, retries: 1, headers: { Referer: "https://search.brave.com/", Cookie: "safesearch=off" } });
  if (!response.ok) return { ok: false, status: response.status, results: [], error: response.error || `search_status_${response.status}` };
  return { ok: true, status: response.status, results: parseBraveResults(response.text) };
}

async function searchInternetArchive(query) {
  const q = `${query} AND mediatype:movies`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&rows=30&page=1&output=json`;
  const response = await fetchBounded(url, { kind: "json", timeoutMs: ALTERNATE_SEARCH_TIMEOUT_MS, retries: 1 });
  if (!response.ok || !response.text) return { ok: false, status: response.status, results: [], error: response.error || `search_status_${response.status}` };
  try {
    const data = JSON.parse(response.text);
    const results = (data?.response?.docs || []).map((doc) => ({
      url: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`,
      searchTitle: Array.isArray(doc.title) ? doc.title[0] : doc.title || doc.identifier,
      snippet: Array.isArray(doc.description) ? doc.description[0] : doc.description || null,
      engine: "Internet Archive"
    }));
    return { ok: true, status: response.status, results };
  } catch { return { ok: false, status: response.status, results: [], error: "archive_search_invalid_json" }; }
}


async function searchMojeek(query) {
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}&hp=minimal&autocomp=0&safe=0`;
  const response = await fetchBounded(url, { kind: "search", timeoutMs: ALTERNATE_SEARCH_TIMEOUT_MS, retries: 1 });
  if (!response.ok) return { ok: false, status: response.status, results: [], error: response.error || `search_status_${response.status}` };
  return { ok: true, status: response.status, results: parseMojeekResults(response.text) };
}

async function searchDuckDuckGo(query) {
  const safeQuery = `${query} !safeoff`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(safeQuery)}&kl=us-en&kp=-2`;
  const response = await fetchBounded(url, {
    kind: "search",
    timeoutMs: ALTERNATE_SEARCH_TIMEOUT_MS,
    retries: 1,
    headers: { Referer: "https://duckduckgo.com/" }
  });
  if (!response.ok) return { ok: false, status: response.status, results: [], error: response.error || `search_status_${response.status}` };
  return { ok: true, status: response.status, results: parseDuckDuckGoResults(response.text) };
}

async function searchBing(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=25&setlang=en-US&adlt=off&adlt_set=off&safeSearch=Off`;
  const response = await fetchBounded(url, { kind: "search", timeoutMs: ALTERNATE_SEARCH_TIMEOUT_MS, retries: 1 });
  if (!response.ok) return { ok: false, status: response.status, results: [], error: response.error || `search_status_${response.status}` };
  return { ok: true, status: response.status, results: parseBingResults(response.text) };
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

function normalizeSignal(value) {
  return String(value || "").trim().toLowerCase();
}

function signalIdCandidate(value) {
  // Discovery-first: preserve short, numeric, alphabetic, and unfamiliar media IDs.
  // We only discard values that are too small to be actionable or implausibly large.
  const cleaned = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (cleaned.length < 2 || cleaned.length > 128) return null;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return cleaned;
}

function mediaFilenameStem(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    const stem = name.replace(/\.(?:mp4|m4v|mov|webm|mkv|avi|m3u8|mpd|ts)$/i, "").trim();
    return signalIdCandidate(stem);
  } catch {
    return null;
  }
}

function extractMediaDiscoverySignals(html, pageUrl) {
  const $ = cheerio.load(html || "");
  const mediaUrls = [];
  const embedUrls = [];
  const ids = [];
  const filenames = [];
  const seenUrl = new Set();
  const seenId = new Set();

  const addId = (value) => {
    const candidate = signalIdCandidate(decodeEmbeddedValue(String(value || "")));
    if (!candidate) return;
    const key = candidate.toLowerCase();
    if (seenId.has(key)) return;
    seenId.add(key); ids.push(candidate);
  };

  const addUrl = (value, kind = "media") => {
    const decoded = decodeEmbeddedValue(String(value || ""));
    const resolved = resolveUrl(decoded, pageUrl);
    if (!resolved) return;
    try { validateUrl(resolved); } catch { return; }
    const key = resolved.toLowerCase();
    if (seenUrl.has(key)) return;
    seenUrl.add(key);
    if (kind === "embed") embedUrls.push(resolved); else mediaUrls.push(resolved);
    const stem = mediaFilenameStem(resolved);
    if (stem) filenames.push(stem);
    try {
      const u = new URL(resolved);
      for (const segment of u.pathname.split("/").filter(Boolean)) addId(segment.replace(/\.[a-z0-9]{2,5}$/i, ""));
      for (const keyName of ["id", "video", "video_id", "videoId", "media", "media_id", "mediaId", "asset", "asset_id", "assetId", "clip", "clip_id", "clipId"]) {
        if (u.searchParams.has(keyName)) addId(u.searchParams.get(keyName));
      }
    } catch {}
  };

  const directSelectors = [
    ["video[src]", "src", "media"], ["video source[src]", "src", "media"], ["source[src]", "src", "media"],
    ["iframe[src]", "src", "embed"], ["embed[src]", "src", "embed"], ["object[data]", "data", "embed"]
  ];
  for (const [selector, attr, kind] of directSelectors) {
    $(selector).slice(0, 150).each((_, element) => addUrl($(element).attr(attr), kind));
  }
  for (const selector of [
    'meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player"]', 'meta[itemprop="contentUrl"]', 'meta[itemprop="embedUrl"]'
  ]) {
    $(selector).each((_, element) => addUrl($(element).attr("content"), selector.includes("player") || selector.includes("embed") ? "embed" : "media"));
  }

  const mediaUrlPattern = /(?:https?:)?\\?\/\\?\/[^\s"'<>\\]{4,1800}?\.(?:m3u8|mpd|mp4|m4v|mov|webm|mkv)(?:\?[^\s"'<>\\]*)?/gi;
  const keyedPattern = /["'](?:contentUrl|embedUrl|videoUrl|video_url|playbackUrl|playback_url|streamUrl|stream_url|hlsUrl|hls_url|dashUrl|dash_url|manifestUrl|manifest_url|file|src)["']\s*:\s*["']([^"'<>]{4,1800})["']/gi;
  const idPattern = /["'](?:videoId|video_id|mediaId|media_id|assetId|asset_id|clipId|clip_id|contentId|content_id)["']\s*:\s*["']([^"'<>]{3,128})["']/gi;
  $("script").slice(0, 200).each((_, element) => {
    const text = $(element).html() || $(element).text() || "";
    if (!text || text.length > 1_500_000) return;
    let match;
    mediaUrlPattern.lastIndex = 0;
    while ((match = mediaUrlPattern.exec(text)) && mediaUrls.length < 40) addUrl(match[0].replace(/\\\//g, "/"), "media");
    keyedPattern.lastIndex = 0;
    while ((match = keyedPattern.exec(text)) && mediaUrls.length + embedUrls.length < 60) {
      const value = match[1].replace(/\\\//g, "/");
      addUrl(value, /embed/i.test(match[0]) ? "embed" : "media");
    }
    idPattern.lastIndex = 0;
    while ((match = idPattern.exec(text)) && ids.length < 40) addId(match[1]);
  });

  // Keep discovery evidence compact. Full signed URLs are not sent to search engines.
  return {
    mediaUrls: mediaUrls.slice(0, 24),
    embedUrls: embedUrls.slice(0, 16),
    ids: [...new Set(ids)].slice(0, 24),
    filenames: [...new Set(filenames)].slice(0, 16)
  };
}

function signalsFromToolResult(toolResult) {
  const result = toolResult?.result;
  if (!result) return { ids: [], filenames: [], mediaUrls: [], embedUrls: [] };
  const ids = [result.id, result.displayId, result.genericId, result.uploaderId].map(signalIdCandidate).filter(Boolean);
  const mediaUrls = (result.mediaUrls || []).filter(Boolean);
  const filenames = mediaUrls.map(mediaFilenameStem).filter(Boolean);
  return { ids: [...new Set(ids)], filenames: [...new Set(filenames)], mediaUrls, embedUrls: [] };
}

function mergeDiscoverySignals(...signals) {
  const merge = (key) => [...new Set(signals.flatMap((signal) => signal?.[key] || []).filter(Boolean))];
  return {
    ids: merge("ids").slice(0, 32),
    filenames: merge("filenames").slice(0, 24),
    mediaUrls: merge("mediaUrls").slice(0, 32),
    embedUrls: merge("embedUrls").slice(0, 24)
  };
}

function distinctivePhrase(text, wordCount = 10) {
  const words = String(text || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}' -]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 1200);
  if (words.length < 6) return null;
  let best = null;
  for (let i = 0; i <= words.length - Math.min(wordCount, words.length); i += 1) {
    const window = words.slice(i, i + wordCount);
    const content = window.filter((word) => word.length >= 4 && !PHRASE_STOPWORDS.has(word.toLowerCase()));
    const unique = new Set(content.map((word) => word.toLowerCase()));
    const score = unique.size * 3 + content.reduce((sum, word) => sum + Math.min(word.length, 10), 0) / 10;
    if (!best || score > best.score) best = { score, phrase: window.join(" ") };
  }
  return best?.score >= 12 ? best.phrase : null;
}

function subtitleCandidates(toolResult) {
  const subtitles = toolResult?.result?.subtitles || [];
  return [...subtitles].sort((a, b) => {
    const score = (item) => (item.automatic ? 0 : 20) + (/^en(?:[-_]|$)/i.test(item.lang || "") ? 10 : 0) + (/^(?:vtt|srt|ttml|json3)$/i.test(item.ext || "") ? 4 : 0);
    return score(b) - score(a);
  });
}

function subtitleText(raw, ext = "") {
  let text = String(raw || "");
  if (/json3/i.test(ext)) {
    try {
      const data = JSON.parse(text);
      text = (data?.events || []).flatMap((event) => event?.segs || []).map((seg) => seg?.utf8 || "").join(" ");
    } catch {}
  }
  return text
    .replace(/^WEBVTT.*$/gim, " ")
    .replace(/^\d+\s*$/gm, " ")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?[.,]\d+\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d+.*$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\\[^}]+\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function transcriptPhraseFromTool(toolResult) {
  for (const subtitle of subtitleCandidates(toolResult).slice(0, 4)) {
    try {
      const response = await fetchBounded(subtitle.url, { kind: "json", timeoutMs: 7000, retries: 0, headers: { Accept: "text/vtt,text/plain,application/json,*/*" } });
      if (!response.ok || !response.text) continue;
      const phrase = distinctivePhrase(subtitleText(response.text, subtitle.ext), 11);
      if (phrase) return { phrase, lang: subtitle.lang || null, automatic: Boolean(subtitle.automatic) };
    } catch {}
  }
  return null;
}

const MEDIA_TOOL_HELPER_PATH = path.join(SERVER_DIR, "media-tool-probe.js");
const MEDIA_TOOL_TIMEOUT_MS = 16_000;
const MEDIA_TOOL_CANDIDATE_LIMIT = 18;
const MEDIA_TOOL_CANDIDATE_CONCURRENCY = 2;

async function findToolsDir() {
  const candidates = [
    process.env.LINK_PREVIEW_TOOLS_DIR,
    "C:\\Users\\WDAGUtilityAccount\\Desktop\\SandboxBootstrap\\tools",
    "C:\\SandboxBootstrap\\tools",
    path.resolve(SERVER_DIR, "..", "..", "tools")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "yt-dlp.exe"));
      return candidate;
    } catch {}
  }
  return null;
}

async function runMediaToolProbe(targetUrl, toolsDir) {
  if (!toolsDir) return { ok: false, error: "tools_not_installed", attempts: [] };
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      MEDIA_TOOL_HELPER_PATH,
      targetUrl,
      toolsDir,
      String(MEDIA_TOOL_TIMEOUT_MS),
      "6",
      "2"
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGKILL");
      finish({ ok: false, error: "media_tool_helper_timeout", attempts: [] });
    }, MEDIA_TOOL_TIMEOUT_MS * 2 + 5000);
    child.stdout.on("data", (chunk) => { outBytes += chunk.length; if (outBytes <= 2 * 1024 * 1024) stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { errBytes += chunk.length; if (errBytes <= 128 * 1024) stderr.push(chunk); });
    child.once("error", (error) => finish({ ok: false, error: error.message, diagnostic: Buffer.concat(stderr).toString("utf8").slice(-2000), attempts: [] }));
    child.once("close", () => {
      if (settled) return;
      try {
        finish(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        finish({ ok: false, error: "invalid_media_tool_response", diagnostic: Buffer.concat(stderr).toString("utf8").slice(-2000), attempts: [] });
      }
    });
  });
}

async function launchAuthorizationBrowser(targetUrl) {
  const normalized = validateUrl(targetUrl).toString();
  const host = authorizationHost(normalized);
  const entry = await ensureAuthorizationProfile(normalized);
  if (entry.status === "authorizing") {
    return { ok: true, host, status: "authorizing", alreadyOpen: true };
  }
  entry.status = "authorizing";
  entry.startedAt = Date.now();
  entry.finishedAt = null;
  entry.debugPort = await reserveLocalPort();
  const child = spawn(process.execPath, [EDGE_AUTH_HELPER_PATH, normalized, entry.path, String(entry.debugPort)], {
    windowsHide: false,
    detached: false,
    stdio: "ignore"
  });
  child.unref();
  child.once("error", () => {
    entry.status = "failed";
    entry.finishedAt = Date.now();
    entry.debugPort = null;
  });
  child.once("close", (code) => {
    entry.status = code === 0 ? "ready" : "failed";
    entry.finishedAt = Date.now();
    entry.debugPort = null;
    if (code === 0 && host) browserChallengeHosts.delete(host);
  });
  return { ok: true, host, status: "authorizing", alreadyOpen: false };
}

async function runFrameComparison(sourceUrl, candidateUrl) {
  const toolsDir = await findToolsDir();
  if (!toolsDir) return { ok: false, error: "tools_not_installed" };
  const release = await frameCompare.acquire();
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        FRAME_COMPARE_HELPER_PATH,
        validateUrl(sourceUrl).toString(),
        validateUrl(candidateUrl).toString(),
        toolsDir,
        "45000"
      ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const terminate = () => {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGKILL");
      };
      const timer = setTimeout(() => { terminate(); finish({ ok: false, error: "frame_compare_helper_timeout" }); }, 52000);
      child.stdout.on("data", (chunk) => { outBytes += chunk.length; if (outBytes <= 1024 * 1024) stdout.push(chunk); });
      child.stderr.on("data", (chunk) => { errBytes += chunk.length; if (errBytes <= 64 * 1024) stderr.push(chunk); });
      child.once("error", (error) => finish({ ok: false, error: error.message }));
      child.once("close", () => {
        if (settled) return;
        try { finish(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
        catch { finish({ ok: false, error: "invalid_frame_compare_response", diagnostic: Buffer.concat(stderr).toString("utf8").slice(-1500) }); }
      });
    });
  } finally {
    release();
  }
}

async function probePublicPageSignals(targetUrl) {
  const response = await fetchBounded(targetUrl, { kind: "media-page", timeoutMs: 8000, retries: 1 });
  if (!response.ok) return { ok: false, status: response.status, error: response.error || `status_${response.status}`, metadata: null, signals: { ids: [], filenames: [], mediaUrls: [], embedUrls: [] } };
  const pageUrl = response.finalUrl || targetUrl;
  return {
    ok: true,
    status: response.status,
    error: null,
    metadata: extractHtmlMetadata(response.text, pageUrl),
    signals: extractMediaDiscoverySignals(response.text, pageUrl)
  };
}

function evidenceOverlap(sourceSignals, candidateSignals) {
  const sourceIds = new Set((sourceSignals?.ids || []).map(normalizeSignal));
  const sourceFiles = new Set((sourceSignals?.filenames || []).map(normalizeSignal));
  const sourceHosts = new Set((sourceSignals?.mediaUrls || []).map(discoveryHost).filter(Boolean));
  const candidateIds = (candidateSignals?.ids || []).map(normalizeSignal);
  const candidateFiles = (candidateSignals?.filenames || []).map(normalizeSignal);
  const candidateHosts = new Set((candidateSignals?.mediaUrls || []).map(discoveryHost).filter(Boolean));
  const matchedIds = candidateIds.filter((value) => sourceIds.has(value));
  const matchedFilenames = candidateFiles.filter((value) => sourceFiles.has(value));
  let sharedMediaHost = false;
  for (const host of candidateHosts) if (sourceHosts.has(host)) sharedMediaHost = true;
  const score = Math.min(45, matchedIds.length * 25 + matchedFilenames.length * 22 + (sharedMediaHost ? 6 : 0));
  return { score, matchedIds: [...new Set(matchedIds)], matchedFilenames: [...new Set(matchedFilenames)], sharedMediaHost };
}

function subjectTokensFromText(value, limit = 80) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !PHRASE_STOPWORDS.has(token) && !/^\d{1,3}$/.test(token))
    .slice(0, limit);
}

function subjectAnchorTokens(source, transcript = null) {
  const scores = new Map();
  const add = (text, weight) => {
    for (const token of subjectTokensFromText(text)) scores.set(token, (scores.get(token) || 0) + weight + Math.min(token.length, 12) / 24);
  };
  add(source?.title, 5);
  add(source?.uploader, 2);
  add(source?.description, 1.5);
  add(transcript?.phrase, 2.5);
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([token]) => token)
    .slice(0, 8);
}

function candidateSubjectRelevance(source, candidate, anchors) {
  const sourceTitleSimilarity = titleSimilarity(source?.title, candidate?.title);
  const candidateTokens = new Set(subjectTokensFromText(`${candidate?.title || ""} ${candidate?.description || ""}`, 160));
  const matched = (anchors || []).filter((token) => candidateTokens.has(token));
  const anchorScore = anchors?.length ? matched.length / Math.min(6, anchors.length) : 0;
  const score = Math.min(1, sourceTitleSimilarity * 0.68 + anchorScore * 0.52);
  return { score, matched: matched.slice(0, 8), titleSimilarity: sourceTitleSimilarity };
}

function strongStandaloneSignal(value) {
  const text = String(value || "").trim();
  if (text.length < 8) return false;
  const hasLetter = /\p{L}/u.test(text);
  const hasNumber = /\p{N}/u.test(text);
  return hasLetter && hasNumber && !/^(?:master|manifest|playlist|index|stream|video|media|player)/i.test(text);
}

function buildDiscoveryQueries(source, signals, transcript, privacy = DEFAULT_PRIVACY) {
  const queries = [];
  const add = (kind, query, weight, signal = null) => {
    const cleaned = String(query || "").replace(/\s+/g, " ").trim();
    if (!cleaned || queries.some((entry) => entry.query.toLowerCase() === cleaned.toLowerCase())) return;
    queries.push({ kind, query: cleaned, weight, signal });
  };
  const title = cleanSearchTitle(source.title);
  const uploader = String(source.uploader || "").trim();
  const sourceHost = discoveryHost(source.url);
  const quote = (value) => `"${String(value || "").replace(/"/g, " ").trim()}"`;
  const anchors = subjectAnchorTokens(source, transcript);
  const anchorPhrase = anchors.slice(0, 5).join(" ");
  const anchorContext = anchorPhrase || title || uploader || sourceHost;

  // Subject-first queries. These are deliberately evaluated before raw identifiers so
  // the visible candidate set remains about the same video/topic rather than arbitrary
  // pages that happen to share an opaque ID.
  if (privacy.searchTitleUploader && source?.urlClues?.slugPhrase) {
    add("url-slug", quote(source.urlClues.slugPhrase), 0.97, source.urlClues.slugPhrase);
  }
  if (privacy.searchTitleUploader && title) {
    add("title-exact", quote(title), 1.0, title);
    if (anchorPhrase && anchorPhrase.toLowerCase() !== title.toLowerCase()) add("subject-anchor", anchorPhrase, 0.94, anchorPhrase);
    if (uploader) add("uploader-title", `${quote(uploader)} ${quote(title)}`, 0.96, uploader);
    add("longer-title", `${quote(title)} full complete extended uncut longer`, 0.90, title);
  }
  if (privacy.searchTranscript && transcript?.phrase) {
    const transcriptShort = distinctivePhrase(transcript.phrase, 7) || transcript.phrase;
    add("transcript", quote(transcriptShort), 0.98, transcriptShort);
    const transcriptWords = subjectTokensFromText(transcriptShort, 12).slice(0, 6).join(" ");
    if (transcriptWords) add("transcript-subject", transcriptWords, 0.90, transcriptWords);
  }
  const descriptionPhrase = privacy.searchDescription ? distinctivePhrase(source.description, 7) : null;
  if (descriptionPhrase) {
    add("description", quote(descriptionPhrase), 0.88, descriptionPhrase);
    const descWords = subjectTokensFromText(descriptionPhrase, 12).slice(0, 6).join(" ");
    if (descWords) add("description-subject", descWords, 0.82, descWords);
  }

  if (privacy.searchMediaIds) {
    for (const id of (signals.ids || []).slice(0, 6)) {
      const value = String(id || "").trim();
      if (!value) continue;
      if (anchorContext) add("media-id-subject", `${quote(value)} ${anchorContext}`, 0.82, value);
      if (strongStandaloneSignal(value)) add("media-id", quote(value), 0.72, value);
    }
    for (const filename of (signals.filenames || []).slice(0, 5)) {
      const value = String(filename || "").trim();
      if (!value) continue;
      if (anchorContext) add("media-filename-subject", `${quote(value)} ${anchorContext}`, 0.80, value);
      if (strongStandaloneSignal(value)) add("media-filename", quote(value), 0.68, value);
    }
  }

  try {
    const sourceUrl = new URL(source.url);
    const pathBits = sourceUrl.pathname.split("/").filter(Boolean)
      .map((part) => decodeURIComponent(part).replace(/\.[a-z0-9]{2,6}$/i, ""))
      .filter(Boolean);
    if (privacy.searchMediaIds && anchorContext) {
      for (const bit of pathBits.slice(-2)) add("url-path-subject", `${quote(bit)} ${anchorContext}`, 0.58, bit);
    }
    if (!queries.length && privacy.searchTitleUploader) add("url-fallback", quote(`${sourceUrl.hostname}${sourceUrl.pathname}`), 0.35, sourceUrl.pathname);
  } catch {}

  const familyOrder = [
    "url-slug", "title-exact", "uploader-title", "subject-anchor", "transcript", "transcript-subject",
    "description", "description-subject", "longer-title", "media-id-subject", "media-filename-subject",
    "media-id", "media-filename", "url-path-subject", "url-fallback"
  ];
  return queries
    .sort((a, b) => familyOrder.indexOf(a.kind) - familyOrder.indexOf(b.kind) || b.weight - a.weight)
    .slice(0, 14);
}

function classifyEvidenceAlternate(source, candidate, similarity, overlap, searchSupport = {}) {
  const sourceDuration = Number(source.durationSeconds) || 0;
  const candidateDuration = Number(candidate.durationSeconds) || 0;
  const sourceHost = discoveryHost(source.url);
  const candidateHost = discoveryHost(candidate.url);
  const differentSource = Boolean(sourceHost && candidateHost && sourceHost !== candidateHost);
  const durationRatio = sourceDuration > 0 && candidateDuration > 0 ? candidateDuration / sourceDuration : null;
  const longerWords = /\b(?:full|complete|extended|uncut|full[- ]?length|long(?:er)? version)\b/i;
  const lexicalLongerHint = longerWords.test(candidate.title || "") && !longerWords.test(source.title || "");

  // Search-engine provenance is discovery support, not identity evidence.
  // "Likely" labels require evidence actually recovered from the candidate page/tool.
  const engineCount = Number(searchSupport.engineCount) || 0;
  const queryCount = Number(searchSupport.queryCount) || 0;
  const provenanceBonus = Math.min(8, Math.max(0, engineCount - 1) * 2 + Math.max(0, queryCount - 1));
  let confidence = similarity * 52 + overlap.score + provenanceBonus;
  if (differentSource && similarity >= 0.45) confidence += 3;
  if (durationRatio !== null) {
    if (durationRatio >= 1.15) confidence += 8;
    else if (durationRatio >= 0.88 && durationRatio <= 1.12) confidence += 7;
  } else if (lexicalLongerHint && similarity >= 0.45) confidence += 3;
  confidence = Math.max(0, Math.min(99, Math.round(confidence)));

  const strongIdentity = overlap.score >= 22;
  let relation = "Unverified candidate";
  if (durationRatio !== null && durationRatio >= 1.15 && strongIdentity) relation = "Likely longer";
  else if (durationRatio === null && lexicalLongerHint && strongIdentity) relation = "Possible longer";
  else if (strongIdentity && (durationRatio === null || (durationRatio >= 0.82 && durationRatio <= 1.18))) relation = "Likely mirror";
  else if (similarity >= 0.62 || overlap.score > 0) relation = "Possible match";
  else if (confidence < 25) relation = "Weak match";
  return { relation, confidence, durationRatio, differentSource, lexicalLongerHint, strongIdentity, provenanceBonus };
}


function searchSupportFor(item) {
  const engines = [...new Set((item?.evidence || []).map((entry) => entry.engine).filter(Boolean))];
  const queries = [...new Set((item?.evidence || []).map((entry) => `${entry.kind}:${entry.query}`).filter(Boolean))];
  const kinds = [...new Set((item?.evidence || []).map((entry) => entry.kind).filter(Boolean))];
  return { engineCount: engines.length, queryCount: queries.length, engines, kinds };
}

function balancedCandidateSelection(gatheredMap, searchBuckets, sourceTitle, limit) {
  const selected = [];
  const selectedKeys = new Set();
  const bucketEntries = [...searchBuckets.entries()]
    .map(([bucket, keys]) => ({
      bucket,
      keys: keys.filter((key, index, all) => all.indexOf(key) === index)
    }))
    .filter((entry) => entry.keys.length);

  // Round-robin across query+engine buckets so one noisy signal cannot crowd out
  // later query families or independently indexed search engines.
  let round = 0;
  while (selected.length < limit) {
    let addedThisRound = 0;
    for (const bucket of bucketEntries) {
      const key = bucket.keys[round];
      if (!key || selectedKeys.has(key)) continue;
      const item = gatheredMap.get(key);
      if (!item) continue;
      selectedKeys.add(key);
      selected.push(item);
      addedThisRound += 1;
      if (selected.length >= limit) break;
    }
    if (!addedThisRound && bucketEntries.every((bucket) => round >= bucket.keys.length - 1)) break;
    round += 1;
    if (round > 100) break;
  }

  // Fill any remaining capacity by lexical relevance + independent engine/query support.
  if (selected.length < limit) {
    const remaining = [...gatheredMap.entries()]
      .filter(([key]) => !selectedKeys.has(key))
      .map(([key, item]) => {
        const support = searchSupportFor(item);
        const searchSimilarity = titleSimilarity(sourceTitle, item.searchTitle || "");
        return { key, item, score: searchSimilarity * 60 + Math.min(15, support.engineCount * 4 + support.queryCount * 2) };
      })
      .sort((a, b) => b.score - a.score);
    for (const entry of remaining) {
      selected.push(entry.item);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

async function findAlternates({ url, title, description, provider, durationSeconds, privacy: privacyInput }) {
  const privacy = normalizePrivacy(privacyInput);
  const sourceUrl = validateUrl(url).toString();
  const toolsDir = privacy.mediaTools ? await findToolsDir() : null;
  const urlClues = urlDiscoveryClues(sourceUrl);
  const reachability = reachabilityStateFor(sourceUrl);
  const skipSourceNetwork = reachability?.state === "dead";
  const sourcePage = skipSourceNetwork
    ? { ok: false, status: 0, error: "host_unreachable", metadata: null, signals: { ids: [], filenames: [], mediaUrls: [], embedUrls: [] } }
    : await probePublicPageSignals(sourceUrl);
  const sourceTool = privacy.mediaTools && !skipSourceNetwork ? await runMediaToolProbe(sourceUrl, toolsDir) : null;
  const archivedSource = privacy.archiveLookups ? await recoverArchivedSource(sourceUrl) : null;
  const toolInfo = sourceTool?.result || null;
  const archiveMeta = archivedSource?.metadata || null;

  let source = {
    url: sourceUrl,
    title: cleanSearchTitle(toolInfo?.title || title || sourcePage.metadata?.title || archiveMeta?.title || urlClues.slugPhrase),
    description: toolInfo?.description || description || sourcePage.metadata?.description || archiveMeta?.description || null,
    provider: provider || sourcePage.metadata?.provider || archiveMeta?.provider || toolInfo?.extractor || null,
    uploader: toolInfo?.uploader || null,
    durationSeconds: Number(toolInfo?.durationSeconds || durationSeconds || sourcePage.metadata?.durationSeconds || archiveMeta?.durationSeconds) || null,
    urlClues,
    deadHost: skipSourceNetwork
  };

  let sourceSignals = mergeDiscoverySignals(
    sourcePage.signals,
    signalsFromToolResult(sourceTool),
    archivedSource?.signals,
    { ids: urlClues.ids, filenames: urlClues.filenames, mediaUrls: [], embedUrls: [] }
  );
  let sourceEdge = null;
  if (!skipSourceNetwork && privacy.browserFallback && !sourceSignals.ids.length && !sourceSignals.filenames.length && !sourceSignals.mediaUrls.length) {
    sourceEdge = await renderMetadataWithEdge(sourceUrl);
    if (sourceEdge?.ok) {
      sourceSignals = mergeDiscoverySignals(sourceSignals, sourceEdge.mediaSignals);
      source = {
        ...source,
        title: source.title || cleanSearchTitle(sourceEdge.metadata?.title),
        description: source.description || sourceEdge.metadata?.description || null,
        durationSeconds: source.durationSeconds || sourceEdge.metadata?.durationSeconds || null
      };
    }
  }
  const transcript = privacy.searchTranscript && sourceTool?.ok ? await transcriptPhraseFromTool(sourceTool) : null;
  const subjectAnchors = subjectAnchorTokens(source, transcript);
  const queries = buildDiscoveryQueries(source, sourceSignals, transcript, privacy);

  if (!queries.length) {
    const error = new Error("not_enough_media_metadata_for_search");
    error.status = 422;
    throw error;
  }

  const privacyKey = Object.entries(privacy).sort(([a],[b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value ? 1 : 0}`).join(",");
  const cacheKey = `${canonicalDiscoveryUrl(sourceUrl)}|${source.title || ""}|${source.durationSeconds || 0}|${privacyKey}|${queries.map((q) => q.query).join("|")}`;
  const cached = alternateCacheGet(cacheKey);
  if (cached) return cached;

  const gatheredMap = new Map();
  const searchBuckets = new Map();
  const searchDiagnostics = [];
  const sourceKey = canonicalDiscoveryUrl(sourceUrl).toLowerCase();

  const addResults = (items, querySpec, engineName) => {
    const bucketKey = `${engineName}:${querySpec.kind}:${querySpec.query}`;
    if (!searchBuckets.has(bucketKey)) searchBuckets.set(bucketKey, []);
    const bucket = searchBuckets.get(bucketKey);

    for (const item of items) {
      const key = canonicalDiscoveryUrl(item.url).toLowerCase();
      if (key === sourceKey) continue;
      const provenance = {
        kind: querySpec.kind,
        queryWeight: querySpec.weight,
        signal: querySpec.signal,
        query: querySpec.query,
        engine: item.engine || engineName
      };
      const existing = gatheredMap.get(key);
      if (existing) {
        existing.evidence.push(provenance);
        if (!existing.searchTitle && item.searchTitle) existing.searchTitle = item.searchTitle;
        if (!existing.snippet && item.snippet) existing.snippet = item.snippet;
      } else {
        gatheredMap.set(key, { ...item, evidence: [provenance], discoveredOrder: gatheredMap.size });
      }
      bucket.push(key);
    }
  };

  if (privacy.archiveLookups && archivedSource?.ok && Array.isArray(archivedSource.candidates)) {
    addResults(
      archivedSource.candidates.map((candidateUrl) => ({ url: candidateUrl, searchTitle: null, snippet: "Linked or embedded from an archived copy of the original page", engine: archivedSource.provider || "Archive" })),
      { kind: "archive-link", query: `archived source ${sourceUrl}`, weight: 0.99, signal: archivedSource.capture || sourceUrl },
      archivedSource.provider || "Archive"
    );
  }

  // Every enabled engine gets every generated query. Search engines may still apply
  // their own jurisdiction/account/index policies, but our code does not selectively
  // skip an engine because another engine returned "enough" results.
  for (const querySpec of queries) {
    const tasks = [];
    if (privacy.searchDuckDuckGo) tasks.push(["DuckDuckGo", () => searchDuckDuckGo(querySpec.query)]);
    if (privacy.searchBing) tasks.push(["Bing", () => searchBing(querySpec.query)]);
    if (privacy.searchMojeek) tasks.push(["Mojeek", () => searchMojeek(querySpec.query)]);
    if (privacy.searchBrave) tasks.push(["Brave", () => searchBrave(querySpec.query)]);
    if (privacy.archiveLookups) tasks.push(["Internet Archive", () => searchInternetArchive(querySpec.query)]);

    const responses = await Promise.all(tasks.map(async ([engine, run]) => {
      try { return [engine, await run()]; }
      catch (error) { return [engine, { ok: false, status: 0, results: [], error: error?.message || "search_failed" }]; }
    }));

    for (const [engine, response] of responses) {
      searchDiagnostics.push({
        engine,
        kind: querySpec.kind,
        query: querySpec.query,
        status: response.status || 0,
        error: response.error || null,
        found: response.results?.length || 0
      });
      addResults(response.results || [], querySpec, engine);
    }
  }

  const gathered = [...gatheredMap.values()];
  const rawDiscovered = gathered.slice(0, ALTERNATE_RAW_DISCOVERY_LIMIT).map((item) => {
    const support = searchSupportFor(item);
    return {
      url: item.url,
      searchTitle: item.searchTitle || null,
      snippet: item.snippet || null,
      engines: support.engines,
      queryKinds: support.kinds,
      queryCount: support.queryCount,
      discoveredOrder: item.discoveredOrder
    };
  });

  const prioritized = balancedCandidateSelection(
    gatheredMap,
    searchBuckets,
    source.title,
    ALTERNATE_CANDIDATE_PREVIEW_LIMIT
  ).map((item) => {
    const searchSupport = searchSupportFor(item);
    const searchSimilarity = titleSimilarity(source.title, item.searchTitle || "");
    return { ...item, searchSupport, searchSimilarity };
  });

  const basicCandidates = await runLimited(prioritized, ALTERNATE_CANDIDATE_CONCURRENCY, async (item) => {
    const page = await probePublicPageSignals(item.url);
    const metadata = page.metadata || {};
    const candidate = {
      url: item.url,
      title: cleanSearchTitle(metadata.title || item.searchTitle) || item.searchTitle || item.url,
      description: metadata.description || item.snippet || null,
      provider: metadata.provider || null,
      durationSeconds: metadata.durationSeconds || null,
      image: metadata.image || null,
      images: metadata.images || [],
      method: page.ok ? "page-media-probe" : "search-result",
      previewError: page.error || null,
      searchEngine: item.searchSupport.engines.join("+") || item.engine,
      discovery: item.evidence,
      searchSupport: item.searchSupport,
      pageSignals: page.signals
    };
    const similarity = Math.max(item.searchSimilarity, titleSimilarity(source.title, candidate.title));
    const overlap = evidenceOverlap(sourceSignals, candidate.pageSignals);
    const subject = candidateSubjectRelevance(source, candidate, subjectAnchors);
    return { ...candidate, similarity, overlap, subject };
  });

  // Tool-probe a larger but still bounded set. Selection is based only on evidence
  // present on the candidate page plus lexical relevance and independent search support.
  const toolTargets = basicCandidates
    .filter(Boolean)
    .sort((a, b) => {
      const score = (candidate) =>
        candidate.overlap.score * 3 +
        candidate.similarity * 35 +
        (candidate.subject?.score || 0) * 55 +
        Math.min(10, candidate.searchSupport.engineCount * 3 + candidate.searchSupport.queryCount);
      return score(b) - score(a);
    })
    .slice(0, privacy.mediaTools && toolsDir ? MEDIA_TOOL_CANDIDATE_LIMIT : 0);

  const toolMap = new Map();
  const toolResults = await runLimited(toolTargets, MEDIA_TOOL_CANDIDATE_CONCURRENCY, async (candidate) => ({
    url: candidate.url,
    probe: await runMediaToolProbe(candidate.url, toolsDir)
  }));
  for (const item of toolResults) if (item?.url) toolMap.set(item.url, item.probe);

  const candidates = basicCandidates.map((candidate) => {
    if (!candidate) return null;
    const toolProbe = toolMap.get(candidate.url) || null;
    const tool = toolProbe?.result || null;
    const combinedSignals = mergeDiscoverySignals(candidate.pageSignals, signalsFromToolResult(toolProbe));
    const overlap = evidenceOverlap(sourceSignals, combinedSignals);
    const updated = {
      ...candidate,
      title: cleanSearchTitle(tool?.title || candidate.title) || candidate.title,
      description: tool?.description || candidate.description,
      provider: candidate.provider || tool?.extractor || null,
      durationSeconds: Number(tool?.durationSeconds || candidate.durationSeconds) || null,
      images: uniqueUrls([tool?.thumbnails || [], candidate.images || [], candidate.image], candidate.url),
      toolProbe: toolProbe ? {
        ok: Boolean(toolProbe.ok),
        mode: tool?.mode || null,
        extractor: tool?.extractor || null,
        attempts: toolProbe.attempts || []
      } : null,
      overlap
    };
    updated.image = updated.images[0] || null;
    updated.similarity = Math.max(candidate.similarity, titleSimilarity(source.title, updated.title));
    updated.subject = candidateSubjectRelevance(source, updated, subjectAnchors);
    return {
      ...updated,
      ...classifyEvidenceAlternate(source, updated, updated.similarity, overlap, candidate.searchSupport)
    };
  });

  const rankedCandidates = candidates
    .filter(Boolean)
    .filter((candidate) => canonicalDiscoveryUrl(candidate.url).toLowerCase() !== sourceKey)
    .sort((a, b) => {
      const rank = (value) =>
        value === "Likely longer" ? 6 :
        value === "Likely mirror" ? 5 :
        value === "Possible longer" ? 4 :
        value === "Possible match" ? 3 :
        value === "Unverified candidate" ? 2 : 1;
      return rank(b.relation) - rank(a.relation) ||
        b.confidence - a.confidence ||
        (b.subject?.score || 0) - (a.subject?.score || 0) ||
        b.overlap.score - a.overlap.score ||
        b.similarity - a.similarity;
    });

  const isRelatedCandidate = (candidate) =>
    candidate.overlap?.score > 0 ||
    candidate.strongIdentity ||
    (candidate.subject?.score || 0) >= 0.24 ||
    candidate.similarity >= 0.32;

  const results = rankedCandidates.filter(isRelatedCandidate).slice(0, ALTERNATE_SEARCH_MAX_RESULTS);
  const lowRelevanceResults = rankedCandidates.filter((candidate) => !isRelatedCandidate(candidate)).slice(0, ALTERNATE_SEARCH_MAX_RESULTS);

  const value = {
    source,
    sourceSignals: {
      ids: sourceSignals.ids.slice(0, 12),
      filenames: sourceSignals.filenames.slice(0, 8),
      mediaHosts: [...new Set(sourceSignals.mediaUrls.map(discoveryHost).filter(Boolean))].slice(0, 8),
      transcript: transcript ? { phrase: transcript.phrase, lang: transcript.lang, automatic: transcript.automatic } : null,
      subjectAnchors: subjectAnchors.slice(0, 8),
      urlClues: { slugPhrase: urlClues.slugPhrase, phrases: urlClues.phrases.slice(0, 4), ids: urlClues.ids.slice(0, 8) },
      archivedSource: archivedSource?.ok ? { provider: archivedSource.provider, capture: archivedSource.capture || null, recoveredTitle: archivedSource.metadata?.title || null, directCandidates: archivedSource.candidates?.length || 0 } : null
    },
    privacy,
    tools: {
      installed: Boolean(toolsDir),
      directory: toolsDir ? "SandboxBootstrap\\tools" : null,
      ytDlp: Boolean(sourceTool?.tooling?.ytDlp),
      deno: Boolean(sourceTool?.tooling?.deno),
      ffmpeg: Boolean(sourceTool?.tooling?.ffmpeg),
      sourceMode: sourceTool?.result?.mode || null,
      sourceExtractor: sourceTool?.result?.extractor || null,
      edgeMediaProbe: Boolean(sourceEdge?.ok),
      attempts: sourceTool?.attempts || []
    },
    results,
    lowRelevanceResults,
    queries: queries.map((entry) => entry.query),
    queryEvidence: queries,
    searchDiagnostics,
    searchPolicy: {
      duckDuckGoSafeSearch: "off-requested twice (kp=-2 + !safeoff)",
      bingSafeSearch: "off-requested (adlt=off, adlt_set=off, safeSearch=Off)",
      mojeekSafeSearch: "off-requested (safe=0)",
      braveSafeSearch: "off-requested (safesearch=off)",
      internetArchive: "media catalog + Wayback/Common Crawl source recovery; no app SafeSearch filter",
      note: "DuckDuckGo is explicitly requested with kp=-2 and !safeoff; Mojeek with safe=0; Bing with multiple off parameters; Brave with safesearch=off. Archive.org media search and archived source recovery are also used when enabled. Providers may still enforce their own jurisdiction/account/index policy outside this app."
    },
    candidateCount: gathered.length,
    rawDiscoveredCount: gathered.length,
    rawDiscovered,
    rawDiscoveredTruncated: gathered.length > rawDiscovered.length,
    evaluatedCount: prioritized.length,
    toolEvaluatedCount: toolTargets.length,
    manualSearchUrl: privacy.searchDuckDuckGo && queries[0] ? `https://duckduckgo.com/?q=${encodeURIComponent(`${queries[0].query} !safeoff`)}&kp=-2` : null,
    archiveRecovery: archivedSource ? { ok: Boolean(archivedSource.ok), provider: archivedSource.provider || null, capture: archivedSource.capture || null, error: archivedSource.error || null, attempts: (archivedSource.attempts || []).map((item) => ({ provider: item.provider, ok: Boolean(item.ok), error: item.error || null })) } : null,
    cached: false,
    note: toolsDir
      ? "Discovery is host-agnostic: yt-dlp native and forced-generic extraction, raw page/embed/media identifiers, optional subtitle phrases, and general web search are combined. Unknown hosts are not rejected. Search provenance is used only for discovery/inspection priority; it can no longer create a likely-match label by itself. Unknown hosts are retained. Ranked results are subject-focused, while low-relevance inspected results and raw discovery remain visible separately so relevance filtering never becomes hidden censorship. Candidate identity labels require evidence recovered from the candidate itself, and frame comparison is available for verification."
      : "Portable media tools were not found, so discovery used host-agnostic page/media signatures and general web search only. Install the Link Preview tools package for yt-dlp generic extraction and subtitle-assisted discovery."
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
    version: "2.6.0",
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
    browserProxyConnectionLimit: BROWSER_PROXY_NETWORK_LIMIT,
    cachedPreviews: previewCache.size,
    cachedAlternateSearches: alternateCache.size
  });
});

async function previewHandler(req, res) {
  const targetUrl = req.method === "GET" ? req.query.url : req.body?.url;
  if (!targetUrl || typeof targetUrl !== "string") return res.status(400).json({ error: "missing_url" });

  try {
    const privacy = normalizePrivacy(req.method === "POST" ? req.body?.privacy : null);
    const allowBrowserFallback = privacy.browserFallback &&
      (req.method === "POST" ? req.body?.allowBrowserFallback !== false : req.query.browser !== "0");
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

app.post("/api/authorize-host", async (req, res) => {
  const privacy = normalizePrivacy(req.body?.privacy);
  if (!privacy.interactiveAuthorization) return res.status(403).json({ error: "privacy_interactive_authorization_disabled" });
  const targetUrl = req.body?.url;
  if (!targetUrl || typeof targetUrl !== "string") return res.status(400).json({ error: "missing_url" });
  try {
    const result = await launchAuthorizationBrowser(targetUrl.trim());
    return res.json({
      ...result,
      reusableForHost: result.host || null,
      note: "A reusable site session was opened inside Windows Sandbox. The app will automatically retry one refresh and may accept recognized cookie/privacy consent controls. CAPTCHA/anti-bot challenges, age attestations, logins, and other access-control prompts remain manual. Once the real site is reachable, one successful Retry can reuse this session for other previews on the same host."
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "authorization_launch_failed" });
  }
});

app.get("/api/authorization-status", (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== "string") return res.status(400).json({ error: "missing_url" });
  try {
    validateUrl(targetUrl);
    const host = authorizationHost(targetUrl);
    const entry = authorizationEntryFor(targetUrl);
    return res.json({ host, status: entry?.status || "none", ready: entry?.status === "ready", live: entry?.status === "authorizing" && Number.isInteger(entry?.debugPort) });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "authorization_status_failed" });
  }
});

app.post("/api/compare-video", async (req, res) => {
  const privacy = normalizePrivacy(req.body?.privacy);
  if (!privacy.sampleComparison) return res.status(403).json({ error: "privacy_sample_comparison_disabled" });
  const sourceUrl = req.body?.sourceUrl;
  const candidateUrl = req.body?.candidateUrl;
  if (!sourceUrl || !candidateUrl || typeof sourceUrl !== "string" || typeof candidateUrl !== "string") {
    return res.status(400).json({ error: "missing_compare_url" });
  }
  try {
    const result = await runFrameComparison(sourceUrl.trim(), candidateUrl.trim());
    return res.status(result.ok ? 200 : 422).json(result);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "frame_compare_failed" });
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
      durationSeconds: req.body?.durationSeconds,
      privacy: req.body?.privacy
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
  console.log(`Video preview engine v2.6.0 listening on http://127.0.0.1:${PORT}`);
  console.log(`Network limits: ${GLOBAL_NETWORK_LIMIT} global / ${PER_HOST_NETWORK_LIMIT} per host.`);
  console.log(`Edge fallback: ${BROWSER_FALLBACK_LIMIT} isolated helper worker; helper proxy limit ${BROWSER_PROXY_NETWORK_LIMIT}.`);
});
