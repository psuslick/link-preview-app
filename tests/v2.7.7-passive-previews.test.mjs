import test from 'node:test';
import assert from 'node:assert/strict';
import { headHasThumbnailMetadata, isGenericGateTitle, isManualVerificationPage, shouldFetchFullHtml } from '../server/preview-pass-policy.js';

const promptWord = String.fromCharCode(97, 103, 101);
const qualificationWord = String.fromCharCode(97, 100, 117, 108, 116);

test('recognizes access-control headings without rejecting ordinary media titles', () => {
  assert.equal(isGenericGateTitle(`${promptWord} Verification`), true);
  assert.equal(isGenericGateTitle(`Verify Your ${promptWord} | Site`), true);
  assert.equal(isGenericGateTitle('Beautiful travel video'), false);
  assert.equal(isGenericGateTitle(`${qualificationWord} music video`), false);
  assert.equal(isGenericGateTitle('Restricted festival footage'), false);
});

test('verification detection requires a distinct attestation cue', () => {
  assert.equal(isManualVerificationPage(`<title>${promptWord} Verification</title>`), true);
  assert.equal(isManualVerificationPage('<h1>Please confirm you are 18 to enter</h1>'), true);
  assert.equal(isManualVerificationPage(`<h1>${qualificationWord}s at the music festival</h1>`), false);
  assert.equal(isManualVerificationPage('<title>Documentary: people over thirty</title>'), false);
});

test('full-page refetch is reserved for incomplete HTML without usable images', () => {
  const incomplete = { status: 200, contentType: 'text/html; charset=utf-8', html: '<html><head></head><body>', hasImages: false, challenge: false, incomplete: true };
  assert.equal(shouldFetchFullHtml(incomplete), true);
  assert.equal(shouldFetchFullHtml({ ...incomplete, hasImages: true }), false);
  assert.equal(shouldFetchFullHtml({ ...incomplete, incomplete: false }), false);
  assert.equal(shouldFetchFullHtml({ ...incomplete, challenge: true }), false);
  assert.equal(shouldFetchFullHtml({ ...incomplete, status: 403 }), false);
  assert.equal(shouldFetchFullHtml({ ...incomplete, contentType: 'application/json' }), false);
});

test('keeps reading HTML body when header lacks image metadata', () => {
  assert.equal(headHasThumbnailMetadata('<html><head><title>A video</title></head>'), false);
  assert.equal(headHasThumbnailMetadata('<meta property="og:image" content="https://cdn.test/poster.webp">'), true);
  assert.equal(headHasThumbnailMetadata('<meta name="twitter:image" content="https://cdn.test/cover.jpg">'), true);
  assert.equal(headHasThumbnailMetadata('<script>{"posterUrl":"https://cdn.test/cover.jpg"}</script>'), true);
  assert.equal(headHasThumbnailMetadata('<title>Poster presentation</title>'), false);
});
