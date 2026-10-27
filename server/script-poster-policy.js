// Generic public poster hints in inline JSON / JavaScript configuration.
// Only video-related property names are considered; no provider allowlist.
const posterKey = /(?:["']|\b)(?:thumbnail(?:Url|_url)?|thumb(?:Url|_url)|poster(?:Url|_url)?|posterImage(?:Url)?|cover(?:Image|Url|_image|_url)|preview(?:Image|_image)(?:Url|_url)?|imageUrl|image_url)(?:["']|\b)\s*:\s*(["'])([^"'<>]{4,2048})\1/gi;

export function inlinePosterUrls(script = "", limit = 80) {
  const text = String(script || "").slice(0, 1_500_000);
  const urls = [];
  const pattern = new RegExp(posterKey.source, posterKey.flags);
  for (const match of text.matchAll(pattern)) {
    urls.push(match[2]);
    if (urls.length >= limit) break;
  }
  return urls;
}
