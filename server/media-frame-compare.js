import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const sourceUrl = process.argv[2];
const candidateUrl = process.argv[3];
const toolsDir = process.argv[4];
const timeoutMs = Math.max(15000, Number(process.argv[5]) || 45000);

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
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".lan") || normalized.endsWith(".internal")) {
    throw new Error("private_network_url_blocked");
  }
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
  if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) throw new Error("private_network_dns_blocked");
  return addresses[0];
}

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
const globalGate = new Semaphore(4);
const hostGates = new Map();
function hostGate(host) {
  const key = host.toLowerCase();
  if (!hostGates.has(key)) hostGates.set(key, new Semaphore(2));
  return hostGates.get(key);
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
    let done = false;
    const finish = () => { if (done) return; done = true; releaseHost(); releaseGlobal(); };
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
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.once("end", finish);
        upstreamRes.once("error", () => { res.destroy(); finish(); });
      });
      upstream.setTimeout(8000, () => upstream.destroy(new Error("proxy_timeout")));
      upstream.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); finish(); });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(403);
      res.end("blocked"); finish();
    }
  });
  proxy.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); });
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
        let done = false;
        const finish = () => { if (done) return; done = true; releaseHost(); releaseGlobal(); };
        const upstream = net.connect({ host: resolved.address, port, family: resolved.family });
        upstream.on("error", () => clientSocket.destroy());
        upstream.setTimeout(12000, () => upstream.destroy());
        clientSocket.setTimeout(12000, () => clientSocket.destroy());
        upstream.once("connect", () => {
          if (clientSocket.destroyed) { upstream.destroy(); finish(); return; }
          clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: LinkPreviewFrameCompare\r\n\r\n");
          if (head?.length) upstream.write(head);
          clientSocket.pipe(upstream); upstream.pipe(clientSocket);
        });
        upstream.once("close", finish);
        clientSocket.once("close", () => { upstream.destroy(); finish(); });
      } catch {
        if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
    })().catch(() => clientSocket.destroy());
  });
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const address = proxy.address();
  return {
    port: typeof address === "object" && address ? address.port : null,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(() => resolve())).catch(() => {});
    }
  };
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else child.kill("SIGKILL");
}

async function runJsonProcess(exe, args, ms) {
  return await new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, env: { ...process.env, YTDLP_NO_PLUGINS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = []; let outBytes = 0; let errBytes = 0; let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { killTree(child); finish({ ok: false, error: "process_timeout" }); }, ms);
    child.stdout.on("data", (chunk) => { outBytes += chunk.length; if (outBytes <= 8 * 1024 * 1024) stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { errBytes += chunk.length; if (errBytes <= 128 * 1024) stderr.push(chunk); });
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("close", (code) => {
      const text = Buffer.concat(stdout).toString("utf8").trim();
      let json = null; try { json = JSON.parse(text); } catch {}
      if (code === 0 && json) finish({ ok: true, json });
      else finish({ ok: false, error: `exit_${code ?? "unknown"}`, diagnostic: Buffer.concat(stderr).toString("utf8").slice(-2500) });
    });
  });
}

async function extractInfo(url, ytDlp, deno, ffmpegBin, proxyPort) {
  const base = [
    "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-playlist", "--skip-download",
    "--dump-single-json", "--no-warnings", "--socket-timeout", "8", "--retries", "0", "--fragment-retries", "0",
    "--extractor-retries", "0", "--proxy", `http://127.0.0.1:${proxyPort}`
  ];
  if (deno) base.push("--js-runtimes", `deno:${deno}`);
  if (ffmpegBin) base.push("--ffmpeg-location", ffmpegBin);
  const normal = await runJsonProcess(ytDlp, [...base, "--", url], Math.min(timeoutMs / 3, 16000));
  if (normal.ok) return { ...normal, mode: "native" };
  const generic = await runJsonProcess(ytDlp, [...base, "--force-generic-extractor", "--", url], Math.min(timeoutMs / 3, 16000));
  return generic.ok ? { ...generic, mode: "generic" } : { ok: false, error: generic.error || normal.error, diagnostic: generic.diagnostic || normal.diagnostic };
}

function formatHeaders(info, format) {
  const headers = { ...(info?.http_headers || {}), ...(format?.http_headers || {}) };
  delete headers.Cookie;
  delete headers.cookie;
  return Object.entries(headers)
    .filter(([key, value]) => key && value != null && !/^cookie$/i.test(key))
    .map(([key, value]) => `${key}: ${String(value).replace(/[\r\n]+/g, " ")}`)
    .join("\r\n");
}

function chooseFormat(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const usable = formats.filter((f) => f?.url && f.vcodec !== "none" && /^https?:/i.test(f.url));
  usable.sort((a, b) => {
    const hA = Number(a.height) || 9999; const hB = Number(b.height) || 9999;
    const targetA = hA <= 540 ? Math.abs(hA - 360) : 5000 + hA;
    const targetB = hB <= 540 ? Math.abs(hB - 360) : 5000 + hB;
    const protocolPenalty = (f) => /https?/.test(f.protocol || "") ? 0 : /m3u8/.test(f.protocol || "") ? 20 : 50;
    return targetA + protocolPenalty(a) - (targetB + protocolPenalty(b));
  });
  const format = usable[0] || (info?.url && /^https?:/i.test(info.url) ? { url: info.url, http_headers: info.http_headers || {} } : null);
  if (!format) return null;
  return {
    url: format.url,
    headers: formatHeaders(info, format),
    height: Number(format.height) || null,
    protocol: format.protocol || null
  };
}

async function captureHash(ffmpeg, format, seconds, proxyPort, ms = 6500) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-rw_timeout", "5000000",
    "-probesize", "262144", "-analyzeduration", "1000000",
    "-ss", Math.max(0, seconds).toFixed(3),
    "-http_proxy", `http://127.0.0.1:${proxyPort}`
  ];
  if (format.headers) args.push("-headers", `${format.headers}\r\n`);
  args.push("-i", format.url, "-an", "-sn", "-dn", "-frames:v", "1", "-vf", "scale=9:8:flags=fast_bilinear,format=gray", "-f", "rawvideo", "pipe:1");
  return await new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = []; const errors = []; let bytes = 0; let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { killTree(child); finish({ ok: false, error: "frame_timeout" }); }, ms);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 4096) output.push(chunk); });
    child.stderr.on("data", (chunk) => { if (Buffer.concat(errors).length < 8192) errors.push(chunk); });
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("close", (code) => {
      const buffer = Buffer.concat(output);
      if (code !== 0 || buffer.length < 72) return finish({ ok: false, error: `ffmpeg_frame_exit_${code ?? "unknown"}`, diagnostic: Buffer.concat(errors).toString("utf8").slice(-1200) });
      const pixels = buffer.subarray(0, 72);
      let hash = 0n;
      let bit = 0n;
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          if (pixels[y * 9 + x] > pixels[y * 9 + x + 1]) hash |= 1n << bit;
          bit += 1n;
        }
      }
      finish({ ok: true, hash: hash.toString(16).padStart(16, "0") });
    });
  });
}

function hamming(hexA, hexB) {
  let value = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}
function sampleTimes(duration, count, edge = 0.06) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d < 4) return [];
  const start = Math.max(1, d * edge);
  const end = Math.max(start + 0.5, Math.min(d - 1, d * (1 - edge)));
  if (count <= 1) return [(start + end) / 2];
  return Array.from({ length: count }, (_, i) => start + (end - start) * (i / (count - 1)));
}

async function hashesFor(ffmpeg, format, times, proxyPort) {
  const hashes = [];
  for (const time of times) {
    const frame = await captureHash(ffmpeg, format, time, proxyPort);
    if (frame.ok) hashes.push({ time, hash: frame.hash });
  }
  return hashes;
}

function compareHashes(source, candidate) {
  if (!source.length || !candidate.length) return null;
  const matches = source.map((s) => {
    let best = null;
    candidate.forEach((c, index) => {
      const distance = hamming(s.hash, c.hash);
      if (!best || distance < best.distance) best = { sourceTime: s.time, candidateTime: c.time, candidateIndex: index, distance };
    });
    return best;
  });
  const avg = matches.reduce((sum, m) => sum + m.distance, 0) / matches.length;
  const max = Math.max(...matches.map((m) => m.distance));
  let monotonic = true;
  for (let i = 1; i < matches.length; i += 1) if (matches[i].candidateIndex <= matches[i - 1].candidateIndex) monotonic = false;
  const similarity = Math.max(0, Math.min(100, Math.round((1 - avg / 32) * 100)));
  return { matches, averageDistance: Number(avg.toFixed(2)), maxDistance: max, monotonic, similarity };
}

async function main() {
  validateUrl(sourceUrl); validateUrl(candidateUrl);
  const ytDlp = path.join(toolsDir || "", "yt-dlp.exe");
  const deno = path.join(toolsDir || "", "deno.exe");
  const ffmpeg = path.join(toolsDir || "", "ffmpeg", "bin", "ffmpeg.exe");
  const ffprobe = path.join(toolsDir || "", "ffmpeg", "bin", "ffprobe.exe");
  if (!(await exists(ytDlp))) throw new Error("yt_dlp_not_found");
  if (!(await exists(ffmpeg))) throw new Error("ffmpeg_not_found");
  const proxy = await startSafetyProxy();
  try {
    const ffmpegBin = path.dirname(ffmpeg);
    const denoPath = await exists(deno) ? deno : null;
    const [sourceInfoResult, candidateInfoResult] = await Promise.all([
      extractInfo(sourceUrl, ytDlp, denoPath, ffmpegBin, proxy.port),
      extractInfo(candidateUrl, ytDlp, denoPath, ffmpegBin, proxy.port)
    ]);
    if (!sourceInfoResult.ok) throw new Error(`source_extract_failed:${sourceInfoResult.error || "unknown"}`);
    if (!candidateInfoResult.ok) throw new Error(`candidate_extract_failed:${candidateInfoResult.error || "unknown"}`);
    const sourceInfo = sourceInfoResult.json;
    const candidateInfo = candidateInfoResult.json;
    if (sourceInfo?.is_drm || candidateInfo?.is_drm) throw new Error("drm_media_not_compared");
    const sourceDuration = Number(sourceInfo?.duration);
    const candidateDuration = Number(candidateInfo?.duration);
    if (!Number.isFinite(sourceDuration) || !Number.isFinite(candidateDuration) || sourceDuration < 4 || candidateDuration < 4) {
      throw new Error("duration_unavailable_for_sampling");
    }
    const sourceFormat = chooseFormat(sourceInfo);
    const candidateFormat = chooseFormat(candidateInfo);
    if (!sourceFormat || !candidateFormat) throw new Error("public_video_format_unavailable");

    const sourceTimes = sampleTimes(sourceDuration, 3, 0.16);
    const ratio = candidateDuration / sourceDuration;
    const candidateCount = ratio > 1.2 ? 14 : 5;
    const candidateTimes = sampleTimes(candidateDuration, candidateCount, 0.05);
    const sourceHashes = await hashesFor(ffmpeg, sourceFormat, sourceTimes, proxy.port);
    const candidateHashes = await hashesFor(ffmpeg, candidateFormat, candidateTimes, proxy.port);
    if (sourceHashes.length < 2 || candidateHashes.length < 2) throw new Error("insufficient_frames_sampled");
    const comparison = compareHashes(sourceHashes, candidateHashes);
    if (!comparison) throw new Error("frame_compare_failed");

    const strong = comparison.averageDistance <= 10 && comparison.maxDistance <= 18 && (ratio <= 1.2 || comparison.monotonic);
    const possible = comparison.averageDistance <= 16 && comparison.maxDistance <= 24;
    let relation = "No perceptual match";
    if (strong && ratio >= 1.15) relation = "Verified likely longer";
    else if (strong && ratio >= 0.82 && ratio <= 1.18) relation = "Verified likely mirror";
    else if (strong) relation = "Verified same footage";
    else if (possible) relation = ratio >= 1.15 ? "Possible longer by frames" : "Possible frame match";

    return {
      ok: true,
      relation,
      verified: strong,
      possible,
      similarity: comparison.similarity,
      averageDistance: comparison.averageDistance,
      maxDistance: comparison.maxDistance,
      monotonic: comparison.monotonic,
      sourceDuration,
      candidateDuration,
      sourceFrames: sourceHashes.length,
      candidateFrames: candidateHashes.length,
      matches: comparison.matches.map((m) => ({
        sourceTime: Number(m.sourceTime.toFixed(2)),
        candidateTime: Number(m.candidateTime.toFixed(2)),
        distance: m.distance
      })),
      extraction: { source: sourceInfoResult.mode, candidate: candidateInfoResult.mode },
      note: "Perceptual comparison samples a few low-resolution remote frames through the Sandbox public-network safety proxy. It does not download complete videos."
    };
  } finally {
    await proxy.close();
  }
}

try {
  const result = await Promise.race([
    main(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("frame_compare_timeout")), timeoutMs))
  ]);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message || "frame_compare_failed" }));
}
