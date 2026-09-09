import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = 8888;
const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 12_000;
const HEALTH_INTERVAL_MS = 250;

let child = null;
let startPromise = null;
let lastStart = {
  state: "not_started",
  root: null,
  pythonPath: null,
  settingsPath: null,
  startedAt: null,
  readyAt: null,
  error: null
};

function candidateRoots() {
  const out = [];
  if (process.env.SEARXNG_WINDOWS_ROOT) out.push(process.env.SEARXNG_WINDOWS_ROOT);
  const profile = process.env.USERPROFILE || path.join("C:\\Users", "WDAGUtilityAccount");
  const desktopBootstrap = path.join(profile, "Desktop", "SandboxBootstrap");
  const directBootstrap = "C:\\SandboxBootstrap";
  for (const base of [desktopBootstrap, directBootstrap]) {
    out.push(
      path.join(base, "searxng-windows"),
      path.join(base, "SearXNGforWindows"),
      path.join(base, "SearXNGforWindows-main")
    );
  }
  return [...new Set(out.map((p) => path.resolve(p)))];
}

function runtimeAt(root) {
  const pythonPath = path.join(root, "python", "python.exe");
  const webappPath = path.join(root, "python", "Lib", "site-packages", "searx", "webapp.py");
  return fs.existsSync(pythonPath) && fs.existsSync(webappPath) ? { root, pythonPath, webappPath } : null;
}

export function locateLocalSearxngRuntime() {
  for (const root of candidateRoots()) {
    const runtime = runtimeAt(root);
    if (runtime) return runtime;
  }
  return null;
}

function settingsYaml(secret) {
  // Bing is intentionally disabled here. Link Preview uses its separate verified
  // Bing Edge session so SearXNG cannot silently fall back to Bing Moderate.
  return `use_default_settings: true

general:
  debug: false
  instance_name: "Link Preview SearXNG"
  enable_metrics: false

search:
  safe_search: 0
  autocomplete: ""
  default_lang: ""
  formats:
    - html
    - json

server:
  port: ${PORT}
  bind_address: "${HOST}"
  secret_key: "${secret}"
  limiter: false
  public_instance: false
  image_proxy: false
  method: "GET"

outgoing:
  request_timeout: 6.0
  max_request_timeout: 12.0

engines:
  # Bing is kept out of local SearXNG because Link Preview maintains a
  # separately verified Bing SafeSearch-Off browser session.
  - name: bing
    disabled: true
  - name: bing videos
    disabled: true

  # Broad independent general indexes.
  - name: brave
    disabled: false
  - name: duckduckgo
    disabled: false
  - name: google
    disabled: false
  - name: mojeek
    disabled: false
  - name: qwant
    disabled: false
  - name: startpage
    disabled: false
  - name: yahoo
    disabled: false
  - name: wiby
    disabled: false

  # Video-oriented discovery. Unknown/obscure candidate hosts are still
  # accepted later by Link Preview's generic media-probe pipeline.
  - name: brave.videos
    disabled: false
  - name: google videos
    disabled: false
  - name: qwant videos
    disabled: false
  - name: duckduckgo videos
    disabled: false
  - name: dailymotion
    disabled: false
  - name: bilibili
    disabled: false
  - name: bitchute
    disabled: false
  - name: odysee
    disabled: false
  - name: peertube
    disabled: false
  - name: rumble
    disabled: false
  - name: sepiasearch
    disabled: false
  - name: vimeo
    disabled: false
  - name: youtube
    disabled: false
  - name: niconico
    disabled: false
  - name: sogou videos
    disabled: false
`;
}

async function isHealthy(timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${HOST}:${PORT}/config`, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data && typeof data === "object");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function createSandboxSettings() {
  const dir = path.join(os.tmpdir(), "link-preview-searxng");
  await fsp.mkdir(dir, { recursive: true });
  const settingsPath = path.join(dir, "settings.yml");
  const secret = crypto.randomBytes(32).toString("hex");
  await fsp.writeFile(settingsPath, settingsYaml(secret), "utf8");
  return settingsPath;
}

async function waitUntilHealthy(timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    if (child && child.exitCode !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
  }
  return false;
}

export async function ensureLocalSearxng() {
  if (await isHealthy()) {
    lastStart = { ...lastStart, state: "ready", readyAt: lastStart.readyAt || Date.now(), error: null };
    return { ok: true, alreadyRunning: true, ...lastStart };
  }
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const runtime = locateLocalSearxngRuntime();
    if (!runtime) {
      lastStart = {
        state: "package_missing",
        root: null,
        pythonPath: null,
        settingsPath: null,
        startedAt: null,
        readyAt: null,
        error: "local_searxng_package_not_found"
      };
      return { ok: false, ...lastStart };
    }

    const settingsPath = await createSandboxSettings();
    lastStart = {
      state: "starting",
      root: runtime.root,
      pythonPath: runtime.pythonPath,
      settingsPath,
      startedAt: Date.now(),
      readyAt: null,
      error: null
    };

    const env = {
      ...process.env,
      SEARXNG_SETTINGS_PATH: settingsPath,
      SEARXNG_DISABLE_ETC_SETTINGS: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), "link-preview-searxng", "pycache"),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    };

    child = spawn(runtime.pythonPath, [runtime.webappPath], {
      cwd: runtime.root,
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.once("exit", (code, signal) => {
      if (lastStart.state !== "ready") {
        lastStart = {
          ...lastStart,
          state: "failed",
          error: `searxng_process_exit_${code ?? "null"}_${signal || "none"}${stderrTail ? `: ${stderrTail.trim().slice(-1200)}` : ""}`
        };
      }
      child = null;
    });
    child.once("error", (error) => {
      lastStart = { ...lastStart, state: "failed", error: error?.message || "searxng_spawn_failed" };
    });

    const ready = await waitUntilHealthy();
    if (!ready) {
      const error = lastStart.error || (child?.exitCode !== null ? `searxng_process_exit_${child?.exitCode}` : "searxng_start_timeout");
      lastStart = { ...lastStart, state: "failed", error };
      return { ok: false, ...lastStart };
    }

    lastStart = { ...lastStart, state: "ready", readyAt: Date.now(), error: null };
    return { ok: true, ...lastStart };
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function localSearxngRuntimeStatus({ autostart = false } = {}) {
  const runtime = locateLocalSearxngRuntime();
  const healthy = await isHealthy();
  if (healthy) return { ok: true, healthy: true, packageFound: Boolean(runtime), ...lastStart };
  if (autostart && runtime) {
    const started = await ensureLocalSearxng();
    return { healthy: Boolean(started.ok), packageFound: true, ...started };
  }
  return {
    ok: false,
    healthy: false,
    packageFound: Boolean(runtime),
    root: runtime?.root || null,
    state: runtime ? lastStart.state : "package_missing",
    error: runtime ? (lastStart.error || "searxng_not_running") : "local_searxng_package_not_found"
  };
}

function stopChild() {
  try { child?.kill(); } catch {}
}
process.once("exit", stopChild);
process.once("SIGINT", () => { stopChild(); process.exit(0); });
process.once("SIGTERM", () => { stopChild(); process.exit(0); });
