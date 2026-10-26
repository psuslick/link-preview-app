import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExcludedDomain, isExcludedUrl, excludeUrls } from "../client/src/domain-exclusions.js";

test("normalizes entered domains and excludes all nested subdomains", () => {
  assert.equal(normalizeExcludedDomain("*.EXAMPLE1.com"), "example1.com");
  assert.equal(normalizeExcludedDomain("https://EXAMPLE1.COM/videos/abc"), "example1.com");
  assert.equal(normalizeExcludedDomain("file:///etc/passwd"), null);
  assert.equal(normalizeExcludedDomain("example .com"), null);
  assert.equal(isExcludedUrl("https://a.b.Example1.com/clip", ["example1.com"]), true);
  assert.equal(isExcludedUrl("https://example1.com/clip", ["example1.com"]), true);
  assert.equal(isExcludedUrl("https://notexample1.com/clip", ["example1.com"]), false);
  assert.equal(isExcludedUrl("https://example1.com.evil.test/clip", ["example1.com"]), false);
});

test("excluded links are removed before import without altering other URL identity", () => {
  const values = ["https://one.example1.com/watch?Id=A", "https://live.test/V?id=A", "https://example1.com/2", "https://live.test/v?id=A"];
  assert.deepEqual(excludeUrls(values, ["example1.com"]), {
    kept: ["https://live.test/V?id=A", "https://live.test/v?id=A"],
    removed: ["https://one.example1.com/watch?Id=A", "https://example1.com/2"]
  });
});
