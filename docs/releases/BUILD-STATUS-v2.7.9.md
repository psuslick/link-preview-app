# v2.7.9 — More resilient public preview discovery

- Corrects batch fallback grouping so one missing thumbnail does not cause all
  other URLs on the same host to be deferred without individual testing.
  Up to three distinct pages are sampled sequentially first. If any yields a
  public thumbnail, remaining pages are processed normally. When none do,
  browser retries are deferred to protect network responsiveness.
- Gives asynchronous video metadata time to appear in the disposable browser,
  rather than stopping solely because the HTML body has closed.
- Retries legacy DOM inspection only when the local DevTools integration fails;
  does not double-request sites after timeouts or verification challenges.
- Recognizes unquoted JavaScript poster and thumbnail configuration keys.
- Preserves existing DNS/HTTP governors and memory-only monitoring.
- Does not automatically complete authentication or verification prompts.

Validated: Node regression tests, server JS syntax, JSX parse and ZIP CRC.
Live site behavior still requires testing inside Windows Sandbox; HTML pages
that expose no public poster and require an authorized session cannot be
previewed unattended.
