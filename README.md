# Link Preview App — complete v2.7.7 source tree

This is the **complete application source tree**, assembled from the supplied
`link-preview-app.zip` and the v2.7.6 source, followed by the v2.7.7 preview improvements. The Git history (`.git/`) and
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

## v2.7.7 — unattended public thumbnail recovery

The preview pipeline now avoids stopping at `</head>` if no image/poster evidence
is available. It continues reading **the same bounded page response** to find
video posters embedded in JSON-LD, framework script data, `video[poster]`, and
lazy/responsive image markup. If a truncated page is still missing metadata,
only one additional capped public HTML read is attempted. No per-site allowlist
or adult-content filter has been introduced.

The parser now recognizes responsive `srcset`/`data-srcset`, video data-poster
attributes and additional Open Graph thumbnail fields. Public meta tags can be
recovered even from a 401/403/451 interstitial response where present, without
performing login, challenge solving, or age attestation.

Clearly recognized age-verification pages skip the unattended headless Edge
attempt (which cannot legally/meaningfully complete verification) and show a
specific explanation when no public image exists. No-thumbnail results are
not retained as successful preview-cache entries, so legitimate subsequent
manual retries are not frozen on a stale title-only response.

The DNS governor, request/response size limits, host concurrency, privacy
controls, read-only Sandbox mapping and HA/Kuma isolation remain unchanged.
No launcher or bootstrap update is needed beyond deploying Git source; existing
`BOOTSTRAP/` and `LAUNCHER/` files are included for a complete repository layout.

**Limit:** some sites offer neither public poster metadata nor a publicly
accessible thumbnail. Real age verification, authentication, DRM, and CAPTCHA
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
