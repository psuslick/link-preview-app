# v2.8.2 — privacy-safe preview-failure diagnosis

Complete Git-ready repository. Retains BOOTSTRAP/ and LAUNCHER/ unchanged.

The v2.8.1 aggregate report recorded browser fallback attempts without their
outcome categories. In a real report, three attempts had no successful browser
result, but it was not possible to tell why without sharing raw diagnostics.

New report fields (all numeric aggregate counts):
- missing_http200, missing_http401_403, missing_http404_410,
  missing_http429_503, missing_httpOther, missing_httpUnknown
- fallbackAttemptedWithoutImage, fallbackNotAttemptedWithoutImage
- fallbackFailure_unavailable, _launch, _timeout, _debugger, _empty_dom,
  _challenge, _resource_limit, _network, _other, _none

Browser errors are mapped only from known internal fixed code strings. Unknown
errors are counted under 'other'. No raw error text, URLs, hostnames, titles,
search content, page snippets, or IDs are copied or transmitted. There is no
new persistent logging or external telemetry.

Also improves the approved-session live browser probe:
- Waits up to 7.5 seconds for poster evidence rather than stopping when DOM
  loading completes. No additional page-navigation retry loops are introduced.
- Reads video.poster, img.currentSrc and player CSS background images after
  asynchronous hydration, even when these are absent from raw HTML markup.
- Carries live image hints to the existing metadata extractor in memory only.
- The required website confirmation remains a user action; it is not automated.

Targeted source-level tests cover late poster appearance, live image hints and
privacy-safe diagnostic categories. Actual behavior still needs testing inside
Windows Sandbox with the user's own links, without sharing them.


Existing traffic governor, browser/session handling, Sandbox isolation and
source-controlled bootstrap/launcher are unchanged.
