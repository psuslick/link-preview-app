# Link Preview App v2.8.0 — build notes

## Improvements

- Return-from-Sandbox-browser one-shot automatic retry after user finishes the website's required confirmation; bounded same-site reuse of the approved session; no automatic verification decisions.
- Memory-only in-server workspace recovery after discarded or reloaded app tabs. Interrupted preview/Finder operations require user initiation to resume.
- Strictly aggregate, allowlisted, clipboard-only diagnostic summary for investigating missing thumbnails without ever sharing link-related material.
- Existing network and DNS request caps preserved. No disk logs or host writes.

## Validation

- Existing and new Node regression tests.
- Static Node source syntax checks and client JSX parsing.
- Full Windows Sandbox/Edge integration remains unverified in this build environment.

## Known constraints

- Pages that withhold preview metadata until a required website confirmation is completed may not be previewable without that on-site interaction.
- In-memory workspace survives tab reloads only as long as the Sandbox server process remains running and the snapshot fits the bounded server RAM budget.
