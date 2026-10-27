import test from 'node:test';
import assert from 'node:assert/strict';
import { passiveBrowserNeeded, outboundRequestSpacingMs } from '../server/preview-runtime-policy.js';

test('HTTP 200 without thumbnail requests a bounded passive browser pass', () => {
  assert.equal(passiveBrowserNeeded({ httpOk: true, hasImage: false }), true);
  assert.equal(passiveBrowserNeeded({ httpOk: true, hasImage: true }), false);
});
test('recognized site verification remains manual without an approved session', () => {
  assert.equal(passiveBrowserNeeded({ httpOk: true, verification: true }), false);
  assert.equal(passiveBrowserNeeded({ httpOk: true, verification: true, approvedSession: true }), true);
});
test('anti-bot interstitial only uses a pre-approved session', () => {
  assert.equal(passiveBrowserNeeded({ challenge: true, httpOk: true }), false);
  assert.equal(passiveBrowserNeeded({ challenge: true, approvedSession: true }), true);
});
test('restricted status can attempt passive metadata with no prior verification', () => {
  assert.equal(passiveBrowserNeeded({ restrictedStatus: true }), true);
});
test('DNS pressure slows down all backend request starts', () => {
  assert.equal(outboundRequestSpacingMs('normal'), 180);
  assert.ok(outboundRequestSpacingMs('elevated') > outboundRequestSpacingMs('normal'));
  assert.ok(outboundRequestSpacingMs('throttled') > outboundRequestSpacingMs('elevated'));
});
