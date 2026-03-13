import { extractMetadata } from "./extractMetadata.js";
import { extractVideoFrame } from "./extractVideoFrame.js";
import { screenshotPortable } from "./screenshotPortable.js";

export async function hybridPreview(url) {
  // 1. Metadata first
  const meta = await extractMetadata(url);
  if (meta) return { type: "metadata", thumbnail: meta };

  // 2. Raw video?
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(url)) {
    const frame = await extractVideoFrame(url);
    if (frame) return { type: "video-frame", thumbnail: frame };
  }

  // 3. Portable Chromium fallback
  const shot = await screenshotPortable(url);
  if (shot) return { type: "screenshot", thumbnail: shot };

  return { type: "none", thumbnail: null };
}