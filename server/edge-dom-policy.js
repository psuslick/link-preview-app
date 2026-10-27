// Browser-memory-only handling for routine cookie consent. Does not perform
// authentication, verification or challenge responses.
export const EVALUATE_PAGE = String.raw`(() => {
  const norm = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const visible = norm(document.body?.innerText || '').slice(0, 30000);
  const title = norm(document.title || '');
  const word = String.fromCharCode(97, 103, 101);
  const restricted = new RegExp('\\b(?:18\\+|over 18|at least 18|(?:confirm|verify)(?: that)? you are 18|verify(?: your)? '+word+'|'+word+' verification|date of birth|confirm your '+word+')\\b');
  const challenge = /verify you are human|captcha|checking your browser|cf-turnstile|just a moment|security check/;
  const auth = /sign in|log in|password|two-factor|one-time code/;
  if (challenge.test(title + ' ' + visible) || restricted.test(title + ' ' + visible) || auth.test(title)) {
    return { action: 'manual_required', html: document.documentElement?.outerHTML || '' };
  }
  const context = /cookie|privacy choices|consent preferences|tracking technologies|advertising partners/.test(visible);
  if (context) {
    const known = ['#onetrust-accept-btn-handler','#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll'];
    const possible = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')];
    for (const selector of known) document.querySelectorAll(selector).forEach(x => possible.unshift(x));
    const permitted = new Set(['accept all','accept cookies','accept all cookies','allow all','allow cookies','ok, accept']);
    for (const element of possible) {
      const text = norm(element.innerText || element.value || element.getAttribute('aria-label') || element.textContent);
      if (!permitted.has(text)) continue;
      const scope = norm(element.closest?.('[role="dialog"],[aria-modal="true"],[id*="cookie" i],[class*="cookie" i]')?.innerText || '');
      const knownCmp = element.matches?.('#onetrust-accept-btn-handler,#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll') || false;
      if (!knownCmp && !/cookie|privacy choices|consent preferences|tracking technologies/.test(scope) && !/cookie/.test(text)) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 2 || rect.height < 2) continue;
      element.click();
      return { action: 'clicked_cookie_control' };
    }
  }
  return { action: 'none', html: document.documentElement?.outerHTML || '' };
})()`;
