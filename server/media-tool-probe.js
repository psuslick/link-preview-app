import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const targetUrl = process.argv[2];
const toolsDir = process.argv[3];
const timeoutMs = Math.max(6000, Number(process.argv[4]) || 15000);
const globalLimit = Math.max(1, Number(process.argv[5]) || 6);
const perHostLimit = Math.max(1, Number(process.argv[6]) || 2);

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  acquire() {
    return new Promise((resolve) => {
      const grant = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.waiters.shift()?.();
        });
      };
      if (this.active < this.limit) grant(); else this.waiters.push(grant);
    });
  }
}

const globalGate = new Semaphore(globalLimit);
const hostGates = new Map();
function hostGate(hostname) {
  const key = hostname.toLowerCase();
  if (!hostGates.has(key)) hostGates.set(key, new Semaphore(perHostLimit));
  return hostGates.get(key);
}

function isBlockedIPv4(address) {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
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
  const lower = String(address || "").toLowerCase();
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
  const normalized = String(hostname || "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!normalized) throw new Error("missing_hostname");
  if (
    normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") ||
    normalized.endsWith(".lan") || normalized.endsWith(".internal")
  ) throw new Error("private_network_url_blocked");
  if (net.isIP(normalized) && isBlockedAddress(normalized)) throw new Error("private_network_url_blocked");
  return normalized;
}

function validateUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported_protocol");
  if (url.username || url.password) throw new Error("url_credentials_not_allowed");
  validateHostname(url.hostname);
  return url;
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

async function startSafetyProxy() {
  const sockets = new Set();
  const proxy = http.createServer(async (req, res) => {
    let url;
    try {
      if (!["GET", "HEAD"].includes(req.method || "GET")) throw new Error("method_blocked");
      url = validateUrl(req.url);
      if (url.protocol !== "http:") throw new Error("proxy_http_only");
    } catch {
      res.writeHead(403, { Connection: "close" }); res.end("blocked"); return;
    }

    const hostname = url.hostname.toLowerCase();
    const releaseGlobal = await globalGate.acquire();
    const releaseHost = await hostGate(hostname).acquire();
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      releaseHost(); releaseGlobal();
    };

    try {
      const resolved = await resolvePublicAddress(hostname);
      const headers = { ...req.headers, host: url.host, connection: "close" };
      delete headers["proxy-connection"];
      const upstream = http.request({
        host: resolved.address,
        family: resolved.family,
        port: Number(url.port || 80),
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers
      }, (upstreamRes) => {
        const outHeaders = { ...upstreamRes.headers };
        delete outHeaders["transfer-encoding"];
        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
        let bytes = 0;
        const limit = req.method === "HEAD" ? 0 : 3 * 1024 * 1024;
        upstreamRes.on("data", (chunk) => {
          bytes += chunk.length;
          if (limit && bytes > limit) {
            upstreamRes.destroy();
            if (!res.destroyed) res.end();
          } else if (!res.destroyed) res.write(chunk);
        });
        upstreamRes.once("end", () => { if (!res.destroyed) res.end(); finalize(); });
        upstreamRes.once("error", () => { if (!res.destroyed) res.destroy(); finalize(); });
      });
      upstream.setTimeout(9000, () => upstream.destroy(new Error("proxy_timeout")));
      upstream.once("error", () => {
        if (!res.headersSent) res.writeHead(502);
        if (!res.destroyed) res.end();
        finalize();
      });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(403);
      res.end("blocked"); finalize();
    }
  });

  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });

  proxy.on("connect", (req, clientSocket, head) => {
    clientSocket.on("error", () => {});
    (async () => {
      try {
        const authority = new URL(`http://${req.url}`);
        const hostname = validateHostname(authority.hostname);
        const port = Number(authority.port || 443);
        if (port !== 443) throw new Error("connect_port_blocked");
        const resolved = await resolvePublicAddress(hostname);
        const releaseGlobal = await globalGate.acquire();
        const releaseHost = await hostGate(hostname).acquire();
        let finalized = false;
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          releaseHost(); releaseGlobal();
        };
        const upstream = net.connect({ host: resolved.address, port, family: resolved.family });
        upstream.on("error", () => clientSocket.destroy());
        upstream.setTimeout(timeoutMs + 5000, () => upstream.destroy());
        clientSocket.setTimeout(timeoutMs + 5000, () => clientSocket.destroy());
        upstream.once("connect", () => {
          if (clientSocket.destroyed) { upstream.destroy(); finalize(); return; }
          clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: LinkPreviewMediaProbe\r\n\r\n");
          if (head?.length) upstream.write(head);
          clientSocket.pipe(upstream); upstream.pipe(clientSocket);
        });
        upstream.once("close", finalize);
        clientSocket.once("close", () => { upstream.destroy(); finalize(); });
      } catch {
        if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
    })().catch(() => clientSocket.destroy());
  });

  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  return {
    port: typeof address === "object" && address ? address.port : null,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(() => resolve()));
    }
  };
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function uniquePublicUrls(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== "string") continue;
    try {
      const url = validateUrl(value).toString();
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(url);
    } catch {}
  }
  return out;
}

function normalizeInfo(info, mode) {
  if (!info || typeof info !== "object") return null;
  const thumbnails = uniquePublicUrls([
    info.thumbnail,
    ...(Array.isArray(info.thumbnails) ? info.thumbnails.map((t) => t?.url) : [])
  ]).slice(0, 10);
  const mediaUrls = uniquePublicUrls([
    info.url,
    ...(Array.isArray(info.formats) ? info.formats.map((f) => f?.url) : []),
    info.manifest_url
  ]).slice(0, 20);

  const subtitleEntries = [];
  const collectSubs = (collection, automatic) => {
    if (!collection || typeof collection !== "object") return;
    for (const [lang, formats] of Object.entries(collection)) {
      if (!Array.isArray(formats)) continue;
      for (const format of formats) {
        if (!format?.url) continue;
        try {
          subtitleEntries.push({
            lang,
            ext: format.ext || null,
            name: format.name || null,
            automatic,
            url: validateUrl(format.url).toString()
          });
        } catch {}
        if (subtitleEntries.length >= 30) return;
      }
    }
  };
  collectSubs(info.subtitles, false);
  collectSubs(info.automatic_captions, true);

  return {
    mode,
    extractor: info.extractor || null,
    extractorKey: info.extractor_key || null,
    id: info.id ? String(info.id) : null,
    displayId: info.display_id ? String(info.display_id) : null,
    title: info.title || info.fulltitle || null,
    description: info.description || null,
    uploader: info.uploader || info.channel || info.creator || null,
    uploaderId: info.uploader_id || info.channel_id || null,
    durationSeconds: Number.isFinite(Number(info.duration)) ? Number(info.duration) : null,
    timestamp: Number.isFinite(Number(info.timestamp)) ? Number(info.timestamp) : null,
    webpageUrl: info.webpage_url || null,
    originalUrl: info.original_url || null,
    thumbnails,
    mediaUrls,
    subtitles: subtitleEntries
  };
}

async function runYtDlp(ytDlp, proxyPort, forceGeneric, deno, ffmpegBin) {
  const args = [
    "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-playlist",
    "--skip-download", "--dump-single-json", "--no-warnings", "--no-write-comments",
    "--socket-timeout", "8", "--retries", "0", "--fragment-retries", "0",
    "--extractor-retries", "0", "--proxy", `http://127.0.0.1:${proxyPort}`
  ];
  if (forceGeneric) args.push("--force-generic-extractor");
  if (deno) args.push("--js-runtimes", `deno:${deno}`);
  if (ffmpegBin) args.push("--ffmpeg-location", ffmpegBin);
  args.push("--", targetUrl);

  return await new Promise((resolve) => {
    const child = spawn(ytDlp, args, {
      windowsHide: true,
      env: { ...process.env, YTDLP_NO_PLUGINS: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= 6 * 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errBytes += chunk.length;
      if (errBytes <= 128 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, stderr: Buffer.concat(stderr).toString("utf8").slice(-4000) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf8").trim();
      const errorText = Buffer.concat(stderr).toString("utf8").trim().slice(-4000);
      if (timedOut) return resolve({ ok: false, error: "yt_dlp_timeout", stderr: errorText });
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      if (code === 0 && parsed) return resolve({ ok: true, info: parsed, stderr: errorText });
      return resolve({ ok: false, error: `yt_dlp_exit_${code ?? "unknown"}`, stderr: errorText });
    });
  });
}

async function main() {
  let proxy;
  try {
    validateUrl(targetUrl);
    const ytDlp = path.join(toolsDir || "", "yt-dlp.exe");
    if (!toolsDir || !(await exists(ytDlp))) {
      process.stdout.write(JSON.stringify({ ok: false, error: "yt_dlp_not_found" }));
      return;
    }
    const denoCandidate = path.join(toolsDir, "deno.exe");
    const deno = await exists(denoCandidate) ? denoCandidate : null;
    const ffmpegCandidates = [
      path.join(toolsDir, "ffmpeg", "bin"),
      path.join(toolsDir, "ffmpeg", "bin", "ffmpeg.exe"),
      toolsDir
    ];
    let ffmpegBin = null;
    for (const candidate of ffmpegCandidates) {
      const probe = candidate.toLowerCase().endsWith(".exe") ? candidate : path.join(candidate, "ffmpeg.exe");
      if (await exists(probe)) { ffmpegBin = path.dirname(probe); break; }
    }

    proxy = await startSafetyProxy();
    const attempts = [];
    const normal = await runYtDlp(ytDlp, proxy.port, false, deno, ffmpegBin);
    attempts.push({ mode: "native", ok: normal.ok, error: normal.error || null, stderr: normal.stderr || null });
    let normalized = normal.ok ? normalizeInfo(normal.info, "native") : null;

    // Always give the generic extractor a separate chance, even when a dedicated extractor succeeds.
    // Some dedicated extractors expose only canonical metadata while the generic path reveals embeds,
    // manifest URLs, or IDs useful for mirror discovery. Generic extraction is additive, not a gate.
    const generic = await runYtDlp(ytDlp, proxy.port, true, deno, ffmpegBin);
    attempts.push({ mode: "generic", ok: generic.ok, error: generic.error || null, stderr: generic.stderr || null });
    const genericInfo = generic.ok ? normalizeInfo(generic.info, "generic") : null;
    if (genericInfo) {
      if (!normalized) normalized = genericInfo;
      else {
        normalized = {
          ...normalized,
          genericExtractor: genericInfo.extractor,
          genericExtractorKey: genericInfo.extractorKey,
          thumbnails: uniquePublicUrls([normalized.thumbnails, genericInfo.thumbnails]).slice(0, 14),
          mediaUrls: uniquePublicUrls([normalized.mediaUrls, genericInfo.mediaUrls]).slice(0, 32),
          subtitles: [...normalized.subtitles, ...genericInfo.subtitles].slice(0, 40),
          genericId: genericInfo.id || genericInfo.displayId || null
        };
      }
    }

    process.stdout.write(JSON.stringify({
      ok: Boolean(normalized),
      tooling: { ytDlp: true, deno: Boolean(deno), ffmpeg: Boolean(ffmpegBin) },
      result: normalized,
      attempts
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error?.message || "media_tool_probe_failed" }));
  } finally {
    try { await proxy?.close(); } catch {}
  }
}

await main();
