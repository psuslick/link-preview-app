# Build status — v2.8.3

Source: v2.8.2 complete public-clean package.

- Added checkbox: Hide links without thumbnails (Previews tab only).
- Display filtering is non-destructive and never blocks preview, recovery, or Finder jobs.
- Counts show hidden vs visible records; selection-all respects visible cards.
- Empty filtered state guides the user back to the full list.
- Detects locally exhausted thumbnail image candidates; retries reset failure state.
- Stabilized lazy image candidate identity across unrelated React re-renders.
- Preference stored in Sandbox backend RAM workspace only; no disk log.
- No changes to HTTP/DNS governor, bootstrap, launcher, or host mapping.

Validation: run `node --test tests/*.test.mjs` from repository root,
check source syntax, and verify package contents. Windows Sandbox end-to-end
UI validation is not available in this environment.
