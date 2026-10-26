Link Preview App v2.7.6 replacement build
=========================================

Starting point: v2.7.5 replacement build. Designed as overlay for the user's
existing Windows Sandbox Link Preview repository; no complete package.json,
node_modules, bootstrap or .wsb is included in the supplied replacement tree.

Implemented
-----------
1. Import-time domain + subdomain exclusion, memory-only, counted in summary.
2. Optional user-loaded Sandbox Edge Manifest V3 tab collector companion,
   localhost app bridge, one URL per line, staging and clipboard copy.
3. On-demand archived video metadata from Wayback and Common Crawl, editable
   title, optional clearly unverified historical search leads when privacy
   settings permit, archived outbound links.
4. Finder ranking prioritizes corroborated candidates. Broad lexical and
   search-only results no longer masquerade as likely mirrors; weak/raw leads
   preserved. Duration and media evidence inform longer/mirror labels.

Safety/stability
----------------
- Sandbox-only. Does not read host tabs or send URLs to the host or HA/Kuma.
- New extension has tabs permission plus localhost-only content-script site
  access; no remote site injection, fetch, telemetry or persistent storage.
  User explicitly loads it into the Sandbox Edge profile.
- All network requests remain behind existing bounded server network scheduler
  and DNS governor, with unchanged global rate/concurrency limits. A separate
  two-at-a-time archive-recovery gate prevents parallel mass archive probes.
- Historical lookups only run when user requests recovery (Finder's existing
  archive retrieval behavior is preserved). External exact URL search is
  privacy-gated and on-demand.
- No adult/provider allowlist, SafeSearch filter or content-based censorship.

Validation
----------
- Domain-exclusion, Finder-evidence, extension worker and all v2.7.5 Node
  regression tests passed.
- JS syntax checks on server/helpers/extension worker and bridge passed.
- Windows Sandbox end-to-end and UI build not run: original complete repository
  and installed runtime dependencies were not provided in this workspace.

Known limits
------------
- Tab collector requires user to load extension into Edge's same Sandbox
  profile and the UI to be served on localhost/127.0.0.1 port 5173 or 4173.
- No tool can guarantee dead-page recovery if no archive or indexed mention
  exists. Search engines may fail on adult/age-gated results despite explicit
  SafeSearch Off requests; the app does not perform its own content filtering.
- A title match alone is "possible"; identity and actual footage similarity
  still require user verification or available FFmpeg sample comparison.
