import dns from "node:dns";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class DnsGovernor {
  constructor({
    baseRate = 6,
    maxRate = 8,
    minRate = 2,
    burst = 10,
    cacheTtlMs = 30_000,
    pressureCooldownMs = 30_000,
    slowLookupMs = 750,
    healthyLookupMs = 175,
    lookupTimeoutMs = 5_000,
    validateAddresses = (addresses) => addresses
  } = {}) {
    this.baseRate = baseRate;
    this.maxRate = maxRate;
    this.minRate = minRate;
    this.burst = burst;
    this.cacheTtlMs = cacheTtlMs;
    this.pressureCooldownMs = pressureCooldownMs;
    this.slowLookupMs = slowLookupMs;
    this.healthyLookupMs = healthyLookupMs;
    this.lookupTimeoutMs = lookupTimeoutMs;
    this.validateAddresses = validateAddresses;

    this.currentRate = baseRate;
    this.tokens = burst;
    this.lastRefillAt = Date.now();
    this.lastRampAt = Date.now();
    this.pressureUntil = 0;
    this.queue = [];
    this.queueTimer = null;
    this.cache = new Map();
    this.inflight = new Map();
    this.recentLookupTimes = [];

    this.metrics = {
      totalRequests: 0,
      freshLookups: 0,
      cacheHits: 0,
      cacheMisses: 0,
      singleFlightShares: 0,
      errors: 0,
      pressureEvents: 0,
      slowLookups: 0,
      activeLookups: 0,
      ewmaLatencyMs: 0,
      lastLatencyMs: null,
      lastError: null,
      lastErrorAt: null,
      lastPressureReason: null
    };
  }

  _normalizeHost(hostname) {
    return String(hostname || "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  }

  _pruneCache(now = Date.now()) {
    if (this.cache.size < 2048) return;
    for (const [key, value] of this.cache) if (value.expiresAt <= now) this.cache.delete(key);
    if (this.cache.size <= 2048) return;
    const overflow = this.cache.size - 2048;
    for (const key of this.cache.keys()) {
      this.cache.delete(key);
      if (this.cache.size <= 2048 - overflow) break;
    }
  }

  _refill(now = Date.now()) {
    const elapsed = Math.max(0, now - this.lastRefillAt) / 1000;
    this.lastRefillAt = now;
    const rate = this.effectiveRate(now);
    this.tokens = Math.min(this.burst, this.tokens + elapsed * rate);
  }

  effectiveRate(now = Date.now()) {
    if (now < this.pressureUntil) return this.minRate;
    return Math.max(this.minRate, Math.min(this.maxRate, this.currentRate));
  }

  pressureState(now = Date.now()) {
    if (now < this.pressureUntil) return "throttled";
    if (this.queue.length >= this.burst || this.metrics.ewmaLatencyMs >= this.slowLookupMs / 2) return "elevated";
    return "normal";
  }

  _scheduleDrain(delayMs = 0) {
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      this._drainQueue();
    }, Math.max(0, delayMs));
    this.queueTimer.unref?.();
  }

  _drainQueue() {
    if (!this.queue.length) return;
    const now = Date.now();
    this._refill(now);
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()?.();
    }
    if (!this.queue.length) return;
    const rate = this.effectiveRate(now);
    const deficit = Math.max(0, 1 - this.tokens);
    this._scheduleDrain(Math.ceil((deficit / Math.max(rate, 0.1)) * 1000));
  }

  async _acquireToken() {
    const now = Date.now();
    this._refill(now);
    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return;
    }
    await new Promise((resolve) => {
      this.queue.push(resolve);
      this._drainQueue();
    });
  }

  _recordFreshLookup(now = Date.now()) {
    this.recentLookupTimes.push(now);
    const cutoff = now - 10_000;
    while (this.recentLookupTimes.length && this.recentLookupTimes[0] < cutoff) this.recentLookupTimes.shift();
  }

  _enterPressure(reason) {
    const now = Date.now();
    this.pressureUntil = Math.max(this.pressureUntil, now + this.pressureCooldownMs);
    this.currentRate = this.minRate;
    this.tokens = Math.min(this.tokens, 2);
    this.metrics.pressureEvents += 1;
    this.metrics.lastPressureReason = reason || "dns_pressure";
    this._scheduleDrain(0);
  }

  _recordLatency(latencyMs, ok = true) {
    this.metrics.lastLatencyMs = latencyMs;
    this.metrics.ewmaLatencyMs = this.metrics.ewmaLatencyMs
      ? this.metrics.ewmaLatencyMs * 0.8 + latencyMs * 0.2
      : latencyMs;

    if (latencyMs >= this.slowLookupMs) {
      this.metrics.slowLookups += 1;
      this._enterPressure(`slow_lookup_${Math.round(latencyMs)}ms`);
      return;
    }

    const now = Date.now();
    if (!ok || now < this.pressureUntil) return;
    if (latencyMs <= this.healthyLookupMs && now - this.lastRampAt >= 10_000 && this.currentRate < this.maxRate) {
      this.currentRate = Math.min(this.maxRate, this.currentRate + 0.5);
      this.lastRampAt = now;
    } else if (this.currentRate < this.baseRate && now - this.lastRampAt >= 10_000) {
      this.currentRate = Math.min(this.baseRate, this.currentRate + 0.5);
      this.lastRampAt = now;
    }
  }

  _isPressureError(error) {
    const code = String(error?.code || "").toUpperCase();
    const message = String(error?.message || "").toLowerCase();
    return code === "EAI_AGAIN" || code === "ETIMEOUT" || code === "SERVFAIL" || message.includes("dns_lookup_timeout") || message.includes("temporary failure");
  }

  async _freshLookup(hostname) {
    await this._acquireToken();
    const started = Date.now();
    this.metrics.activeLookups += 1;
    this.metrics.freshLookups += 1;
    this._recordFreshLookup(started);
    try {
      const lookupPromise = dns.promises.lookup(hostname, { all: true, verbatim: true });
      const timeoutPromise = sleep(this.lookupTimeoutMs).then(() => {
        const error = new Error("dns_lookup_timeout");
        error.code = "ETIMEOUT";
        throw error;
      });
      const raw = await Promise.race([lookupPromise, timeoutPromise]);
      const addresses = this.validateAddresses(raw, hostname);
      const latency = Date.now() - started;
      this._recordLatency(latency, true);
      this._pruneCache();
      this.cache.set(hostname, { addresses, expiresAt: Date.now() + this.cacheTtlMs });
      return addresses;
    } catch (error) {
      const latency = Date.now() - started;
      this.metrics.errors += 1;
      this.metrics.lastError = String(error?.code || error?.message || "dns_lookup_failed");
      this.metrics.lastErrorAt = Date.now();
      this._recordLatency(latency, false);
      if (this._isPressureError(error)) this._enterPressure(this.metrics.lastError);
      throw error;
    } finally {
      this.metrics.activeLookups = Math.max(0, this.metrics.activeLookups - 1);
    }
  }

  async resolve(hostname) {
    const key = this._normalizeHost(hostname);
    if (!key) throw new Error("missing_hostname");
    this.metrics.totalRequests += 1;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      this.metrics.cacheHits += 1;
      return cached.addresses.map((entry) => ({ ...entry }));
    }
    if (cached) this.cache.delete(key);
    this.metrics.cacheMisses += 1;

    const existing = this.inflight.get(key);
    if (existing) {
      this.metrics.singleFlightShares += 1;
      const addresses = await existing;
      return addresses.map((entry) => ({ ...entry }));
    }

    const promise = this._freshLookup(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    const addresses = await promise;
    return addresses.map((entry) => ({ ...entry }));
  }

  status() {
    const now = Date.now();
    this._refill(now);
    const cutoff = now - 5_000;
    while (this.recentLookupTimes.length && this.recentLookupTimes[0] < now - 10_000) this.recentLookupTimes.shift();
    const recent5 = this.recentLookupTimes.filter((ts) => ts >= cutoff).length;
    const totalCacheDecisions = this.metrics.cacheHits + this.metrics.cacheMisses;
    return {
      pressure: this.pressureState(now),
      configuredRatePerSecond: this.baseRate,
      currentRateLimitPerSecond: Number(this.effectiveRate(now).toFixed(2)),
      maximumRatePerSecond: this.maxRate,
      minimumRatePerSecond: this.minRate,
      burst: this.burst,
      recentFreshLookupsPerSecond: Number((recent5 / 5).toFixed(2)),
      active: this.metrics.activeLookups,
      queued: this.queue.length,
      cacheEntries: this.cache.size,
      cacheTtlSeconds: Math.round(this.cacheTtlMs / 1000),
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
      cacheHitPercent: totalCacheDecisions ? Number(((this.metrics.cacheHits / totalCacheDecisions) * 100).toFixed(1)) : 0,
      singleFlightShares: this.metrics.singleFlightShares,
      totalRequests: this.metrics.totalRequests,
      freshLookups: this.metrics.freshLookups,
      errors: this.metrics.errors,
      slowLookups: this.metrics.slowLookups,
      pressureEvents: this.metrics.pressureEvents,
      averageLatencyMs: Math.round(this.metrics.ewmaLatencyMs || 0),
      lastLatencyMs: this.metrics.lastLatencyMs,
      lastError: this.metrics.lastError,
      lastErrorAt: this.metrics.lastErrorAt,
      lastPressureReason: this.metrics.lastPressureReason,
      throttledForMs: Math.max(0, this.pressureUntil - now)
    };
  }
}
