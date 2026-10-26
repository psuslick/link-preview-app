Link Preview App v2.7.4 build status
====================================

Base: v2.7.3 replacement package
Purpose: privacy-safe, memory-only network incident context

Validated in build environment:
- all server/*.js files pass node --check
- client App.jsx + api.js parse successfully with TypeScript JSX parser (no emit)
- no diagnostic telemetry write to localStorage found
- no diagnostic log-file write path added
- no Home Assistant, Uptime Kuma, MQTT, or webhook integration added to executable client/server code
- aggregate clipboard snapshot contains timestamps/counters only; no URL/hostname/title/media/search fields

Behavior preserved:
- v2.7.3 DNS governor
- 12 preview workers / existing HTTP limits
- conservative v2.7.2 dead-link behavior
- v2.7.1 SearXNG local support
- v2.6.1 bounded/manual site-session retry behavior

No .wsb/bootstrap/npm/tool dependency change.
