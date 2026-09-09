const debugPort = Number(process.argv[2] || 0);

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
  async function send(method, params = {}, timeoutMs = 4000) {
    await opened;
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`devtools_${method.replace(/\W+/g, '_').toLowerCase()}_timeout`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return { opened, send, close() { try { ws.close(); } catch {} } };
}

function decodeValue(value) {
  const raw = String(value || '');
  try { return decodeURIComponent(raw.replace(/\+/g, '%20')); } catch { return raw; }
}

function safeSearchFromCookies(cookies) {
  const bingCookies = (cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
    return domain === 'bing.com' || domain.endsWith('.bing.com');
  });
  const corpus = bingCookies.map((cookie) => `${cookie.name}=${decodeValue(cookie.value)}`).join('; ');
  if (/\bADLT\s*=\s*OFF\b/i.test(corpus)) return { state: 'off', evidence: 'Bing cookie ADLT=OFF' };
  if (/\bADLT\s*=\s*(?:STRICT|S)\b/i.test(corpus)) return { state: 'strict', evidence: 'Bing cookie indicates Strict' };
  if (/\bADLT\s*=\s*(?:DEMOTE|MODERATE|M)\b/i.test(corpus)) return { state: 'moderate', evidence: 'Bing cookie indicates Moderate' };
  return { state: 'unverified', evidence: bingCookies.length ? 'Bing cookies present but no verifiable ADLT state' : 'No Bing session cookie found' };
}

try {
  if (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) throw new Error('invalid_debug_port');
  const wsUrl = await getBrowserWebSocketUrl();
  const cdp = connectCdp(wsUrl);
  await cdp.opened;
  const result = await cdp.send('Storage.getCookies', {}, 4000);
  const parsed = safeSearchFromCookies(result.cookies || []);
  cdp.close();
  process.stdout.write(JSON.stringify({ ok: true, ...parsed, cookieCount: (result.cookies || []).length }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, state: 'unverified', evidence: null, error: error?.message || 'bing_state_probe_failed' }));
}
