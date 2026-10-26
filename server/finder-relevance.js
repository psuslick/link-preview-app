// A search engine's title/snippet tells us where to investigate, not whether
// the video itself matches. Only independently fetched page/tool metadata or
// shared media identifiers can move a lead into the main results list.
const STOP = new Set(["a", "an", "and", "are", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with", "video", "videos", "watch", "online", "free", "clip", "official", "full", "long", "version", "hd", "4k", "1080p", "720p", "stream", "streaming", "part"]);

export function distinctiveTitleTokens(text) {
  return [...new Set(String(text || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((token) => token.length >= 3 && !STOP.has(token) && !/^\d{1,3}$/.test(token)))];
}

export function evaluateCandidateEvidence({ sourceTitle, candidateTitle, titleVerified, overlap = {}, sourceDuration, candidateDuration, sourceHost, candidateHost, searchSupport = {} }) {
  const sourceWords = distinctiveTitleTokens(sourceTitle);
  const candidateWords = new Set(distinctiveTitleTokens(candidateTitle));
  const matchedTitleTokens = sourceWords.filter((token) => candidateWords.has(token));
  const tokenDice = sourceWords.length && candidateWords.size ? (2 * matchedTitleTokens.length) / (sourceWords.length + candidateWords.size) : 0;
  const distinctiveMatch = sourceWords.length >= 2 && matchedTitleTokens.length >= 2 && tokenDice >= 0.54;
  const strongTitleMatch = Boolean(titleVerified && distinctiveMatch);
  const matchedIds = overlap.matchedIds || [];
  const matchedFilenames = overlap.matchedFilenames || [];
  const strongIdentity = matchedIds.length > 0 || matchedFilenames.length > 0;
  const sourceSeconds = Number(sourceDuration) || 0;
  const candidateSeconds = Number(candidateDuration) || 0;
  const durationRatio = sourceSeconds > 0 && candidateSeconds > 0 ? candidateSeconds / sourceSeconds : null;
  const lexicalLongerHint = /\b(?:full|complete|extended|uncut|full[- ]?length|long(?:er)? version)\b/i.test(candidateTitle || "") && !/\b(?:full|complete|extended|uncut|full[- ]?length|long(?:er)? version)\b/i.test(sourceTitle || "");
  const provenanceBonus = Math.min(6, Math.max(0, (searchSupport.engineCount || 0) - 1) * 2 + Math.max(0, (searchSupport.queryCount || 0) - 1));
  let confidence = (strongTitleMatch ? tokenDice * 53 : 0) + (matchedIds.length ? 37 : 0) + (matchedFilenames.length ? 34 : 0) + provenanceBonus;
  if (durationRatio !== null && (strongTitleMatch || strongIdentity)) {
    if (durationRatio >= 1.15 || (durationRatio >= 0.88 && durationRatio <= 1.12)) confidence += 7;
  }
  if (overlap.sharedMediaHost && (strongTitleMatch || strongIdentity)) confidence += 2;
  confidence = Math.min(99, Math.round(confidence));
  const related = strongIdentity || strongTitleMatch;
  const differentSource = Boolean(sourceHost && candidateHost && sourceHost !== candidateHost);
  const reasons = [];
  if (matchedIds.length) reasons.push("shared media ID");
  if (matchedFilenames.length) reasons.push("shared media filename");
  if (strongTitleMatch) reasons.push("distinctive title words verified on candidate page");
  if (!related && !titleVerified) reasons.push("search title only; candidate page not verified");
  else if (!related) reasons.push("insufficient distinct identity evidence");
  let relation = "Weak lead — inspect raw results";
  if (strongIdentity && durationRatio !== null && durationRatio >= 1.15) relation = "Likely longer";
  else if (strongIdentity && durationRatio === null && lexicalLongerHint) relation = "Possible longer";
  else if (strongIdentity && (durationRatio === null || durationRatio >= 0.82 && durationRatio <= 1.18)) relation = "Likely mirror";
  else if (strongTitleMatch && durationRatio !== null && durationRatio >= 1.15) relation = "Possible longer";
  else if (related) relation = "Possible match — verify";
  return { related, relation, confidence, durationRatio, differentSource, lexicalLongerHint, strongIdentity, strongTitleMatch, matchedTitleTokens, tokenDice, provenanceBonus, relevanceReasons: reasons };
}
