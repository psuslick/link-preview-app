import { BROWSER_POSTER_SNAPSHOT, appendLivePosterHints } from "./browser-poster-hints.js";
import { hasPosterEvidence } from "./preview-browser-policy.js";

const targetUrl = process.argv[2];
const debugPort = Number(process.argv[3] || 0);
const domLimit = Math.max(256 * 1024, Number(process.argv[4] || 2 * 1024 * 1024));

async function getBrowserWebSocketUrl() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1800) });
  if (!response.ok) throw new Error(`devtools_status_${response.status}`);
  const payload = await response.json();
  if (!payload?.webSocketDebuggerUrl) throw new Error('devtools_browser_socket_missing');
  return payload.webSocketDebuggerUrl;
}

function connectCdp(wsUrl) {
  if (typeof WebSocket !== 'function') throw new Error('websocket_api_unavailable');
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  let openedResolve;
  let openedReject;
  const opened = new Promise((resolve, reject) => { openedResolve = resolve; openedReject = reject; });

  ws.addEventListener('open', () => openedResolve());
  ws.addEventListener('error', () => openedReject(new Error('devtools_websocket_error')));
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data || '{}')); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message || 'devtools_command_failed'));
    else item.resolve(message.result || {});
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('devtools_socket_closed'));
    }
    pending.clear();
  });

  async function send(method, params = {}, sessionId = null, timeoutMs = 5000) {
    await opened;
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`devtools_${method.replace(/\W+/g, '_').toLowerCase()}_timeout`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }

  return { ws, opened, send, close() { try { ws.close(); } catch {} } };
}

async function inspectExactUrl(browserWsUrl) {
  const cdp = connectCdp(browserWsUrl);
  let targetId = null;
  try {
    await cdp.opened;
    const created = await cdp.send('Target.createTarget', { url: 'about:blank', background: true }, null, 3000);
    targetId = created.targetId;
    if (!targetId) throw new Error('authorized_target_create_failed');

    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, null, 3000);
    const sessionId = attached.sessionId;
    if (!sessionId) throw new Error('authorized_target_attach_failed');

    await cdp.send('Page.enable', {}, sessionId, 2500).catch(() => {});
    await cdp.send('Runtime.enable', {}, sessionId, 2500).catch(() => {});
    await cdp.send('Page.navigate', { url: targetUrl }, sessionId, 4000);

    // A completed document may still show a blank player: poster assets and
    // player-state metadata are often populated several seconds afterward.
    // Poll only the already approved browser profile, with a hard time budget.
    const deadline = Date.now() + 7500;
    let best = null;
    let sampleCount = 0;
    while (Date.now() < deadline) {
      sampleCount += 1;
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: BROWSER_POSTER_SNAPSHOT,
        returnByValue: true
      }, sessionId, 1600).catch(() => null);
      const value = evaluated?.result?.value || {};
      const html = appendLivePosterHints(value.html, value.posterHints);
      if (html && Buffer.byteLength(html) > domLimit) throw new Error('devtools_dom_too_large');
      if (html) best = { html, pageUrl: value.pageUrl || targetUrl, title: value.title || null, sampleCount };
      // Do not accept document.readyState alone as evidence of a ready player.
      if (sampleCount >= 2 && hasPosterEvidence(html)) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    if (!best?.html) throw new Error('devtools_empty_dom');
    return best;
  } finally {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }, null, 1800).catch(() => {});
    cdp.close();
  }
}

try {
  if (!targetUrl || !Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) throw new Error('invalid_arguments');
  const browserWsUrl = await getBrowserWebSocketUrl();
  const result = await inspectExactUrl(browserWsUrl);
  process.stdout.write(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message || 'authorized_session_probe_failed' }));
}
