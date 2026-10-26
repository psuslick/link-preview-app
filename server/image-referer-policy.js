function originReferer(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}/`;
  } catch { return null; }
}

export function imageRefererStrategies(imageUrl, sourceUrl = null) {
  const imageOrigin = originReferer(imageUrl);
  const sourceOrigin = sourceUrl ? originReferer(sourceUrl) : null;
  const strategies = [];

  // A full source URL may contain private path/query/fragment information.
  // Only the source's own origin is permitted to receive its full page URL.
  if (sourceUrl && sourceOrigin && sourceOrigin === imageOrigin) {
    strategies.push({
      name: "source-page",
      headers: {
        Referer: sourceUrl,
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-origin"
      }
    });
  }
  if (sourceOrigin && sourceOrigin !== sourceUrl) {
    strategies.push({ name: "source-origin", headers: { Referer: sourceOrigin } });
  }
  if (imageOrigin) strategies.push({ name: "image-origin", headers: { Referer: imageOrigin } });
  strategies.push({ name: "no-referrer", headers: {} });
  return strategies;
}
