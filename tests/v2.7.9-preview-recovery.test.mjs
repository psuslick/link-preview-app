import test from "node:test";
import assert from "node:assert/strict";
import { shouldStopPassiveScan, hasPosterEvidence, shouldTryLegacyDomDump } from "../server/preview-browser-policy.js";
import { inlinePosterUrls } from "../server/script-poster-policy.js";
import { shouldContinueHostProbes } from "../client/src/preview-batch-policy.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const ui = fs.readFileSync(path.join(here, "../client/src/App.jsx"), "utf8");

test("fully loaded SPA shell without poster is not mistaken for completed preview", () => {
  assert.equal(hasPosterEvidence("<html><head><title>Page</title></head><body>loading</body></html>"), false);
  assert.equal(shouldStopPassiveScan({ iteration: 6, html: "<html><body>loading</body></html>" }), false);
});
test("fresh video poster evidence can stop passive scan early", () => {
  assert.equal(shouldStopPassiveScan({ iteration: 1, html: '<video poster="/preview.jpg"></video>' }), true);
  assert.equal(shouldStopPassiveScan({ iteration: 0, html: '<video poster="/preview.jpg"></video>' }), false);
  assert.equal(shouldStopPassiveScan({ iteration: 6, html: '<meta property="og:image" content="https://example.org/x.png">' }), true);
});
test("manual verification and cookie dialogs are handled without completing protected prompts", () => {
  assert.equal(shouldStopPassiveScan({ iteration: 1, action: "manual_required" }), true);
  assert.equal(shouldStopPassiveScan({ iteration: 1, action: "clicked_cookie_control", html: '<video poster="/x.jpg">' }), false);
});
test("legacy DOM dump is attempted only on local DevTools setup failures", () => {
  assert.equal(shouldTryLegacyDomDump(null), true);
  assert.equal(shouldTryLegacyDomDump({ok:false,error:'passive_browser_bad_output'}), true);
  assert.equal(shouldTryLegacyDomDump({ok:false,error:'passive_browser_timeout'}), false);
  assert.equal(shouldTryLegacyDomDump({ok:false,error:'edge_challenge_page',challenge:true}), false);
  assert.equal(shouldTryLegacyDomDump({ok:true}), false);
});
test("bulk importer probes multiple independent URLs per site before pausing fallback", () => {
  assert.match(ui, /HOST_FALLBACK_SAMPLE_LIMIT = 3/);
  assert.match(ui, /hostItems\.slice\(0, HOST_FALLBACK_SAMPLE_LIMIT\)/);
  assert.match(ui, /foundWorkingPublicPreview/);
  assert.match(ui, /same_host_public_probe_unresolved/);
});

test("public video-script poster extraction supports quoted JSON and unquoted JavaScript keys", () => {
  const script = `const player={posterUrl:"https://media.example/video1.jpg",coverImage:'/video2.webp', thumbnail_url:'https://cdn.example/v3.jpg'};`;
  assert.deepEqual(inlinePosterUrls(script), ['https://media.example/video1.jpg','/video2.webp','https://cdn.example/v3.jpg']);
  assert.deepEqual(inlinePosterUrls('const x={playerUrl:"https://media.example/movie.mp4"};'), []);
});

test("host sampling stops immediately on known access screens or broken tooling", () => {
  assert.equal(shouldContinueHostProbes({ clientOk:true, manualVerificationRequired:true }, 1), false);
  assert.equal(shouldContinueHostProbes({ clientOk:true, challengeDetected:true }, 1), false);
  assert.equal(shouldContinueHostProbes({ clientOk:true, browserFallbackError:'edge_fallback_unavailable' }, 1), false);
  assert.equal(shouldContinueHostProbes({ clientOk:true, image:null }, 1), true);
  assert.equal(shouldContinueHostProbes({ clientOk:true, image:null }, 3), false);
});
