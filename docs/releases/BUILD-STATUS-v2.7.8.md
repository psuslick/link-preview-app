# v2.7.8 build status

Base: v2.7.7 public-clean complete repository.

Changes:
- One bounded headless Edge DevTools page inspection with cookie/privacy-only consent handling.
- Explicitly recognized verification, authentication and challenge screens remain manual.
- Bounded automated reuse (maximum 12 sequential same-site previews) only after a user-approved site-session Retry succeeds.
- Conservative concurrency and DNS-adaptive request pacing, smaller image caps, fewer retries and nonblocking server backoff.
- Headless Chromium media download suppression; in-memory aggregate backend and headless proxy traffic counters.
- Browser fallback state reports queued work during the fast initial pass.

Tests: Node regression suite 28 passed. Server JS syntax and client JSX parser passed.
Limitation: Live Windows Sandbox startup and full real-site metadata behavior were not tested in this environment. The local Chromium test runner cannot navigate loopback pages because of environment browser policy. Isolated DOM consent policy tests pass.

No changes to bootstrap/launcher, dependencies, .wsb mappings, HA integration or log persistence.
