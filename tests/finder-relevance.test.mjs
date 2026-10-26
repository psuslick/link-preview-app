import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCandidateEvidence } from "../server/finder-relevance.js";

const run = (overrides = {}) => evaluateCandidateEvidence({
  sourceTitle: "Blue Winter Journey Through Forest",
  candidateTitle: "Blue Winter Journey Through Forest - reuploaded",
  titleVerified: true,
  sourceDuration: 300,
  candidateDuration: 302,
  overlap: {}, ...overrides
});

test("a scraped search snippet cannot impersonate page-confirmed video identity", () => {
  const lead = run({ titleVerified: false, searchSupport: { engineCount: 4, queryCount: 9 } });
  assert.equal(lead.related, false);
  assert.match(lead.relation, /Weak lead/);
});

test("verified distinctive title matches can appear as possible, not likely mirrors", () => {
  const result = run();
  assert.equal(result.related, true);
  assert.match(result.relation, /^Possible match/);
  assert.ok(result.matchedTitleTokens.length >= 3);
});

test("shared media ID with measured duration supports a likely longer version", () => {
  const result = run({ titleVerified: false, candidateTitle: "unrelated words", candidateDuration: 680, overlap: { matchedIds: ["rare-video-id"] } });
  assert.equal(result.related, true);
  assert.equal(result.relation, "Likely longer");
});

test("generic one-word title matches and shared host alone cannot count as matches", () => {
  assert.equal(run({ candidateTitle: "Blue unrelated video", overlap: { sharedMediaHost: true } }).related, false);
  assert.equal(run({ sourceTitle: "Movie", candidateTitle: "Movie", overlap: {} }).related, false);
});
