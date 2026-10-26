Link Preview App v2.7.5 — build status / handoff
================================================

Input: user-supplied v2.7.4 replacement ZIP.
Output: v2.7.5 replacement ZIP for extraction over existing repository root.

Verified in this build environment:
- 8 targeted node:test regression tests passed:
  private/special IP blocking (including compressed IPv4-mapped IPv6),
  local API origin and image-referrer acceptance, cross-site/rebinding refusal,
  DNS cache + single-flight, DNS error pressure accounting, unsafe DNS rejections,
  case-sensitive/fragment URL identity, and cross-origin image Referer privacy.
- node --check passed for every server/*.js plus the new client utility and API.
- Static review: no new disk-logging path, HA/Kuma endpoint or app-to-LAN monitor.
- ZIP listing, CRC/integrity and SHA-256 checked after packaging.

Not verified here:
- React/Vite production compilation or full Windows Sandbox/Edge/SearXNG run.
  The replacement ZIP does not contain the original package.json, node_modules,
  bootstrap and .wsb, and those files were not supplied for this turn.
- Whether the separate Orbi/ISP/NextDNS path will remain healthy during another
  large video batch: this build is a security/stability hardening, not proof of
  the root cause of prior network outages.

Behavior retained:
- global DNS governor and memory-only aggregate diagnostics
- host-agnostic video search and previews; no provider allowlist
- conservative dead-link classification and explicit manual rechecks
- privacy settings and existing startup/dependency workflow

Important: new server/*.js and client/src/url-identity.js MUST accompany the
modified index.js and App.jsx. Partial extraction can break module imports.
