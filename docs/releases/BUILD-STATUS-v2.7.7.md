Link Preview App v2.7.7 — Complete Git-ready source
=================================================

Base: Full v2.7.6 Git-ready repository package.
Updated: public metadata extraction pipeline, image candidate discovery,
         age-gate handling and title-only cache behavior.

Changes
-------
- Single-pass stream-through-body when header has no usable thumbnail hint;
  fast head-only path remains when usable metadata is present.
- Bounded second HTML attempt only when initial read is incomplete and no image
  was found. Uses the same DNS governor and request limits, retries=0.
- Body-level JSON-LD/state-script thumbnails and video DOM/poster candidates
  become visible even when the site does not expose an OG image in <head>.
- Adds responsive/lazy srcset and data-poster support and more public OG fields.
- Reads publicly served metadata on 401/403/451 interstitial responses.
- Filters generic gate headings from fallback video titles.
- Detects clear age verification and avoids a futile unattended Edge attempt.
  Does not auto-attest age, solve anti-bot challenges, or use credentials.
- Does not cache no-image title-only failures, allowing later legitimate Retry.
- No new dependency, bootstrap or .wsb change. No application telemetry logs.

Checks performed in this environment
------------------------------------
- 20 pure Node regression tests pass.
- Server JS syntax check passes.
- Client JSX parse via tsc --noResolve/--allowJs/--jsx react-jsx passes.
- Validated launch config syntax (XML parser) and ZIP CRC.

Not executed: full Windows Sandbox startup and live external video-host playback.
Not guaranteed: thumbnails behind sites with no public metadata or mandatory
age/login/CAPTCHA/DRM restrictions.

Install: merge extracted link-preview-app/ directory with existing Git checkout,
keep .git history, commit/push. Existing BOOTSTRAP and LAUNCHER remain compatible.
