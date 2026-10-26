Network stability defaults
==========================
DNS base rate:       6 fresh host resolutions / second
DNS healthy maximum: 8 / second
DNS pressure rate:   2 / second
Burst allowance:     10 fresh resolutions
Validated DNS cache: 30 seconds
Pressure cooldown:   30 seconds
Preview workers:     12 (unchanged)
HTTP global limit:   16 (unchanged)
HTTP per-host limit: 4 (unchanged)

Interpretation of UI telemetry
==============================
NORMAL:
  DNS is responding normally. New hostnames are governed but throughput is not under
  pressure.

ELEVATED:
  DNS lookup latency or queue depth is increasing. The app continues work while smoothing
  new-host lookups.

THROTTLED:
  A temporary DNS failure (for example EAI_AGAIN / lookup timeout) or very slow lookup was
  observed. New hostnames are reduced to 2/sec for ~30 seconds. Cached/resolved hosts and
  existing HTTP connections can continue normally.

The governor intentionally controls NEW DNS resolutions rather than cutting the frontend
preview-worker count. This preserves speed for large batches that share video/CDN hosts.
