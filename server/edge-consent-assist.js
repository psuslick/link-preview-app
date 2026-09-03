const debugPort = Number(process.argv[2] || 0);
const targetUrl = process.argv[3] || "";
const RUN_MS = 18000;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function browserWs() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1800) });
  if (!response.ok) throw new Error(`devtools_status_${response.status}`);
  const payload = await response.json();
  if (!payload?.webSocketDebuggerUrl) throw new Error("devtools_browser_socket_missing");
  return payload.webSocketDebuggerUrl;
}

function connectCdp(wsUrl) {
  if (typeof WebSocket !== "function") throw new Error("websocket_api_unavailable");
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  let openResolve, openReject;
  const opened = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  ws.addEventListener("open", () => openResolve());
  ws.addEventListener("error", () => openReject(new Error("devtools_websocket_error")));
  ws.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data || "{}")); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message || "devtools_command_failed"));
    else item.resolve(message.result || {});
  });
  ws.addEventListener("close", () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("devtools_socket_closed")); }
    pending.clear();
  });
  async function send(method, params = {}, sessionId = null, timeoutMs = 3500) {
    await opened;
    const id = nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`devtools_${method.replace(/\W+/g, "_").toLowerCase()}_timeout`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }
  return { ws, opened, send, close() { try { ws.close(); } catch {} } };
}

const AUTO_SCRIPT = `(() => {
  const norm = v => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const bodyText = norm(document.body?.innerText || document.documentElement?.innerText || '');
  const title = norm(document.title || '');
  const challenge = /just a moment|verify you are human|checking your browser|security check|cf-turnstile|captcha/.test(title + ' ' + bodyText);
  const ageGate = /\\b(?:18\\+|over 18|at least 18|verify(?: your)? age|age verification|date of birth|adult content|confirm your age)\\b/.test(bodyText);
  const authGate = /\\b(?:sign in|log in|password|two-factor|2fa|one-time code)\\b/.test(bodyText);
  if (challenge) return { action: 'manual_challenge' };
  if (ageGate) return { action: 'manual_age_gate' };
  if (authGate) return { action: 'manual_auth_gate' };

  const cookieContext = /\b(?:cookie|cookies|privacy choices|consent preferences|tracking technologies|personalized ads|advertising partners)\b/.test(bodyText);
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button[data-testid*="accept" i]',
    'button[id*="accept" i]',
    'button[class*="accept" i]',
    '[role="button"][data-testid*="accept" i]'
  ];
  const allowedExact = new Set(['accept','accept all','accept cookies','accept all cookies','allow all','allow cookies','agree','i agree','consent','yes, i agree','ok, accept']);
  const allowedPattern = /^(?:accept(?: all)?(?: cookies)?|allow all(?: cookies)?|agree|i agree|consent)$/i;
  const candidates = [];
  const knownCmp = new Set();
  const add = (el, cmp = false) => { if (el && !candidates.includes(el)) candidates.push(el); if (el && cmp) knownCmp.add(el); };
  for (const selector of selectors) { try { document.querySelectorAll(selector).forEach(el => add(el, true)); } catch {} }
  document.querySelectorAll('button,input[type="button"],input[type="submit"],[role="button"]').forEach(el => add(el, false));

  for (const el of candidates) {
    const text = norm(el.innerText || el.value || el.getAttribute?.('aria-label') || el.textContent || '');
    if (!text || text.length > 80) continue;
    if (/18|age|adult|birth|captcha|verify|sign in|log in/.test(text)) continue;
    if (!allowedExact.has(text) && !allowedPattern.test(text)) continue;
    if (!knownCmp.has(el) && !cookieContext) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width < 2 || rect.height < 2) continue;
    el.click();
    return { action: 'clicked_consent', text };
  }

  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  const blurred = /blur\\(/i.test(rootStyle.filter || '') || /blur\\(/i.test(bodyStyle?.filter || '');
  return { action: 'none', blurred };
})()`;

async function assist() {
  if (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) return;
  let wsUrl = null;
  const start = Date.now();
  while (!wsUrl && Date.now() - start < 6000) {
    try { wsUrl = await browserWs(); } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  if (!wsUrl) return;
  const cdp = connectCdp(wsUrl);
  let reloaded = false;
  try {
    await cdp.opened;
    while (Date.now() - start < RUN_MS) {
      const targets = await cdp.send('Target.getTargets', {}, null, 2500).catch(() => ({ targetInfos: [] }));
      const pages = (targets.targetInfos || []).filter(t => t.type === 'page' && t.url && !t.url.startsWith('edge://') && !t.url.startsWith('about:'));
      let target = pages.find(t => {
        try { return new URL(t.url).hostname.replace(/^www\./,'') === new URL(targetUrl).hostname.replace(/^www\./,''); } catch { return false; }
      }) || pages[0];
      if (!target) { await new Promise(r => setTimeout(r, 500)); continue; }
      const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null, 2500).catch(() => null);
      if (!attached?.sessionId) { await new Promise(r => setTimeout(r, 500)); continue; }
      const sessionId = attached.sessionId;
      await cdp.send('Runtime.enable', {}, sessionId, 1800).catch(() => {});
      const evalResult = await cdp.send('Runtime.evaluate', { expression: AUTO_SCRIPT, returnByValue: true }, sessionId, 2500).catch(() => null);
      const value = evalResult?.result?.value || {};
      if (String(value.action || '').startsWith('manual_')) return;
      if (value.action === 'clicked_consent') {
        await new Promise(r => setTimeout(r, 900));
        continue;
      }
      if (value.blurred && !reloaded) {
        reloaded = true;
        await cdp.send('Page.reload', { ignoreCache: false }, sessionId, 2500).catch(() => {});
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
      await new Promise(r => setTimeout(r, 650));
    }
  } finally { cdp.close(); }
}

assist().catch(() => {});
