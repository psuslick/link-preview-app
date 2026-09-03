import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const targetUrl = process.argv[2];
const profileDir = process.argv[3];
const GLOBAL_LIMIT = 8;
const PER_HOST_LIMIT = 4;

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
const globalGate = new Semaphore(GLOBAL_LIMIT);
const hostGates = new Map();
function hostGate(host) {
  const key = host.toLowerCase();
  if (!hostGates.has(key)) hostGates.set(key, new Semaphore(PER_HOST_LIMIT));
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
  if (lower.startsWith("ff") || lower.startsWith("2001:db8")) return true;
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
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".lan") || normalized.endsWith(".internal")) throw new Error("private_network_url_blocked");
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
function isLikelyMediaPath(pathname = "") {
  return /\.(?:mp4|m4v|mov|webm|mkv|avi|mp3|m4a|aac|wav|flac|m3u8|mpd|ts)(?:$|[?#])/i.test(pathname);
}

async function findEdgeExecutable() {
  for (const candidate of ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  return null;
}
async function startSafetyProxy() {
  const sockets = new Set();
  const proxy = http.createServer(async (req, res) => {
    let url;
    try {
      if (!["GET", "HEAD"].includes(req.method || "GET")) { res.writeHead(204); res.end(); return; }
      url = validateUrl(req.url);
      if (url.protocol !== "http:") throw new Error("proxy_http_only");
      if (isLikelyMediaPath(url.pathname)) { res.writeHead(204); res.end(); return; }
    } catch { res.writeHead(403); res.end("blocked"); return; }
    const hostname = url.hostname.toLowerCase();
    const releaseGlobal = await globalGate.acquire();
    const releaseHost = await hostGate(hostname).acquire();
    let done = false;
    const finish = () => { if (done) return; done = true; releaseHost(); releaseGlobal(); };
    try {
      const resolved = await resolvePublicAddress(hostname);
      const headers = { ...req.headers, host: url.host, connection: "close" };
      delete headers["proxy-connection"];
      const upstream = http.request({ host: resolved.address, family: resolved.family, port: Number(url.port || 80), method: req.method, path: `${url.pathname}${url.search}`, headers }, (upstreamRes) => {
        const contentType = String(upstreamRes.headers["content-type"] || "").toLowerCase();
        if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
          upstreamRes.destroy();
          if (!res.headersSent) res.writeHead(204);
          res.end(); finish(); return;
        }
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.once("end", finish);
        upstreamRes.once("error", () => { res.destroy(); finish(); });
      });
      upstream.setTimeout(12000, () => upstream.destroy(new Error("proxy_timeout")));
      upstream.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); finish(); });
      req.pipe(upstream);
    } catch { if (!res.headersSent) res.writeHead(403); res.end("blocked"); finish(); }
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
        upstream.setTimeout(20000, () => upstream.destroy());
        clientSocket.setTimeout(20000, () => clientSocket.destroy());
        upstream.once("connect", () => {
          if (clientSocket.destroyed) { upstream.destroy(); finish(); return; }
          clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: LinkPreviewAuthorize\r\n\r\n");
          if (head?.length) upstream.write(head);
          clientSocket.pipe(upstream); upstream.pipe(clientSocket);
        });
        upstream.once("close", finish);
        clientSocket.once("close", () => { upstream.destroy(); finish(); });
      } catch { if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
    })().catch(() => clientSocket.destroy());
  });
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const address = proxy.address();
  return {
    port: typeof address === "object" && address ? address.port : null,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => proxy.close(() => resolve())).catch(() => {}); }
  };
}

async function run() {
  validateUrl(targetUrl);
  if (!profileDir) throw new Error("missing_profile_dir");
  const edgePath = await findEdgeExecutable();
  if (!edgePath) throw new Error("edge_unavailable");
  await fs.mkdir(profileDir, { recursive: true });
  const proxy = await startSafetyProxy();
  const args = [
    "--disable-quic", "--disable-extensions", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--no-first-run", "--no-default-browser-check", "--mute-audio",
    "--autoplay-policy=user-gesture-required",
    `--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>",
    `--user-data-dir=${profileDir}`, "--new-window", targetUrl
  ];
  const edge = spawn(edgePath, args, { windowsHide: false, stdio: "ignore" });
  await new Promise((resolve) => { edge.once("close", resolve); edge.once("error", resolve); });
  await proxy.close();
}

run().catch(() => process.exitCode = 1);
