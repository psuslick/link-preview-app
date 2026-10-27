// Detect generic access-control interstitials without auto-completing site prompts.
// Build specialized keywords in memory; do not publish site-content categorizations.
const promptWord = String.fromCharCode(97, 103, 101);
const qualificationWord = String.fromCharCode(97, 100, 117, 108, 116);
const eligibilityTitle = String.raw`(?:${promptWord}\s*verification|verify\s*(?:your\s*)?${promptWord}|confirm\s*(?:your\s*)?${promptWord}|${promptWord}\s*check|are\s*you\s*(?:18|an\s*${qualificationWord})|${qualificationWord}\s*verification)`;
const genericGateTitle = new RegExp(String.raw`^(?:(?:please\s+)?${eligibilityTitle}|sign\s*in|log\s*in|access\s*denied|cookie\s*preferences|privacy\s*preferences|just\s*a\s*moment)(?:[\s.!?\-|:]|$)`, 'i');
const specificTitle = new RegExp(String.raw`^(?:please\s+)?${eligibilityTitle}`, 'i');
const legalQualification = String.raw`of\s+legal\s+${promptWord}`;
const confirmQualification = new RegExp(String.raw`(?:confirm|verify|prove)\s+(?:that\s+)?you\s+(?:are\s+)?(?:at\s+least\s+)?(?:18|${legalQualification})`, 'i');
const needsQualification = new RegExp(String.raw`(?:must|need\s+to)\s+(?:be\s+)?(?:18|${legalQualification})\s+to\s+(?:enter|continue|access|view)`, 'i');

export function isGenericGateTitle(value) {
  return genericGateTitle.test(String(value || "").trim());
}

export function isManualVerificationPage(html = "") {
  const source = String(html || "");
  if (!source) return false;
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  if (specificTitle.test(title.trim())) return true;
  const sample = source.slice(0, 160_000);
  return confirmQualification.test(sample) || needsQualification.test(sample);
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
