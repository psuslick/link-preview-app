import test from 'node:test';
import assert from 'node:assert/strict';
import { thumbnailCandidates, thumbnailSourceKey, previewHasUsableThumbnailCandidate, filterPreviewsByThumbnail } from '../client/src/preview-visibility.js';

const batch = [
  { id: 'a', state: 'ready', image: 'https://cdn.test/a.jpg' },
  { id: 'b', state: 'ready', image: null, images: [] },
  { id: 'c', state: 'ready', images: ['https://cdn.test/c.jpg'] },
  { id: 'd', state: 'failed', images: [] },
  { id: 'e', state: 'queued', image: null },
  { id: 'f', state: 'loading', image: 'https://cdn.test/f.jpg' },
];

test('filter defaults off and does not mutate or delete records', () => {
  const all = filterPreviewsByThumbnail(batch, false);
  assert.equal(all, batch);
  assert.equal(batch.length, 6);
});

test('filter only displays finished links with candidate thumbnails', () => {
  assert.deepEqual(filterPreviewsByThumbnail(batch, true).map(p => p.id), ['a','c']);
  assert.equal(batch.length, 6);
});

test('failed image proxy candidates disappear until retried or source changes', () => {
  const failed = { a: thumbnailSourceKey(['https://cdn.test/a.jpg']) };
  assert.deepEqual(filterPreviewsByThumbnail(batch, true, failed).map(p => p.id), ['c']);
  assert.equal(previewHasUsableThumbnailCandidate({ id: 'a', state: 'ready', image: 'https://cdn.test/new.jpg' }, failed), true);
  assert.equal(previewHasUsableThumbnailCandidate({ id: 'a', state: 'ready', image: 'https://cdn.test/a.jpg' }, {}), true);
});

test('disabling remote images does not claim thumbnails can be displayed', () => {
  assert.deepEqual(filterPreviewsByThumbnail(batch, true, {}, false), []);
});

test('candidate sets deduplicate without filtering unfamiliar public image hosts', () => {
  assert.deepEqual(thumbnailCandidates(['https://unknown.test/a.jpg', null, 'https://unknown.test/a.jpg', 'https://second.test/b.jpg']), ['https://unknown.test/a.jpg', 'https://second.test/b.jpg']);
});

test('status or UI re-renders do not change stable candidate identity', () => {
  assert.equal(thumbnailSourceKey(['https://cdn.test/a.jpg']), thumbnailSourceKey(['https://cdn.test/a.jpg']));
  assert.notEqual(thumbnailSourceKey(['https://cdn.test/a.jpg']), thumbnailSourceKey(['https://cdn.test/b.jpg']));
});
