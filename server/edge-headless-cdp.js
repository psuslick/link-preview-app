import { EVALUATE_PAGE } from "./edge-dom-policy.js";
// Read a single public page in an isolated Sandbox Edge profile.
// Automatically handle only recognizable cookie/privacy consent controls.
// Never submit authentication, identity, verification, or challenge prompts.
const [targetUrl, rawPort, rawLimit] = process.argv.slice(2);
const debugPort = Number(rawPort);
const domLimit = Math.max(256 * 1024, Number(rawLimit) || 2 * 1024 * 1024);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpSocket() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('debugger_not_ready');
  const info = await response.json();
  if (!info.webSocketDebuggerUrl) throw new Error('debugger_socket_missing');
  if (typeof WebSocket !== 'function') throw new Error('websocket_api_unavailable');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  let counter = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('debugger_connection_failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    let value;
    try { value = JSON.parse(String(event.data)); } catch { return; }
    // Resource-type interception prevents a page from streaming large media
    // during a metadata-only headless inspection, even with opaque asset URLs.
    if (value?.method === 'Fetch.requestPaused' && value?.sessionId && value.params?.requestId) {
      ws.send(JSON.stringify({ id: ++counter, method: 'Fetch.failRequest', sessionId: value.sessionId, params: { requestId: value.params.requestId, errorReason: 'BlockedByClient' } }));
      return;
    }
    if (!value?.id || !pending.has(value.id)) return;
    const { timer, resolve, reject } = pending.get(value.id);
    pending.delete(value.id);
    clearTimeout(timer);
    if (value.error) reject(new Error(value.error.message || 'debugger_command_failed'));
    else resolve(value.result || {});
  });
  ws.addEventListener('close', () => {
    for (const { timer, reject } of pending.values()) {
      clearTimeout(timer); reject(new Error('debugger_closed'));
    }
    pending.clear();
  });
  return {
    async send(method, params = {}, sessionId = undefined, timeout = 2500) {
      await ready;
      const id = ++counter;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('debugger_command_timeout'));
        }, timeout);
        pending.set(id, { timer, resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() { try { ws.close(); } catch {} }
  };
}

// Site signals evaluated in browser memory only; no URL or page contents are logged.


async function collect() {
  if (!/^https?:\/\//i.test(targetUrl || '') || !Number.isInteger(debugPort) || debugPort <= 1023) throw new Error('invalid_arguments');
  const cdp = await cdpSocket();
  let targetId = null;
  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    targetId = created.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const session = attached.sessionId;
    if (!session) throw new Error('target_attach_failed');
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('Network.enable', {}, session).catch(() => {});
    await cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Media', requestStage: 'Request' }] }, session).catch(() => {});
    // Block media payloads, not unknown domains or HTML/API metadata.
    await cdp.send('Network.setBlockedURLs', { urls: ['*.mp4*','*.m4v*','*.webm*','*.m3u8*','*.mpd*','*.m4a*','*.mp3*','*.mov*'] }, session).catch(() => {});
    await cdp.send('Page.navigate', { url: targetUrl }, session, 3500);
    let action = 'none';
    let html = '';
    for (let i = 0; i < 9; i += 1) {
      await sleep(i === 0 ? 450 : 400);
      const evaluated = await cdp.send('Runtime.evaluate', { expression: EVALUATE_PAGE, returnByValue: true }, session, 2500).catch(() => null);
      const value = evaluated?.result?.value || {};
      action = value.action || 'none';
      if (action === 'clicked_cookie_control') { await sleep(500); continue; }
      html = String(value.html || '');
      if (action === 'manual_required') break;
      // Give asynchronous page scripts time to publish metadata and dialogs.
      if (i >= 3 && html.length > 500 && /<\/body\s*>/i.test(html)) break;
    }
    if (!html) throw new Error('empty_browser_dom');
    if (Buffer.byteLength(html) > domLimit) throw new Error('browser_dom_too_large');
    return { ok: true, html, consentHandling: action === 'manual_required' ? 'manual_required' : 'passive' };
  } finally {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }, null, 1500).catch(() => {});
    cdp.close();
  }
}

try { process.stdout.write(JSON.stringify(await collect())); }
catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error?.message || 'headless_dom_failed' })); }
