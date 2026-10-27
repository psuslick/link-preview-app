import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingSiteRecoveryItems, recoveryFailureCount, siteRecoveryDelayMs } from '../client/src/site-recovery-policy.js';

const hostOf = url => new URL(url).hostname.replace(/^www\./, '').toLowerCase();
const missing = item => !item.image && item.state !== 'loading' && item.needsBrowserFallback;

test('approved-site queue includes every eligible link, not only first 12', () => {
  const items = [{ id: 'anchor', url: 'https://example.test/one', image: 'poster' }];
  for (let i = 0; i < 150; i++) items.push({ id: String(i), url: `https://example.test/watch/${i}`, needsBrowserFallback: true, state: 'ready' });
  const queue = pendingSiteRecoveryItems(items, 'example.test', 'anchor', hostOf, missing);
  assert.equal(queue.length, 150);
  assert.equal(queue[0].id, '0');
  assert.equal(queue[149].id, '149');
});

test('site queue does not silently expand across unrelated subdomains or revisit completed items', () => {
  const items = [
    { id: 'anchor', url: 'https://example.test/a', image: 'poster' },
    { id: '1', url: 'https://example.test/b', needsBrowserFallback: true, state: 'ready' },
    { id: '2', url: 'https://sub.example.test/c', needsBrowserFallback: true, state: 'ready' },
    { id: '3', url: 'https://example.test/d', image: 'poster', needsBrowserFallback: true, state: 'ready' },
    { id: '4', url: 'https://another.test/e', needsBrowserFallback: true, state: 'ready' }
  ];
  assert.deepEqual(pendingSiteRecoveryItems(items, 'example.test', 'anchor', hostOf, missing).map(x=>x.id), ['1']);
});

test('three consecutive failures pause; success resets failure count', () => {
  let failures = 0;
  failures = recoveryFailureCount(failures, false); assert.equal(failures, 1);
  failures = recoveryFailureCount(failures, false); assert.equal(failures, 2);
  failures = recoveryFailureCount(failures, true); assert.equal(failures, 0);
  failures = recoveryFailureCount(failures, false); assert.equal(failures, 1);
  assert.equal(siteRecoveryDelayMs(0), 850);
  assert.equal(siteRecoveryDelayMs(1), 1700);
  assert.equal(siteRecoveryDelayMs(2), 3400);
  assert.ok(siteRecoveryDelayMs(10) <= 5000);
});
