import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceRamStore } from '../server/workspace-ram-store.js';
import { buildSafePreviewDiagnosticReport } from '../client/src/safe-preview-diagnostics.js';

test('workspace snapshots live in process memory and preserve selection/video previews', () => {
  const store = new WorkspaceRamStore({ maxBytes: 10_000 });
  const payload = { schema: 1, previews: [{ id: '1', url: 'https://sample.invalid/private/XYz?secret=TOPSECRET', image: 'https://sample.invalid/poster.jpg' }], finderJobs: [], selectedIds: ['1'] };
  const saved = store.save(payload, 0);
  assert.equal(saved.ok, true);
  assert.deepEqual(store.read().state, payload);
  const newProcess = new WorkspaceRamStore();
  assert.equal(newProcess.read().state, null);
});

test('workspace state rejects oversized or malformed payloads', () => {
  const store = new WorkspaceRamStore({ maxBytes: 500 });
  assert.equal(store.save({ schema: 1, previews: [{}], finderJobs: [] }, 0).ok, true);
  assert.equal(store.save({ schema: 1, previews: [], finderJobs: [] }, 0).status, 409);
  assert.equal(store.save({ schema: 1, previews: [], finderJobs: ["z".repeat(1500)] }, 1).status, 413);
  assert.equal(store.save({ schema: 1, previews: null, finderJobs: [] }, 1).status, 400);
});

test('diagnostics never serialize private link fields, content, raw errors or domain names', () => {
  const sensitive = 'DO_NOT_LEAK_PRIVATE_URL_TOKEN';
  const result = buildSafePreviewDiagnosticReport({
    previews: [{
      url: `https://${sensitive}.invalid/${sensitive}`, title: sensitive, description: sensitive,
      error: sensitive, method: sensitive, provider: sensitive, warning: sensitive,
      clientNetworkError: sensitive, browserFallbackError: sensitive, browserFallbackSkippedReason: sensitive,
      image: null, images: [], state: 'ready', upstreamStatus: 200,
      browserFallbackQueued: true, manualVerificationRequired: true, clientMs: 156
    }],
    networkState: { dns: { lastError: sensitive, queued: 2 }, http: { active: 1 }, traffic: { note: sensitive, backendResponseBytesTotal: 1000 } },
    workspaceLoaded: true, capturedAt: new Date('2026-10-27T12:00:00.000Z')
  });
  assert.equal(result.includes(sensitive), false);
  assert.equal(result.includes('http200NoThumb: 1'), true);
  assert.equal(result.includes('fallbackQueued: 1'), true);
  assert.equal(result.includes('Capture time: 2026-10-27T12:00:00.000Z'), true);
  assert.equal(result.includes('https://'), false);
});
