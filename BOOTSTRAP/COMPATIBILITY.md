# Sandbox compatibility and startup notes

This package makes **one Git-ready tree**; it does **not** include portable Git,
Node, SearXNG, FFmpeg, yt-dlp or other executable dependencies. Those remain
separate read-only host payloads, as in the existing installation.

- The `.wsb` LogonCommand now runs `...\SandboxBootstrap\BOOTSTRAP\run-bootstrap.cmd`.
- The repo is cloned into `C:\App` inside Sandbox. Existing Git source on host is
  not mapped writable, modified or mounted for ongoing app work.
- The bootstrap tries to load the bundled unpacked Edge extension using an Edge
  launch flag. This may be ignored by browser version/policy: use the documented
  manual `edge://extensions` fallback if needed.
- Edge uses a dedicated profile under Sandbox `%TEMP%` so it doesn't rely on a
  host Edge profile. The extension sees only tabs in that Sandbox profile.
- Vite now binds to `127.0.0.1`, reducing exposure to other network interfaces.
- `npm install` remains Sandbox-local when pre-extracted dependencies are absent.
  Startup under 30 seconds cannot be guaranteed if npm must fetch packages.
- `ClipboardRedirection=Enable` permits manual transfer of copied text between
  host and Sandbox; disable it in a LOCAL-ONLY launcher if you prefer isolation
  over clipboard convenience.
