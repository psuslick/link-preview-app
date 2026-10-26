import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const dir = new URL("../edge-tab-collector/", import.meta.url);

test("tab collector requests only browser tab permission and no remote hosts", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
  assert.deepEqual(manifest.permissions, ["tabs"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.manifest_version, 3);
});

test("collector includes ordinary and age-restricted HTTPS URLs while hiding the app tab", () => {
  let handler;
  const chrome = {
    runtime: { lastError: null, onMessage: { addListener(fn) { handler = fn; } } },
    tabs: { query(_options, callback) {
      callback([
        { url: "http://localhost:5173/" },
        { url: "https://example.org/A?x=1" },
        { url: "https://adult.example.org/video/123" },
        { url: "https://example.org/A?x=1" },
        { url: "edge://settings" },
        { url: "https://example.org/a?x=1" }
      ]);
    } }
  };
  runInNewContext(readFileSync(new URL("worker.js", dir), "utf8"), { chrome, URL });
  let result;
  const asyncResponse = handler({ type: "SANDBOX_COLLECT_TABS_V1" }, { url: "http://localhost:5173/" }, (value) => { result = value; });
  assert.equal(asyncResponse, true);
  assert.deepEqual(Array.from(result.urls), ["https://example.org/A?x=1", "https://adult.example.org/video/123", "https://example.org/a?x=1"]);
  handler({ type: "SANDBOX_COLLECT_TABS_V1" }, { url: "https://evil.example/" }, (value) => { result = value; });
  assert.equal(result.error, "untrusted_sender");
});
