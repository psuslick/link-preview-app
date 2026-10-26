Link Preview App v2.7.1 — SearXNG integration
==============================================

v2.7.1 completes the local integration started in v2.7.0.

LOCAL SERVICE
-------------
When the Windows-compatible dependency package is present under the existing
read-only SandboxBootstrap mapping, the Link Preview Node server automatically:

- detects the embedded Python/SearXNG runtime;
- generates a fresh Sandbox-local settings.yml;
- starts SearXNG on 127.0.0.1:8888;
- waits for /config to become healthy;
- uses the JSON API for Version Finder discovery;
- falls back to direct search engines if SearXNG cannot start.

FINDER REQUEST
--------------
Each Finder query sends:

format=json
safesearch=0
categories=general,videos
language=all

BING
----
Bing and Bing Videos are deliberately disabled inside local SearXNG. Link
Preview keeps Bing separate because Bing SafeSearch Off must be established and
verified in the dedicated Sandbox Edge/Bing profile. This avoids SearXNG quietly
returning Bing Moderate-filtered results.

LOCAL CONFIG
------------
The app's generated SearXNG config enables JSON, safe_search=0, localhost-only
binding, and a broad selection of general and video engines including Brave,
DuckDuckGo, Google, Mojeek, Qwant, Startpage, Yahoo, Wiby, Brave Videos,
DuckDuckGo Videos, Google Videos, Qwant Videos, Dailymotion, Bilibili, BitChute,
Odysee, PeerTube, Rumble, SepiaSearch, Vimeo, YouTube, NicoNico and Sogou Videos.
Individual engine failures do not stop SearXNG from returning other results.

See SEARXNG-LOCAL-SETUP.txt for the dependency ZIP and placement.
