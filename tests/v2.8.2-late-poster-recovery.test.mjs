import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { BROWSER_POSTER_SNAPSHOT, appendLivePosterHints } from '../server/browser-poster-hints.js';
import { hasPosterEvidence } from '../server/preview-browser-policy.js';

function sampleDom(elements, html = '<html><body><main id="player"></main></body></html>') {
  return {
    title: 'Video', documentElement: { outerHTML: html },
    querySelectorAll(selector) {
      if (selector === 'video') return elements.video || [];
      if (selector === 'img') return elements.img || [];
      if (selector === '[class],[id],[style]') return elements.background || [];
      return [];
    }
  };
}
function evaluate(document) {
  return vm.runInNewContext(BROWSER_POSTER_SNAPSHOT, {
    document, URL, location: { href: 'https://example.test/watch/1' },
    getComputedStyle: el => ({ backgroundImage: el.backgroundImage || 'none' })
  });
}

test('browser read of a loaded document without a thumbnail must not end prematurely', () => {
  const initial = evaluate(sampleDom({}));
  assert.equal(initial.posterHints.length, 0);
  assert.equal(hasPosterEvidence(appendLivePosterHints(initial.html, initial.posterHints)), false);
  // Real poster state appears later without changing the page's readyState.
  const video = { poster: 'https://cdn.example.test/loaded.jpg' };
  const updated = evaluate(sampleDom({ video: [video] }));
  assert.deepEqual([...updated.posterHints], [video.poster]);
  assert.equal(hasPosterEvidence(appendLivePosterHints(updated.html, updated.posterHints)), true);
});

test('live img.currentSrc and CSS player cover can be read after hydration', () => {
  const loaded = {
    id: '', className: 'player-poster', alt: '', currentSrc: 'https://cdn.example.test/wide.webp',
    complete: true, naturalWidth: 640,
    closest: () => ({ className: 'player', id: '' }),
    getBoundingClientRect: () => ({ width: 640, height: 360 })
  };
  const cover = {
    id: 'player', className: 'video-preview', backgroundImage: 'url("https://cdn.example.test/still.jpg")',
    getBoundingClientRect: () => ({ width: 640, height: 360 })
  };
  const snapshot = evaluate(sampleDom({ img: [loaded], background: [cover] }));
  assert.deepEqual([...snapshot.posterHints], [loaded.currentSrc, 'https://cdn.example.test/still.jpg']);
  const enriched = appendLivePosterHints(snapshot.html, snapshot.posterHints);
  assert.match(enriched, /wide\.webp/);
  assert.match(enriched, /still\.jpg/);
});

test('live-image candidates exclude credentials, opaque resource schemes and media payloads', () => {
  const enriched = appendLivePosterHints('<html></html>', [
    'javascript:alert(1)', 'http://user:pass@example.org/poster.png',
    'data:image/png;base64,abc', 'https://example.org/movie.mp4',
    'https://cdn.example.org/ok.png?x=1&y=2', 'https://cdn.example.org/ok.png?x=1&y=2'
  ]);
  assert.equal((enriched.match(/<video poster=/g) || []).length, 1);
  assert.match(enriched, /x=1&amp;y=2/);
  assert.equal(enriched.includes('javascript:'), false);
  assert.equal(enriched.includes('user:pass'), false);
});

test('authorized-session page inspection waits for poster evidence rather than readyState', () => {
  const src = fs.readFileSync(new URL('../server/edge-session-probe.js', import.meta.url), 'utf8');
  assert.match(src, /sampleCount >= 2 && hasPosterEvidence\(html\)/);
  assert.doesNotMatch(src, /document\.readyState\s*===\s*'complete'\)\s*\{/);
  assert.match(src, /Date\.now\(\) \+ 7500/);
});
