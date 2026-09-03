const targetUrl = process.argv[2];
const debugPort = Number(process.argv[3] || 0);
const domLimit = Math.max(256 * 1024, Number(process.argv[4] || 2 * 1024 * 1024));

function hostOf(raw) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return ""; }
}

async function getTargets() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1800) });
  if (!response.ok) throw new Error(`devtools_status_${response.status}`);
  return await response.json();
}

function chooseTarget(targets) {
  const wantedHost = hostOf(targetUrl);
  const pages = (Array.isArray(targets) ? targets : []).filter((item) => item?.type === "page" && item?.webSocketDebuggerUrl);
  return pages.find((item) => hostOf(item.url) === wantedHost)
    || pages.find((item) => item.url && !String(item.url).startsWith("devtools://"))
    || null;
}

async function evaluateHtml(wsUrl) {
  if (typeof WebSocket !== "function") throw new Error("websocket_api_unavailable");
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("devtools_eval_timeout")), 3000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression: "document.documentElement ? document.documentElement.outerHTML : ''",
          returnByValue: true,
          awaitPromise: false
        }
      }));
    });
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data || "{}"));
        if (message.id !== id) return;
        if (message.error) return finish(reject, new Error(message.error.message || "devtools_eval_failed"));
        const html = String(message?.result?.result?.value || "");
        if (!html) return finish(reject, new Error("devtools_empty_dom"));
        if (Buffer.byteLength(html) > domLimit) return finish(reject, new Error("devtools_dom_too_large"));
        finish(resolve, html);
      } catch (error) {
        finish(reject, error);
      }
    });
    ws.addEventListener("error", () => finish(reject, new Error("devtools_websocket_error")));
  });
}

try {
  if (!targetUrl || !Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) throw new Error("invalid_arguments");
  const targets = await getTargets();
  const target = chooseTarget(targets);
  if (!target) throw new Error("authorized_page_not_found");
  const html = await evaluateHtml(target.webSocketDebuggerUrl);
  process.stdout.write(JSON.stringify({ ok: true, html, pageUrl: target.url || null, title: target.title || null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message || "authorized_session_probe_failed" }));
}
