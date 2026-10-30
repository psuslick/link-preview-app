// Client-only view eligibility. Filtering never removes records or triggers network activity.
export function thumbnailCandidates(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()))];
}

export function previewThumbnailSources(preview) {
  if (!preview) return [];
  return thumbnailCandidates(Array.isArray(preview.images) && preview.images.length
    ? preview.images : preview.image ? [preview.image] : []);
}

export function thumbnailSourceKey(sources) {
  return JSON.stringify(thumbnailCandidates(sources));
}

export function previewHasUsableThumbnailCandidate(preview, exhaustedKeys = {}, remoteImagesEnabled = true) {
  if (!remoteImagesEnabled) return false;
  // A queued/loading card is displaying a progress placeholder, not a thumbnail.
  if (preview?.state === "loading" || preview?.state === "queued") return false;
  const sources = previewThumbnailSources(preview);
  if (!sources.length) return false;
  return exhaustedKeys?.[preview.id] !== thumbnailSourceKey(sources);
}

export function filterPreviewsByThumbnail(previews, hideMissing, exhaustedKeys = {}, remoteImagesEnabled = true) {
  if (!hideMissing) return previews;
  return previews.filter((preview) => previewHasUsableThumbnailCandidate(preview, exhaustedKeys, remoteImagesEnabled));
}
