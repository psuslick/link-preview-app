Link Preview App v2.7.6 — domain exclusion, Sandbox tabs, archive recovery and Finder accuracy
==========================================================================================

Extract this ZIP over the ROOT of your existing link-preview-app repository,
replacing matching files. Include all new server/ and client/src/ helpers.
Launch the same hardened Windows Sandbox as before.

No .wsb, bootstrap, npm, SearXNG, yt-dlp, Deno, or FFmpeg changes are required.
This is a replacement-files ZIP, not a complete standalone application.

New in v2.7.6
-------------
- Session-only domain exclusions. Enter example.com or *.example.com; imported
  links to that exact hostname or any nested subdomain are silently skipped
  BEFORE any network traffic. Lookalike names such as notexample.com survive.
  The import summary reports the number excluded. Existing previews are not
  removed; remove them separately if desired.
- Optional Edge Tab Collector (edge-tab-collector/): the app's "Collect open
  Edge tabs" button fills an editable, one-URL-per-line field. "Add to paste
  list" applies domain exclusions and stages URLs for ordinary import. "Copy
  URLs" copies the field. This works only for tabs in the same Sandbox Edge
  profile that has the companion extension loaded. It cannot read host tabs,
  Firefox/Chrome profiles, or other Edge profiles.
- On-demand "Recover historical video details" on dead/failed previews:
  checks Wayback (up to three captures, best available metadata) and Common
  Crawl if enabled. Shows recovered title, description, uploader/date/duration
  when present, archive capture and outgoing links; URL clue/title is labeled
  unverified. Title is editable before queuing Finder. If no archived title and
  the user enabled both DuckDuckGo search and media-ID searches, the button
  also performs ONE external exact-URL search and displays unverified mentions.
- Finder now prioritizes promising candidates/archived source links before
  spending its bounded page-probe budget. Search engine snippets and counts
  are no longer treated as verified video identity: a main-list match must
  have a distinctive title corroborated by a fetched page/media tool or an
  overlapping media ID/file. Raw/weak candidates remain visible separately.
  "Likely longer"/"Likely mirror" require shared identity evidence; the
  evidence score is not a probability.
- No adult or age-restricted-site exclusion, provider allowlist, SafeSearch
  filtering, or content-based rejection was introduced. Search provider
  indexing/policies may still limit available matches.

Optional Sandbox Edge extension setup
-------------------------------------
1. Inside Windows Sandbox, open the same normal Edge profile used for the app.
2. Visit edge://extensions; enable Developer mode; choose "Load unpacked".
3. Select the extracted repository's edge-tab-collector folder. This extension
   requests Chrome/Edge's "tabs" permission to read URLs from open tabs.
   Its content script can run only on localhost/127.0.0.1 pages; it has no
   remote site injection, remote requests, or persistent storage.
4. Reload the Link Preview UI at http://localhost:5173 or
   http://127.0.0.1:5173 (port 4173 also supported), then click "Collect open
   Edge tabs". It excludes the app tab itself and non-HTTP(S) internal pages.
5. Click "Add to paste list" or "Copy URLs"; then create previews when ready.
   The extension must be loaded each fresh disposable Sandbox session unless
   the existing Sandbox launch process already installs it.

Previous v2.7.5 fixes retained
------------------------------
- Restricts browser access to the local API to loopback UI origins/referrers;
  unrelated web pages in the Sandbox can no longer call/read that API.
- Shares one binary IP policy across preview, Edge, yt-dlp and FFmpeg network
  paths; closes compressed IPv4-mapped IPv6 and special-use address gaps.
- Sends full video-page Referer only to a same-origin thumbnail host; external
  CDNs get origin-only Referer and normal alternate retries.
- Preserves case-sensitive URL paths, query parameters and SPA #video routes
  when importing and deduplicating previews and Finder candidates.
- Fixes double-counted DNS pressure events after a slow DNS error and promptly
  clears completed lookup timeout timers.

Preserved
---------
- v2.7.3 global DNS governor (6/sec base, 8/sec healthy, 2/sec pressure,
  burst 10, 30-second validated public-address cache + single-flight).
- v2.7.2 conservative dead-host and confirmed-404/410 classification;
  "Recheck URL/host" bypasses cached dead states.
- v2.7.1 local SearXNG and broad, host-agnostic video discovery.
- v2.7.4 memory-only aggregate UI diagnostics, no diagnostic disk log.
- No Home Assistant/Kuma address, endpoint, token, telemetry, or integration.

Compatibility
-------------
The Vite app UI must be served from http(s)://localhost:<port> or
http(s)://127.0.0.1:<port> inside the Sandbox, as in the existing setup.
This API will not accept access from an external web app origin.

Validation
----------
Run `node --test tests/*.test.mjs` from the repo root. The ZIP has no
node_modules or full Vite/bootstrap project, so Windows Sandbox and Edge
extension end-to-end runtime testing still requires your existing repository.
