# Link Preview App v2.8.1 — full same-site recovery

Complete Git-ready release including BOOTSTRAP/ and LAUNCHER/ with existing read-only host mappings.

## Changes

- Removes the arbitrary 12-item automatic same-site limit and three-at-a-time continuation.
- Processes all eligible unresolved same-host items sequentially after a successful approved-session preview.
- One active recovery wave per website host; 850ms minimum pacing, failure-responsive backoff, and pause after 3 consecutive unsuccessful previews.
- Progress counts, stop-after-current and resume-all-remaining controls.
- No automatic handling of interactive personal verification.
- No new external integrations, diagnostic logs or persistence of sensitive data.

## Validation

- 41 Node regression tests passed (including three additional same-site policy tests).
- JavaScript and JSX source syntax checks passed.
- Release ZIP passed integrity validation.
- Live Windows Sandbox/Edge integration not tested in this environment.

## Scope of automation

Routine cookie controls can be automatically processed where recognizable. When a site requires an explicit user decision, the app waits for that on-site action. After a successful approved-session retry, remaining eligible previews on the same host run automatically until completed, manually stopped, or paused after repeated failures.

Recovery queue progress itself is not persisted across UI reloads; the RAM-only workspace preserves previews and allows explicit resumption.
