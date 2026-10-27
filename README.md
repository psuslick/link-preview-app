# Link Preview App — complete v2.8.2 source tree

This is the **complete application source tree**, assembled from the supplied
`link-preview-app.zip` and the v2.7.6 source, followed by the v2.7.7, v2.7.8 and v2.7.9 preview improvements, v2.8.0 workspace recovery, and v2.8.1 full same-site recovery. The Git history (`.git/`) and
installed dependencies are intentionally **not** distributed in the ZIP.

```text
link-preview-app/
├── BOOTSTRAP/                    # Git-safe Windows Sandbox startup scripts
│   ├── run-bootstrap.cmd
│   ├── restart-app.cmd
│   ├── start-diagnostic.cmd
│   └── LEGACY-DO-NOT-RUN/        # Old installers and reference scripts; NOT used
├── LAUNCHER/
│   ├── linkPreviewApp-hardened.wsb  # Git-safe read-only launcher
│   └── LOCAL-ONLY-DO-NOT-COMMIT/   # Ignored; original unsafe sample disabled
├── client/                       # React/Vite frontend
├── server/                       # Node API, media and network guard
├── edge-tab-collector/           # Optional Sandbox Edge extension
├── searxng/                      # Service configuration example
├── tests/                        # Node regression tests
└── docs/releases/                # Previous version notes
```

## How to update your existing Git repository

Copy/merge the contents of this `link-preview-app/` folder into your **existing**
Git checkout. Do not delete your `.git` directory. The source ZIP already has the
correct folder hierarchy: matching files replace older versions and new folders
can be added directly.

Check `git status`, then commit and push from your own checkout. The Sandbox
bootstrap clones `https://github.com/psuslick/link-preview-app.git` on launch,
so **new commits must be pushed before launching a fresh Sandbox**.

## Windows Sandbox setup

See [BOOTSTRAP/README.md](BOOTSTRAP/README.md) and
[LAUNCHER/README.md](LAUNCHER/README.md). A one-time host-side copy of the
Git-safe BOOTSTRAP folder is needed to match the launcher. No script needs to be
executed on the host. The Sandbox mapped folder stays `ReadOnly=true`.

The Vite client now binds only to `127.0.0.1` inside Sandbox rather than
all Sandbox network interfaces.

The extension can be loaded from the Sandbox-local cloned repo via an Edge
startup flag. Some Edge versions or policies ignore that flag; in that case,
load `C:\App\edge-tab-collector` manually from `edge://extensions` inside Sandbox.
It never reads your host browser tabs.

## Privacy

Keep all browser data, URL lists, cookies, session settings, diagnostics and
scraped metadata inside Windows Sandbox. Do not put real credentials or sensitive
link lists in this repository or in the host-mapped payload. The app does not
integrate with HA/Kuma. The launcher allows clipboard redirection because the
user's workflow involves copying links; it is an intentional host/Sandbox
interaction.

## v2.7.9 — improved batch preview recovery

The bounded browser fallback now checks up to three distinct video pages per
site before assuming that all unresolved links need an interactive session.
It also waits for actual poster metadata instead of treating a completed page
body as proof that the player has finished loading. A lightweight legacy
inspection runs only when local browser inspection infrastructure fails.
Neither the Sandbox network limits nor verification requirements are bypassed.

## v2.7.8 — consent-aware previews and low-impact networking

The first preview pass stays lightweight. For pages with no exposed thumbnail,
a single bounded Sandbox Edge fallback can now inspect the rendered page and
handle **recognizable cookie/privacy consent controls only**, before extracting
poster metadata. It does not submit login, identity, verification, or challenge
prompts. The older DOM-dump fallback remains available if Edge's local debugger
is unavailable. Large video/media requests are suppressed in the new headless
browser path; no site/domain allowlist or content filtering is introduced.

In v2.7.8, an approved session could recover only the next 12 unresolved
same-site previews. **This historical limit was removed in v2.8.1.** The fast HTTP pass now labels pending browser work as
"queued" rather than incorrectly suggesting it was never scheduled.

Large imports use conservative networking defaults: **4 frontend preview
workers, 7 concurrent backend HTTP requests, 2 per host, 2 images,
3 connections in the isolated browser proxy, 1 Finder job**, and dynamic
HTTP request-start pacing based on DNS pressure. Retry backoff no longer holds
network slots idle. Maximum proxy image response size is 4 MiB.

The Sandbox UI now shows **aggregate response MB/minute** and the manual
snapshot includes backend HTTP and isolated headless-browser proxy bytes.
These counters stay in RAM only and exclude separate visible Edge windows and
local metasearch traffic; they are not total interface bandwidth measurements.
No URLs, domains, titles, media identifiers or search content are recorded in
these counters. No HA/Kuma integration exists.

**Limit:** real verification, account authentication and access challenges
still require normal user interaction; a thumbnail not exposed publicly or to
an already approved session may remain unavailable. Network impact is
substantially bounded by these changes, but the cause of a specific home-network
slowdown cannot be proven from source inspection alone. Live Windows Sandbox
and Edge behavior must be tested on the user's system.

## v2.7.7 — unattended public thumbnail recovery

The preview pipeline now avoids stopping at `</head>` if no image/poster evidence
is available. It continues reading **the same bounded page response** to find
video posters embedded in JSON-LD, framework script data, `video[poster]`, and
lazy/responsive image markup. If a truncated page is still missing metadata,
only one additional capped public HTML read is attempted. No per-site allowlist or content-based exclusion rules were introduced.

The parser now recognizes responsive `srcset`/`data-srcset`, video data-poster
attributes and additional Open Graph thumbnail fields. Public meta tags can be
recovered even from a 401/403/451 interstitial response where present, without
performing login or solving access challenges.

Clearly recognized verification interstitials skip unattended browser attempts that cannot complete user-required checks. A generic explanation is shown when no public thumbnail exists. No-thumbnail results are
not retained as successful preview-cache entries, so legitimate subsequent
manual retries are not frozen on a stale title-only response.

The DNS governor, request/response size limits, host concurrency, privacy
controls, read-only Sandbox mapping and HA/Kuma isolation remain unchanged.
No launcher or bootstrap update is needed beyond deploying Git source; existing
`BOOTSTRAP/` and `LAUNCHER/` files are included for a complete repository layout.

**Limit:** some sites offer neither public poster metadata nor a publicly
accessible thumbnail. Verification, authentication, DRM, and CAPTCHA
still require the site's normal authorized flow, and not every link can be
previewed unattended. Live Windows/Edge integration remains unverified here.

## Verification

From the root, with Node installed:

```bash
node --test tests/*.test.mjs
```

Run the React build separately after installing the client dependencies. A true
Windows Sandbox startup and Edge extension auto-load must still be verified in
the real Windows environment.

## v2.8.0: Preview recovery and workspace resilience

- When you manually open a reusable Sandbox site session, complete any required
  website confirmation yourself, then return to the app. The app performs one
  automatic preview retry and, on success, reuses the approved profile.
  (The v2.8.0 group was limited to 12; v2.8.1 removes that cap.) No automatic site
  verification is attempted; actual verification and sign-in remain manual.
- The preview list, selected items, Finder jobs, draft input, exclusion rules,
  and completed thumbnail metadata are mirrored into **Sandbox server RAM**.
  If the app tab reloads or is discarded, the UI can restore that workspace.
  Interrupted network jobs remain available for explicit retry, not unbounded
  automatic replay. Server restart or Sandbox close clears the snapshot.
- `Copy preview diagnostic report (no links)` produces a strictly allowlisted
  aggregate report of counters, timing, and recovery states. It contains no
  source URLs, domains, titles, media IDs, snippets, or raw error strings.
  Nothing is sent outside the Sandbox unless you explicitly copy and share it.
- The older aggregate network snapshot has also been hardened to avoid copying
  untrusted free-text error reasons.

The workspace is never written to localStorage, sessionStorage, IndexedDB,
filesystem logs, or host-mounted folders. The app does not contact any monitoring
server or Home Assistant integration. This behavior assumes the local Sandbox
backend remains running; no memory-only design can preserve data across a full
backend/Sandbox restart.


## v2.8.1: recover all remaining previews from an approved site session

- After completing any required confirmation in visible Sandbox Edge, return to
  the app. It retries the original link and, when that preview succeeds, starts
  **every eligible unresolved link on the same website host** sequentially.
  There is no hard 12-link limit and no need to repeat a three-item batch.
- A single recovery wave runs per host; there are no recursive retry chains.
  The worker waits at least 850 ms between requests and backs off after
  unsuccessful attempts. Three consecutive unsuccessful previews pause the wave
  rather than repeatedly requesting inaccessible pages.
- Progress includes attempted/recovered counts and a **Stop after current
  preview** control. **Recover all remaining from site** resumes a paused wave
  using the existing approved site session when it is still available.
- Separate subdomains are not presumed to share site-session state.
- Browser reloads still restore the RAM-only workspace, but interrupted
  recovery work is **not automatically replayed** from a possibly stale
  snapshot; resume from the approved session if necessary.
- Ordinary cookie controls may be handled automatically. Prompts requiring
  a personal confirmation or sign-in still require the website's normal
  user interaction; the app does not submit those decisions unattended.
- DNS, HTTP, thumbnail and browser limits remain unchanged. Nothing new is
  logged to disk or transmitted to monitoring systems.


## v2.8.2: delayed player-image readiness and safer diagnostics

The live authorized-session browser now waits for real poster evidence, not just
`document.readyState`. It checks the rendered `video.poster`, loaded
`img.currentSrc`, and CSS player-cover backgrounds with a bounded wait, then
feeds the discovered candidates into the normal thumbnail extractor. Browser
inspection remains sequential and Sandbox-only; it does not automate required
website verification. Some iframe-only or session-protected images may still
not be accessible.

The copied diagnostic report now categorizes browser fallback errors and upstream
HTTP statuses using fixed, non-identifying labels. It never contains link URLs,
domains, titles, extracted page text, media IDs or raw exception messages.
