import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const targetUrl = process.argv[2];
const EDGE_TIMEOUT_MS = Math.max(4000, Number(process.argv[3]) || 7000);
const GLOBAL_LIMIT = Math.max(1, Number(process.argv[4]) || 8);
const PER_HOST_LIMIT = Math.max(1, Number(process.argv[5]) || 4);
const DOM_LIMIT_BYTES = Math.max(256 * 1024, Number(process.argv[6]) || 2 * 1024 * 1024);
const HTTP_RESOURCE_LIMIT_BYTES = 4 * 1024 * 1024;
const AUTH_PROFILE_DIR = process.argv[7] || null;

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
          this.waiters.shift()?.();
        });
      };
      if (this.active < this.limit) grant();
      else this.waiters.push(grant);
    });
  }
}

const globalGate = new Semaphore(GLOBAL_LIMIT);
const hostGates = new Map();
function hostGate(hostname) {
  const key = hostname.toLowerCase();
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
  const normalized = String(hostname || "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!normalized) throw new Error("missing_hostname");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".internal")
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

function isLikelyMediaPath(pathname = "") {
  return /\.(?:mp4|m4v|mov|webm|mkv|avi|mp3|m4a|aac|wav|flac|m3u8|mpd|ts)(?:$|[?#])/i.test(pathname);
}


function detectChallengePage(html = "") {
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
    "security check",
    "access denied"
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
  if (!strongTitle && !strongBody) return null;
  return { title: title || null, provider: lower.includes("cloudflare") || lower.includes("cf-chl-") ? "cloudflare" : null };
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
    } catch {}
  }
  return null;
}

async function startSafetyProxy() {
  const sockets = new Set();
  const proxy = http.createServer(async (req, res) => {
    let url;
    try {
      if (!["GET", "HEAD"].includes(req.method || "GET")) {
        res.writeHead(204); res.end(); return;
      }
      url = validateUrl(req.url);
      if (url.protocol !== "http:") throw new Error("proxy_http_only");
      if (isLikelyMediaPath(url.pathname)) {
        res.writeHead(204); res.end(); return;
      }
    } catch {
      res.writeHead(403); res.end("blocked"); return;
    }

    const hostname = url.hostname.toLowerCase();
    const releaseGlobal = await globalGate.acquire();
    const releaseHost = await hostGate(hostname).acquire();
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      releaseHost();
      releaseGlobal();
    };

    res.on("error", finalize);
    req.on("aborted", finalize);

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
        const contentType = String(upstreamRes.headers["content-type"] || "").toLowerCase();
        if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
          upstreamRes.destroy();
          if (!res.headersSent) res.writeHead(204);
          res.end();
          finalize();
          return;
        }
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        let bytes = 0;
        upstreamRes.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > HTTP_RESOURCE_LIMIT_BYTES) {
            upstreamRes.destroy();
            res.end();
          } else if (!res.destroyed) {
            res.write(chunk);
          }
        });
        upstreamRes.once("end", () => { if (!res.destroyed) res.end(); finalize(); });
        upstreamRes.once("error", () => { if (!res.destroyed) res.destroy(); finalize(); });
      });
      upstream.setTimeout(8000, () => upstream.destroy(new Error("proxy_timeout")));
      upstream.once("error", () => {
        if (!res.headersSent) res.writeHead(502);
        if (!res.destroyed) res.end();
        finalize();
      });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(403);
      res.end("blocked");
      finalize();
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
      let authority;
      try {
        authority = new URL(`http://${req.url}`);
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
          releaseHost();
          releaseGlobal();
        };

        const upstream = net.connect({ host: resolved.address, port, family: resolved.family });
        upstream.on("error", () => clientSocket.destroy());
        upstream.setTimeout(EDGE_TIMEOUT_MS + 4000, () => upstream.destroy());
        clientSocket.setTimeout(EDGE_TIMEOUT_MS + 4000, () => clientSocket.destroy());

        upstream.once("connect", () => {
          if (clientSocket.destroyed) { upstream.destroy(); finalize(); return; }
          clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: LinkPreviewSafeProxy\r\n\r\n");
          if (head?.length) upstream.write(head);
          clientSocket.pipe(upstream);
          upstream.pipe(clientSocket);
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
    server: proxy,
    port: typeof address === "object" && address ? address.port : null,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(() => resolve())).catch(() => {});
    }
  };
}

async function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
  } else {
    child.kill("SIGKILL");
  }
}

async function run() {
  validateUrl(targetUrl);
  const edgePath = await findEdgeExecutable();
  if (!edgePath) return { ok: false, error: "edge_fallback_unavailable" };

  const proxy = await startSafetyProxy();
  let profileDir = null;
  let edge = null;
  try {
    profileDir = AUTH_PROFILE_DIR || await fs.mkdtemp(path.join(os.tmpdir(), "link-preview-edge-helper-"));
    if (AUTH_PROFILE_DIR) await fs.mkdir(profileDir, { recursive: true });
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
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      "--proxy-bypass-list=<-loopback>",
      `--user-data-dir=${profileDir}`,
      "--window-size=1280,720",
      "--virtual-time-budget=2500",
      "--dump-dom",
      targetUrl
    ];

    const result = await new Promise((resolve) => {
      edge = spawn(edgePath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const output = [];
      const errors = [];
      let bytes = 0;
      let errorBytes = 0;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(async () => {
        await killTree(edge);
        finish({ ok: false, error: "edge_fallback_timeout" });
      }, EDGE_TIMEOUT_MS);

      edge.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > DOM_LIMIT_BYTES) {
          killTree(edge).finally(() => finish({ ok: false, error: "edge_dom_too_large" }));
          return;
        }
        output.push(chunk);
      });
      edge.stderr.on("data", (chunk) => {
        if (errorBytes >= 24 * 1024) return;
        const remaining = 24 * 1024 - errorBytes;
        const used = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        errorBytes += used.length;
        errors.push(used);
      });
      edge.once("error", (error) => finish({ ok: false, error: error?.message || "edge_launch_failed" }));
      edge.once("close", (code) => {
        if (settled) return;
        const html = Buffer.concat(output).toString("utf8");
        if (!html.trim()) {
          finish({
            ok: false,
            error: `edge_empty_dom_${code ?? "unknown"}`,
            diagnostic: Buffer.concat(errors).toString("utf8").slice(0, 1000)
          });
        } else {
          const challenge = detectChallengePage(html);
          if (challenge) {
            finish({
              ok: false,
              error: "edge_challenge_page",
              challenge: true,
              challengeTitle: challenge.title,
              challengeProvider: challenge.provider
            });
          } else {
            finish({ ok: true, html });
          }
        }
      });
    });
    return result;
  } finally {
    await killTree(edge).catch(() => {});
    await proxy.close().catch(() => {});
    if (profileDir && !AUTH_PROFILE_DIR) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  const result = await run();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message || "edge_helper_failed" }));
}
