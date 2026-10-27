import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySafeBrowserFailure, buildSafePreviewDiagnosticReport } from '../client/src/safe-preview-diagnostics.js';

test('fixed categories distinguish browser availability, timeout, renderer and access failures', () => {
  assert.equal(classifySafeBrowserFailure('edge_fallback_unavailable'), 'unavailable');
  assert.equal(classifySafeBrowserFailure('passive_browser_timeout'), 'timeout');
  assert.equal(classifySafeBrowserFailure('debugger_socket_missing'), 'debugger');
  assert.equal(classifySafeBrowserFailure('edge_empty_dom_1'), 'empty_dom');
  assert.equal(classifySafeBrowserFailure('edge_challenge_page'), 'challenge');
  assert.equal(classifySafeBrowserFailure('browser_dom_too_large'), 'resource_limit');
  assert.equal(classifySafeBrowserFailure('some arbitrary details'), 'other');
  assert.equal(classifySafeBrowserFailure(''), 'none');
});

test('report separates upstream statuses and backend fallback attempts without copying content', () => {
  const secret = 'SECRET_UNIQUE_SOURCE_ABC123';
  const previews = [
    { url: `https://${secret}.invalid/1`, title: secret, browserFallbackError: 'edge_fallback_unavailable', browserFallbackAttempted: true, upstreamStatus: 200, state: 'ready' },
    { url: `https://${secret}.invalid/2`, description: secret, browserFallbackError: 'edge_helper_timeout', browserFallbackAttempted: true, upstreamStatus: 403, state: 'ready' },
    { url: `https://${secret}.invalid/3`, browserFallbackError: secret, browserFallbackAttempted: true, upstreamStatus: 503, state: 'ready' },
    { url: `https://${secret}.invalid/4`, browserFallbackError: 'edge_challenge_page', browserFallbackAttempted: false, upstreamStatus: 404, state: 'ready' },
    { url: `https://${secret}.invalid/5`, image: `https://${secret}.invalid/img`, upstreamStatus: 200, state: 'ready' }
  ];
  const report = buildSafePreviewDiagnosticReport({ previews, capturedAt: new Date('2026-10-27T15:47:50.891Z') });
  assert.match(report, /fallbackAttemptedWithoutImage: 3/);
  assert.match(report, /fallbackNotAttemptedWithoutImage: 1/);
  assert.match(report, /fallbackFailure_unavailable: 1/);
  assert.match(report, /fallbackFailure_timeout: 1/);
  assert.match(report, /fallbackFailure_other: 1/);
  assert.match(report, /missing_http200: 1/);
  assert.match(report, /missing_http401_403: 1/);
  assert.match(report, /missing_http404_410: 1/);
  assert.match(report, /missing_http429_503: 1/);
  assert.equal(report.includes(secret), false);
  assert.equal(report.includes('https://'), false);
});
