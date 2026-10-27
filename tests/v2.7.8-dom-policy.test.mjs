import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EVALUATE_PAGE } from '../server/edge-dom-policy.js';

function runPage(text, buttonLabel, panelText = '') {
  let clicked = false;
  let html = '<html><head><title>Test</title></head><body>Not ready</body></html>';
  const button = {
    innerText: buttonLabel,
    textContent: buttonLabel,
    value: '',
    getAttribute: () => null,
    matches: () => false,
    closest: () => panelText ? { innerText: panelText } : null,
    getBoundingClientRect: () => ({ width: 100, height: 25 }),
    click() { clicked = true; html = '<html><head><meta property="og:image" content="https://example.test/poster.jpg"></head><body>Ready</body></html>'; }
  };
  const document = {
    title: 'Test',
    body: { innerText: text },
    documentElement: { get outerHTML() { return html; } },
    querySelectorAll: (selector) => selector.includes('button') ? [button] : []
  };
  const result = vm.runInNewContext(EVALUATE_PAGE, { document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  return { result, clicked, html };
}

test('recognized cookie control may reveal a public poster', () => {
  const page = runPage('Cookie settings', 'Accept all cookies');
  assert.equal(page.clicked, true);
  assert.equal(page.result.action, 'clicked_cookie_control');
  assert.match(page.html, /og:image/);
});
test('unrelated generic confirmation is never auto-clicked', () => {
  const page = runPage('Some text and privacy choices in the footer', 'I agree');
  assert.equal(page.clicked, false);
});
test('explicit user verification takes priority over cookie controls', () => {
  const word = String.fromCharCode(97, 103, 101);
  const page = runPage(`Please verify your ${word} to continue. Cookie settings.`, 'Accept all cookies');
  assert.equal(page.clicked, false);
  assert.equal(page.result.action, 'manual_required');
});
