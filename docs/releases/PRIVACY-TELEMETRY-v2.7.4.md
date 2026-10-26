v2.7.4 privacy / telemetry contract
===================================

The Web App does NOT:
- know the Home Assistant or Uptime Kuma address
- connect to Home Assistant or Uptime Kuma
- expose a callback/webhook/MQTT path to them
- write aggregate network diagnostics to disk or localStorage
- persist a diagnostic timeline
- include URLs/hostnames/titles/search content in the aggregate snapshot

The Web App DOES:
- keep current and peak network counters in process/React memory
- display those counters inside the Sandbox UI
- allow a user-initiated clipboard copy of aggregate numbers/timestamps
- reset this diagnostic context on UI/server restart and lose it when Sandbox closes

Manual correlation model
========================
If an outage occurs, copy the aggregate snapshot or provide the approximate batch time/size.
Separately inspect HA/Kuma history for that time window. Neither system communicates with the
other.
