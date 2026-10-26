import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedAddress } from "../server/public-network-policy.js";
import { checkLocalApiAccess } from "../server/local-api-access.js";
import { DnsGovernor } from "../server/dns-governor.js";
import { extractVideoUrls, videoUrlIdentity } from "../client/src/url-identity.js";
import { imageRefererStrategies } from "../server/image-referer-policy.js";

test("public IP guard denies private, mapped, local, and special-use addresses", () => {
  for (const address of [
    "127.0.0.1", "10.12.34.56", "172.20.2.4", "192.168.1.1",
    "100.64.1.1", "169.254.2.1", "192.0.0.8", "198.19.0.1",
    "::1", "fe80::1234", "fc00::5", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::ffff:a00:1", "2001:db8::1",
    "2002:7f00:1::1", "3fff::2", "invalid.address"
  ]) assert.equal(isBlockedAddress(address), true, `should block ${address}`);

  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
    assert.equal(isBlockedAddress(address), false, `should permit ${address}`);
});

test("local API accepts loopback UI and an origin-referrer thumbnail", () => {
  const allowedPost = checkLocalApiAccess({ host: "127.0.0.1:3000", origin: "http://localhost:5173", fetchSite: "cross-site" });
  const allowedImage = checkLocalApiAccess({ host: "127.0.0.1:3000", referer: "http://localhost:5173/", fetchSite: "cross-site" });
  const allowedInternal = checkLocalApiAccess({ host: "127.0.0.1:3000" });
  assert.equal(allowedPost.allowed, true);
  assert.equal(allowedPost.origin, "http://localhost:5173");
  assert.equal(allowedImage.allowed, true);
  assert.equal(allowedInternal.allowed, true);
});

test("local API rejects remote origins, embedded requests and rebinding hosts", () => {
  for (const headers of [
    { host: "127.0.0.1:3000", origin: "https://example.com" },
    { host: "127.0.0.1:3000", origin: "null" },
    { host: "127.0.0.1:3000", origin: "http://localhost.evil.com:5173" },
    { host: "127.0.0.1:3000", fetchSite: "cross-site" },
    { host: "127.0.0.1:3000", referer: "https://example.com/watch" },
    { host: "attacker.example:3000", origin: "http://localhost:5173" }
  ]) assert.equal(checkLocalApiAccess(headers).allowed, false, JSON.stringify(headers));
});

test("DNS single-flight shares one lookup and the validated cache", async () => {
  let calls = 0;
  const governor = new DnsGovernor({
    burst: 2,
    lookup: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ address: "1.1.1.1", family: 4 }];
    },
    validateAddresses: (value) => value
  });
  const responses = await Promise.all(Array.from({ length: 12 }, () => governor.resolve("public.example")));
  assert.equal(calls, 1);
  assert.equal(responses.length, 12);
  assert.equal(governor.status().singleFlightShares, 11);
  await governor.resolve("public.example");
  assert.equal(calls, 1);
  assert.equal(governor.status().cacheHits, 1);
});

test("a slow temporary DNS failure counts as one throttle event", async () => {
  const governor = new DnsGovernor({
    slowLookupMs: 5,
    lookup: async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      const error = new Error("temporary failure");
      error.code = "EAI_AGAIN";
      throw error;
    }
  });
  await assert.rejects(governor.resolve("failed.example"), { code: "EAI_AGAIN" });
  assert.equal(governor.status().pressureEvents, 1);
  assert.equal(governor.status().errors, 1);
  assert.equal(governor.status().active, 0);
  assert.equal(governor.status().pressure, "throttled");
});

test("unsafe DNS answers are rejected and never cached", async () => {
  let calls = 0;
  const governor = new DnsGovernor({
    lookup: async () => { calls += 1; return [{ address: "192.168.1.1", family: 4 }]; },
    validateAddresses: (values) => {
      if (values.some(({ address }) => isBlockedAddress(address))) throw new Error("private_network_dns_blocked");
      return values;
    }
  });
  await assert.rejects(governor.resolve("rebind.example"), /private_network_dns_blocked/);
  await assert.rejects(governor.resolve("rebind.example"), /private_network_dns_blocked/);
  assert.equal(calls, 2);
  assert.equal(governor.status().cacheEntries, 0);
});

test("video URL identity keeps case-sensitive paths, queries, and SPA fragments", () => {
  const result = extractVideoUrls([
    "HTTPS://EXAMPLE.COM/Watch/AbC#video=1",
    "https://example.com/Watch/abc#video=1",
    "https://example.com/Watch/AbC#video=2",
    "https://example.com/Watch/AbC#video=1"
  ].join("\n"));
  assert.equal(result.urls.length, 3);
  assert.equal(result.invalid, 0);
  assert.notEqual(videoUrlIdentity(result.urls[0]), videoUrlIdentity(result.urls[1]));
  assert.notEqual(videoUrlIdentity(result.urls[0]), videoUrlIdentity(result.urls[2]));
  assert.equal(videoUrlIdentity("https://EXAMPLE.com/Watch/AbC#video=1"), result.urls[0]);
});

test("thumbnail requests never disclose full source URL across origins", () => {
  const sensitive = "https://video.example/private/watch?token=SECRET#video";
  const external = imageRefererStrategies("https://cdn.example/poster.jpg", sensitive);
  assert.deepEqual(external.map((entry) => entry.name), ["source-origin", "image-origin", "no-referrer"]);
  assert.equal(external.some((entry) => Object.values(entry.headers).includes(sensitive)), false);
  assert.equal(external[0].headers.Referer, "https://video.example/");
  const sameOrigin = imageRefererStrategies("https://video.example/poster.jpg", sensitive);
  assert.equal(sameOrigin[0].headers.Referer, sensitive);
});
