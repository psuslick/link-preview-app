// Consent/interstitial awareness and an intentionally bounded metadata-only retry.
// Never attempt to answer age challenges, authentication, or anti-bot checks.
const genericGateTitle = /^(?:(?:please\s+)?(?:age\s*verification|verify\s*(?:your\s*)?age|confirm\s*(?:your\s*)?age|age\s*check|are\s*you\s*(?:18|an\s*adult)|adult\s*verification)|sign\s*in|log\s*in|access\s*denied|cookie\s*preferences|privacy\s*preferences|just\s*a\s*moment)(?:[\s.!?\-|:]|$)/i;

export function isGenericGateTitle(value) {
  return genericGateTitle.test(String(value || "").trim());
}

export function isAgeVerificationPage(html = "") {
  const source = String(html || "");
  if (!source) return false;
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  // Mere adult-content words in a video title do not imply an age gate.
  if (/^(?:(?:please\s+)?(?:age\s*verification|verify\s*(?:your\s*)?age|confirm\s*(?:your\s*)?age|age\s*check|are\s*you\s*(?:18|an\s*adult)|adult\s*verification))/i.test(title.trim())) return true;
  const sample = source.slice(0, 160_000);
  return /(?:confirm|verify|prove)\s+(?:that\s+)?you\s+(?:are\s+)?(?:at\s+least\s+)?(?:18|of\s+legal\s+age)/i.test(sample) ||
    /(?:must|need\s+to)\s+(?:be\s+)?(?:18|of\s+legal\s+age)\s+to\s+(?:enter|continue|access|view)/i.test(sample);
}

// A real image hint in the header enables early return. Otherwise we keep
// streaming the original response into the body without a second HTTP request.
export function headHasThumbnailMetadata(headHtml = "") {
  return /(?:og:image|twitter:image|og:video:thumbnail|video:thumbnail|\bthumbnail(?:_?url)?\b\s*["']?\s*[:=]|\bposter(?:_?url)?\b\s*["']?\s*[:=]|rel\s*=\s*["']image_src["'])/i.test(String(headHtml || ""));
}

export function shouldFetchFullHtml({ status, contentType, html, hasImages, challenge, incomplete }) {
  if (challenge || hasImages || status !== 200 || !html || !incomplete) return false;
  const type = String(contentType || "").toLowerCase();
  if (type && !type.includes("html") && !type.includes("xhtml")) return false;
  // Second pass is rare: only when the first bounded read was incomplete and
  // lacked a poster; complete first-pass responses never get fetched twice.
  return /<\/head\s*>/i.test(html);
}
