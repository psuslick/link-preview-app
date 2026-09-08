import { useEffect, useMemo, useRef, useState } from "react";
import {
  authorizationStatus,
  authorizePreviewHost,
  compareVideoSamples,
  fetchAlternates,
  fetchPreview,
  imageProxyUrl
} from "./api.js";
import "./App.css";

const CLIENT_CONCURRENCY = 12;
const BROWSER_FALLBACK_CONCURRENCY = 1;
const FINDER_CONCURRENCY = 2;
const BATCH_COMPARE_LIMIT = 5;
const PRIVACY_STORAGE_KEY = "linkPreviewPrivacyV1";
const FULL_PRIVACY = Object.freeze({
  remoteThumbnails: true,
  browserFallback: true,
  interactiveAuthorization: true,
  mediaTools: true,
  searchDuckDuckGo: true,
  searchBing: true,
  searchMojeek: true,
  searchBrave: true,
  archiveLookups: true,
  searchTitleUploader: true,
  searchMediaIds: true,
  searchDescription: true,
  searchTranscript: true,
  sampleComparison: true
});
const MINIMUM_PRIVACY = Object.freeze(Object.fromEntries(Object.keys(FULL_PRIVACY).map((key) => [key, false])));

function loadPrivacySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRIVACY_STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") return { ...FULL_PRIVACY, ...saved };
  } catch {}
  return { ...FULL_PRIVACY };
}

function PrivacyToggle({ checked, onChange, title, detail }) {
  return (
    <label className="privacy-toggle">
      <span className="privacy-toggle-copy"><strong>{title}</strong><small>{detail}</small></span>
      <span className={`toggle-switch ${checked ? "on" : "off"}`} aria-hidden="true"><i /></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractUrls(text) {
  const candidates = text
    .split(/\s+/)
    .map((value) => value.trim().replace(/^[<\[("']+|[>\])}"',;]+$/g, ""))
    .filter(Boolean);
  const seen = new Set();
  const valid = [];
  let invalid = 0;
  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate);
    if (!normalized) { invalid += 1; continue; }
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(normalized);
  }
  return { urls: valid, invalid };
}

function domainFor(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "Unknown source"; }
}

function siteKeyFor(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function needsAuthorizedSiteRetry(item) {
  if (!item || item.image || item.state === "loading") return false;
  return Boolean(
    item.siteSessionRecommended ||
    item.challengeDetected ||
    item.needsBrowserFallback ||
    item.browserFallbackSkippedReason === "challenge_page_detected" ||
    item.warning === "challenge_page_detected" ||
    item.method === "blocked-no-thumbnail" ||
    item.method === "edge-no-thumbnail" ||
    (item.method === "metadata-no-thumbnail" && item.browserFallbackAttempted && item.browserFallbackError)
  );
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return null;
  const total = Math.round(Number(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function LazyThumbnail({ sources, sourceUrl, title, allowRemoteImages = true }) {
  const holderRef = useRef(null);
  const candidates = useMemo(() => {
    const values = Array.isArray(sources) ? sources : sources ? [sources] : [];
    return [...new Set(values.filter(Boolean))];
  }, [sources]);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
    setShouldLoad(false);
    if (!candidates.length || !allowRemoteImages) return undefined;
    if (typeof IntersectionObserver === "undefined") { setShouldLoad(true); return undefined; }
    const node = holderRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShouldLoad(true);
        observer.disconnect();
      }
    }, { rootMargin: "700px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [candidates, allowRemoteImages]);

  const current = candidates[candidateIndex] || null;
  const exhausted = candidates.length > 0 && candidateIndex >= candidates.length;
  return (
    <div className="thumbnail-shell" ref={holderRef}>
      {allowRemoteImages && current && shouldLoad && !exhausted ? (
        <img
          key={`${current}-${candidateIndex}`}
          src={imageProxyUrl(current, sourceUrl)}
          alt={title || "Video thumbnail"}
          className="preview-image"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setCandidateIndex((index) => index + 1)}
        />
      ) : (
        <div className="thumbnail-placeholder">
          <span>{!allowRemoteImages ? "Remote thumbnails disabled" : !candidates.length || exhausted ? "Thumbnail unavailable" : shouldLoad ? "Trying alternate thumbnail…" : "Thumbnail queued…"}</span>
        </div>
      )}
      <div className="play-mark" aria-hidden="true">▶</div>
      {candidates.length > 1 && candidateIndex < candidates.length && (
        <div className="thumbnail-candidate-count" title="Thumbnail fallback candidate">{candidateIndex + 1}/{candidates.length}</div>
      )}
    </div>
  );
}

async function runPool(items, worker, concurrency = CLIENT_CONCURRENCY) {
  let nextIndex = 0;
  const count = Math.min(concurrency, items.length);
  const workers = Array.from({ length: count }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      await worker(items[current], current);
    }
  });
  await Promise.all(workers);
}

function FinderResult({ job, candidate, alreadyInList, onAdd, onCompare, privacy }) {
  const candidateDuration = formatDuration(candidate.durationSeconds);
  const sourceDuration = Number(job.source?.durationSeconds) || 0;
  const longerBy = sourceDuration && candidate.durationSeconds > sourceDuration
    ? formatDuration(candidate.durationSeconds - sourceDuration)
    : null;
  const comparison = candidate.comparison || null;
  const relation = comparison?.state === "ready" && comparison.result?.relation
    ? comparison.result.relation
    : candidate.relation || "Discovered candidate";

  return (
    <article className="alternate-result">
      <div className="alternate-thumb">
        <LazyThumbnail
          sources={candidate.images?.length ? candidate.images : candidate.image ? [candidate.image] : []}
          sourceUrl={candidate.url}
          title={candidate.title}
          allowRemoteImages={privacy.remoteThumbnails}
        />
      </div>
      <div className="alternate-result-body">
        <div className="alternate-result-topline">
          <span className={`relation-badge ${/longer/i.test(relation) ? "longer" : /mirror|same footage/i.test(relation) ? "mirror" : "possible"}`}>{relation}</span>
          <span className="confidence-badge">{candidate.confidence ?? 0}% rank</span>
          {candidateDuration && <span className="duration-badge">{candidateDuration}</span>}
          {longerBy && <span className="longer-by">+{longerBy}</span>}
        </div>
        <h3>{candidate.title || candidate.url}</h3>
        <div className="alternate-domain">{candidate.provider || domainFor(candidate.url)}</div>
        {(candidate.overlap?.matchedIds?.length > 0 || candidate.overlap?.matchedFilenames?.length > 0 || candidate.discovery?.length > 0) && (
          <div className="candidate-evidence">
            {candidate.overlap?.matchedIds?.slice(0, 2).map((value) => <span key={`id-${value}`}>Verified ID: {value}</span>)}
            {candidate.overlap?.matchedFilenames?.slice(0, 2).map((value) => <span key={`file-${value}`}>Verified file: {value}</span>)}
            {candidate.discovery?.slice(0, 3).map((entry, index) => <span className="discovery-chip" key={`${entry.kind}-${index}`}>Found via {entry.engine}: {entry.kind}</span>)}
          </div>
        )}
        {candidate.searchSupport && (
          <div className="search-support-note">
            Discovery support: {candidate.searchSupport.engineCount} engine{candidate.searchSupport.engineCount === 1 ? "" : "s"} · {candidate.searchSupport.queryCount} quer{candidate.searchSupport.queryCount === 1 ? "y" : "ies"}
            {!candidate.strongIdentity && " · not identity evidence"}
          </div>
        )}
        {candidate.subject && (
          <div className="search-support-note">Subject relevance: {Math.round((candidate.subject.score || 0) * 100)}%{candidate.subject.matched?.length ? ` · anchors: ${candidate.subject.matched.slice(0, 5).join(", ")}` : ""}</div>
        )}
        {candidate.description && <p>{candidate.description}</p>}

        {comparison?.state === "loading" && (
          <div className="frame-compare-status"><span className="mini-spinner" /> Sampling remote frames…</div>
        )}
        {comparison?.state === "failed" && (
          <div className="frame-compare-status failed-text">Frame comparison: {comparison.error || "failed"}</div>
        )}
        {comparison?.state === "ready" && comparison.result && (
          <div className={`frame-compare-status ${comparison.result.verified ? "verified" : comparison.result.possible ? "possible" : "no-match"}`}>
            <strong>{comparison.result.relation}</strong>
            <span>{comparison.result.similarity}% perceptual similarity</span>
            <span>{comparison.result.sourceFrames} source / {comparison.result.candidateFrames} candidate frames</span>
            {Number.isFinite(comparison.result.averageDistance) && <span>avg dHash distance {comparison.result.averageDistance}</span>}
          </div>
        )}

        <div className="alternate-result-actions">
          <a href={candidate.url} target="_blank" rel="noopener noreferrer">Open candidate ↗</a>
          <button type="button" onClick={() => onAdd(candidate)} disabled={candidate.added || alreadyInList}>
            {candidate.added || alreadyInList ? "Already in list" : "Add to list"}
          </button>
          <button type="button" onClick={() => onCompare(candidate)} disabled={!privacy.sampleComparison || comparison?.state === "loading"} title={privacy.sampleComparison ? "Best-effort low-resolution perceptual frame comparison. Does not download the complete video." : "Disabled in Privacy & network activity."}>
            {!privacy.sampleComparison ? "Comparison disabled" : comparison?.state === "ready" ? "Compare again" : comparison?.state === "loading" ? "Comparing…" : "Compare samples"}
          </button>
        </div>
      </div>
    </article>
  );
}

function App() {
  const [inputText, setInputText] = useState("");
  const [previews, setPreviews] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [processing, setProcessing] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [activeTab, setActiveTab] = useState("previews");
  const [finderJobs, setFinderJobs] = useState([]);
  const finderRunningRef = useRef(new Set());
  const autoSiteRecoveryQueueRef = useRef([]);
  const autoSiteRecoveryHostsRef = useRef(new Set());
  const autoSiteRecoveryRunningRef = useRef(false);
  const [privacy, setPrivacy] = useState(loadPrivacySettings);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(PRIVACY_STORAGE_KEY, JSON.stringify(privacy)); } catch {}
  }, [privacy]);

  const enabledPrivacyCount = useMemo(() => Object.values(privacy).filter(Boolean).length, [privacy]);
  const finderSearchEnabled = useMemo(() =>
    (privacy.searchDuckDuckGo || privacy.searchBing || privacy.searchMojeek || privacy.searchBrave || privacy.archiveLookups) &&
    (privacy.searchTitleUploader || privacy.searchMediaIds || privacy.searchDescription || privacy.searchTranscript), [privacy]);
  function setPrivacyOption(key, value) { setPrivacy((current) => ({ ...current, [key]: Boolean(value) })); }


  const stats = useMemo(() => {
    let queued = 0, loading = 0, ready = 0, failed = 0;
    for (const item of previews) {
      if (item.state === "queued") queued += 1;
      else if (item.state === "loading") loading += 1;
      else if (item.state === "failed") failed += 1;
      else if (item.state === "ready") ready += 1;
    }
    return { queued, loading, ready, failed, total: previews.length };
  }, [previews]);

  const livePreviews = useMemo(() => previews.filter((item) => !item.deadLink), [previews]);
  const deadPreviews = useMemo(() => previews.filter((item) => item.deadLink), [previews]);
  const visiblePreviews = activeTab === "dead" ? deadPreviews : livePreviews;
  const visibleStats = useMemo(() => {
    let queued = 0, loading = 0, ready = 0, failed = 0;
    for (const item of visiblePreviews) {
      if (item.state === "queued") queued += 1;
      else if (item.state === "loading") loading += 1;
      else if (item.state === "failed") failed += 1;
      else if (item.state === "ready") ready += 1;
    }
    return { queued, loading, ready, failed, total: visiblePreviews.length };
  }, [visiblePreviews]);

  const finderStats = useMemo(() => {
    const summary = { queued: 0, running: 0, ready: 0, failed: 0, total: finderJobs.length };
    for (const job of finderJobs) if (Object.prototype.hasOwnProperty.call(summary, job.state)) summary[job.state] += 1;
    return summary;
  }, [finderJobs]);

  function patchPreview(id, patch) {
    setPreviews((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }
  function patchFinderJob(id, patch) {
    setFinderJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job));
  }
  function patchFinderCandidate(jobId, candidateUrl, patch) {
    setFinderJobs((current) => current.map((job) => job.id !== jobId ? job : {
      ...job,
      results: (job.results || []).map((candidate) => candidate.url === candidateUrl ? { ...candidate, ...patch } : candidate),
      lowRelevanceResults: (job.lowRelevanceResults || []).map((candidate) => candidate.url === candidateUrl ? { ...candidate, ...patch } : candidate)
    }));
  }

  async function processItems(items) {
    if (!items.length) return;
    setProcessing(true);
    const browserFallbackItems = [];
    const autoSessionItems = [];
    try {
      await runPool(items, async (item) => {
        patchPreview(item.id, { state: "loading", error: null });
        const result = await fetchPreview(item.url, { allowBrowserFallback: false, privacy });
        patchPreview(item.id, {
          ...result,
          state: result.clientOk ? "ready" : "failed",
          error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
        });
        if (result.clientOk && result.needsBrowserFallback) browserFallbackItems.push(item);
        else if (result.clientOk && needsAuthorizedSiteRetry(result)) autoSessionItems.push({ ...item, ...result });
      });

      if (privacy.browserFallback && browserFallbackItems.length) {
        // Probe only one URL per host with unattended Edge first. If that representative
        // shows the site needs an interactive session, open/recover that site once and
        // send all sibling URLs through the reusable authorized profile instead of
        // timing out Edge separately for every video on the same domain.
        const fallbackGroups = new Map();
        for (const item of browserFallbackItems) {
          const host = siteKeyFor(item.url) || item.url;
          if (!fallbackGroups.has(host)) fallbackGroups.set(host, []);
          fallbackGroups.get(host).push(item);
        }
        const remainingFallbackItems = [];
        for (const [host, hostItems] of fallbackGroups) {
          const first = hostItems[0];
          patchPreview(first.id, { state: "loading", error: null, method: "edge-fallback-queued" });
          const result = await fetchPreview(first.url, { allowBrowserFallback: true, privacy });
          patchPreview(first.id, {
            ...result,
            state: result.clientOk ? "ready" : "failed",
            error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
          });
          if (result.clientOk && needsAuthorizedSiteRetry(result)) {
            // Include all same-host siblings, even though we intentionally skipped their
            // unattended Edge attempt. Automatic site recovery will navigate the exact
            // URLs one at a time using the shared authorized site session.
            queueAutomaticSiteRecovery(hostItems.map((item, index) => index === 0 ? { ...item, ...result } : item));
          } else {
            remainingFallbackItems.push(...hostItems.slice(1));
          }
        }

        if (remainingFallbackItems.length) {
          await runPool(remainingFallbackItems, async (item) => {
            patchPreview(item.id, { state: "loading", error: null, method: "edge-fallback-queued" });
            const result = await fetchPreview(item.url, { allowBrowserFallback: true, privacy });
            patchPreview(item.id, {
              ...result,
              state: result.clientOk ? "ready" : "failed",
              error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
            });
            if (result.clientOk && needsAuthorizedSiteRetry(result)) autoSessionItems.push({ ...item, ...result });
          }, BROWSER_FALLBACK_CONCURRENCY);
        }
      }
    } finally {
      setProcessing(false);
      if (autoSessionItems.length) queueAutomaticSiteRecovery(autoSessionItems);
    }
  }

  async function processSinglePreview(item, extraPatch = {}) {
    patchPreview(item.id, { state: "loading", error: null, method: "retrying", ...extraPatch });
    const result = await fetchPreview(item.url, { allowBrowserFallback: privacy.browserFallback, privacy });
    patchPreview(item.id, {
      ...result,
      state: result.clientOk ? "ready" : "failed",
      error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
    });
    return result;
  }

  function queueAutomaticSiteRecovery(items) {
    if (!privacy.browserFallback || !privacy.interactiveAuthorization) return;
    const byHost = new Map();
    for (const item of items) {
      const host = siteKeyFor(item.url);
      if (!host || autoSiteRecoveryHostsRef.current.has(host)) continue;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(item);
    }
    for (const [host, hostItems] of byHost) {
      autoSiteRecoveryHostsRef.current.add(host);
      autoSiteRecoveryQueueRef.current.push({ host, items: hostItems });
    }
    void drainAutomaticSiteRecovery();
  }

  async function drainAutomaticSiteRecovery() {
    if (autoSiteRecoveryRunningRef.current) return;
    autoSiteRecoveryRunningRef.current = true;
    try {
      while (autoSiteRecoveryQueueRef.current.length) {
        const task = autoSiteRecoveryQueueRef.current.shift();
        const first = task.items[0];
        if (!first) continue;
        patchPreview(first.id, { authorizationState: "launching", authorizationMessage: `Automatically opening one reusable site session for ${task.host}…` });
        const launch = await authorizePreviewHost(first.url, { privacy });
        if (!launch.clientOk) {
          patchPreview(first.id, { authorizationState: "failed", authorizationMessage: launch.error || "Automatic site session failed to open." });
          continue;
        }
        let success = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2200 : 1600));
          const result = await processSinglePreview(first, { authorizationState: "auto-retry", authorizationMessage: `Automatically reusing ${task.host} site session…` });
          if (result?.clientOk && result.image) { success = true; break; }
        }
        if (success) {
          const siblings = task.items.slice(1);
          for (const sibling of siblings) await processSinglePreview(sibling, { authorizationState: "site-retry", authorizationMessage: `Automatically reusing ${task.host} site session…` });
          patchPreview(first.id, { authorizationState: "site-ready", authorizationMessage: `Site session active for ${task.host}; unresolved links from this host were retried automatically.` });
        } else {
          patchPreview(first.id, { authorizationState: "needs-attention", authorizationMessage: `Automatic refresh/ordinary consent did not finish this site. If the visible window shows CAPTCHA, age confirmation, login, or another access-control prompt, complete it once and press Retry.` });
        }
      }
    } finally { autoSiteRecoveryRunningRef.current = false; }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (processing || !inputText.trim()) return;
    const parsed = extractUrls(inputText);
    const existing = new Set(previews.map((item) => item.url.toLowerCase()));
    const newUrls = parsed.urls.filter((url) => !existing.has(url.toLowerCase()));
    const duplicateCount = parsed.urls.length - newUrls.length;
    const stamp = Date.now();
    const items = newUrls.map((url, index) => ({
      id: `${stamp}-${index}`, url, state: "queued", title: null, description: null,
      image: null, provider: null, method: null, error: null
    }));
    setImportSummary({ added: items.length, duplicates: duplicateCount, invalid: parsed.invalid });
    setInputText("");
    if (!items.length) return;
    setPreviews((current) => [...current, ...items]);
    await processItems(items);
  }

  function toggleSelected(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAll() { setSelected(new Set(visiblePreviews.map((item) => item.id))); }
  function clearSelection() { setSelected(new Set()); }
  function invertSelection() {
    setSelected((current) => {
      const next = new Set();
      for (const item of visiblePreviews) if (!current.has(item.id)) next.add(item.id);
      return next;
    });
  }
  async function copySelected() {
    const urls = previews.filter((item) => selected.has(item.id)).map((item) => item.url);
    if (!urls.length) return;
    try { await navigator.clipboard.writeText(urls.join("\r\n")); setCopyStatus(`Copied ${urls.length} URL${urls.length === 1 ? "" : "s"}`); }
    catch { setCopyStatus("Clipboard copy failed"); }
    setTimeout(() => setCopyStatus(""), 2200);
  }
  function removeSelected() {
    if (processing || !selected.size) return;
    setPreviews((current) => current.filter((item) => !selected.has(item.id)));
    setSelected(new Set());
  }
  function clearAll() {
    if (processing) return;
    setPreviews([]); setSelected(new Set()); setImportSummary(null);
  }
  async function retryFailed() {
    if (processing) return;
    await processItems(visiblePreviews.filter((item) => item.state === "failed" || item.deadLink));
  }

  function queueSelectedVersionSearches() {
    if (!finderSearchEnabled) { setCopyStatus("Enable a search engine and at least one finder query signal in Privacy & network activity"); setTimeout(() => setCopyStatus(""), 3200); return; }
    const sources = previews.filter((item) => selected.has(item.id));
    if (!sources.length) return;
    const now = Date.now();
    const activeSourceUrls = new Set(
      finderJobs.filter((job) => ["queued", "running"].includes(job.state)).map((job) => job.source.url.toLowerCase())
    );
    const jobs = sources.filter((source) => !activeSourceUrls.has(source.url.toLowerCase())).map((source, index) => ({
      id: `finder-${now}-${index}-${Math.random().toString(36).slice(2, 7)}`,
      source: { ...source }, privacy: { ...privacy }, state: "queued", results: [], lowRelevanceResults: [], error: null, queuedAt: Date.now(),
      note: null, diagnostics: [], queryEvidence: [], candidateCount: 0, rawDiscovered: [], rawDiscoveredCount: 0, evaluatedCount: 0, toolEvaluatedCount: 0, batchCompareState: "idle", batchCompareProgress: null
    }));
    if (!jobs.length) { setCopyStatus("Selected videos are already queued/running"); setTimeout(() => setCopyStatus(""), 2200); return; }
    setFinderJobs((current) => [...jobs, ...current]);
    setCopyStatus(`Queued ${jobs.length} version search${jobs.length === 1 ? "" : "es"}`);
    setTimeout(() => setCopyStatus(""), 2200);
  }

  async function executeFinderJob(job) {
    patchFinderJob(job.id, { state: "running", startedAt: Date.now(), error: null });
    const result = await fetchAlternates(job.source, { privacy: job.privacy || privacy });
    if (!result.clientOk) {
      patchFinderJob(job.id, { state: "failed", finishedAt: Date.now(), error: result.error || `Search failed (${result.clientStatus || "network"})`, clientMs: result.clientMs });
      return;
    }
    patchFinderJob(job.id, {
      state: "ready", finishedAt: Date.now(),
      source: { ...job.source, ...(result.source || {}) },
      results: Array.isArray(result.results) ? result.results : [],
      lowRelevanceResults: Array.isArray(result.lowRelevanceResults) ? result.lowRelevanceResults : [],
      note: result.note || null,
      diagnostics: result.searchDiagnostics || [],
      candidateCount: result.candidateCount || 0,
      rawDiscovered: Array.isArray(result.rawDiscovered) ? result.rawDiscovered : [],
      rawDiscoveredCount: result.rawDiscoveredCount || result.candidateCount || 0,
      rawDiscoveredTruncated: Boolean(result.rawDiscoveredTruncated),
      evaluatedCount: result.evaluatedCount || 0,
      toolEvaluatedCount: result.toolEvaluatedCount || 0,
      cached: Boolean(result.cached),
      clientMs: result.clientMs,
      manualSearchUrl: result.manualSearchUrl || null,
      sourceSignals: result.sourceSignals || null,
      tools: result.tools || null,
      searchPolicy: result.searchPolicy || null,
      queryEvidence: result.queryEvidence || [],
      archiveRecovery: result.archiveRecovery || null
    });
  }

  useEffect(() => {
    const openSlots = Math.max(0, FINDER_CONCURRENCY - finderRunningRef.current.size);
    if (!openSlots) return;
    const queued = finderJobs.filter((job) => job.state === "queued" && !finderRunningRef.current.has(job.id)).slice(0, openSlots);
    for (const job of queued) {
      finderRunningRef.current.add(job.id);
      executeFinderJob(job).finally(() => {
        finderRunningRef.current.delete(job.id);
        setFinderJobs((current) => [...current]);
      });
    }
  }, [finderJobs]);

  function retryFinderJob(job) {
    patchFinderJob(job.id, { state: "queued", privacy: { ...privacy }, results: [], lowRelevanceResults: [], rawDiscovered: [], rawDiscoveredCount: 0, error: null, diagnostics: [], queryEvidence: [], archiveRecovery: null, cached: false, batchCompareState: "idle", batchCompareProgress: null });
  }
  function removeFinderJob(id) { setFinderJobs((current) => current.filter((job) => job.id !== id)); }
  function clearCompletedFinderJobs() { setFinderJobs((current) => current.filter((job) => ["queued", "running"].includes(job.state))); }

  function addAlternate(jobId, candidate) {
    const normalized = candidate.url?.toLowerCase();
    if (!normalized) return;
    const existing = previews.find((item) => item.url.toLowerCase() === normalized);
    if (!existing) {
      setPreviews((current) => [...current, {
        id: `alternate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        url: candidate.url, state: "ready", title: candidate.title || null, description: candidate.description || null,
        image: candidate.image || null, images: candidate.images || (candidate.image ? [candidate.image] : []),
        provider: candidate.provider || null, durationSeconds: candidate.durationSeconds || null,
        method: candidate.method || "alternate-search", error: null,
        alternateRelation: candidate.comparison?.result?.relation || candidate.relation || null,
        alternateConfidence: candidate.confidence || null
      }]);
    }
    patchFinderCandidate(jobId, candidate.url, { added: true });
  }

  async function compareCandidate(job, candidate, privacyOverride = null) {
    const comparisonPrivacy = privacyOverride || job.privacy || privacy;
    patchFinderCandidate(job.id, candidate.url, { comparison: { state: "loading" } });
    if (!comparisonPrivacy.sampleComparison) {
      patchFinderCandidate(job.id, candidate.url, { comparison: { state: "failed", error: "comparison_disabled" } });
      return null;
    }
    const result = await compareVideoSamples(job.source.url, candidate.url, { privacy: comparisonPrivacy });
    if (!result.clientOk || !result.ok) {
      patchFinderCandidate(job.id, candidate.url, { comparison: { state: "failed", error: result.error || "frame_compare_failed" } });
      return null;
    }
    patchFinderCandidate(job.id, candidate.url, { comparison: { state: "ready", result } });
    return result;
  }

  async function compareTopCandidates(job) {
    if ((job.batchCompareState || "idle") === "running") return;
    const comparisonPrivacy = job.privacy || privacy;
    if (!comparisonPrivacy.sampleComparison) {
      setCopyStatus("Sample comparison was disabled in this finder job's privacy snapshot");
      setTimeout(() => setCopyStatus(""), 2600);
      return;
    }
    const targets = (job.results || [])
      .filter((candidate) => candidate.comparison?.state !== "loading")
      .slice(0, BATCH_COMPARE_LIMIT);
    if (!targets.length) return;

    patchFinderJob(job.id, { batchCompareState: "running", batchCompareProgress: { done: 0, total: targets.length } });
    let done = 0;
    try {
      for (const candidate of targets) {
        await compareCandidate(job, candidate, comparisonPrivacy);
        done += 1;
        patchFinderJob(job.id, { batchCompareProgress: { done, total: targets.length } });
      }
    } finally {
      patchFinderJob(job.id, { batchCompareState: "ready", batchCompareProgress: { done, total: targets.length } });
    }
  }

  async function authorizeSite(preview) {
    patchPreview(preview.id, { authorizationState: "launching", authorizationMessage: null });
    if (!privacy.interactiveAuthorization || !privacy.browserFallback) {
      patchPreview(preview.id, { authorizationState: "disabled", authorizationMessage: "Enable Edge fallback and interactive authorization in Privacy & network activity." });
      return;
    }
    const result = await authorizePreviewHost(preview.url, { privacy });
    if (!result.clientOk) {
      patchPreview(preview.id, { authorizationState: "failed", authorizationMessage: result.error || "Unable to open authorization browser" });
      return;
    }
    patchPreview(preview.id, {
      authorizationState: "authorizing",
      authorizationMessage: `Reusable site session opened for ${siteKeyFor(preview.url)}. The app will try one automatic refresh and recognized cookie/privacy consent buttons. CAPTCHA/challenge, age confirmation, login, or other access-control prompts remain manual. Once the real video is visible, click Retry once; the session is reused for the site.`
    });
  }

  async function retryAuthorizedPreview(preview) {
    const status = await authorizationStatus(preview.url);
    if (status.clientOk && status.live) {
      patchPreview(preview.id, {
        authorizationState: "authorizing",
        authorizationMessage: "Reading this exact URL through the reusable Sandbox site session…"
      });
    } else if (status.clientOk && status.ready) {
      patchPreview(preview.id, { authorizationState: "ready", authorizationMessage: "Reusable Sandbox site profile ready." });
    }

    const result = await processSinglePreview(preview);
    if (!result?.clientOk || !result.image) return;

    const siteKey = siteKeyFor(preview.url);
    if (!siteKey) return;
    const siblings = previews.filter((item) =>
      item.id !== preview.id &&
      siteKeyFor(item.url) === siteKey &&
      needsAuthorizedSiteRetry(item)
    );
    if (!siblings.length) {
      patchPreview(preview.id, {
        authorizationState: "site-ready",
        authorizationMessage: `Site session active for ${siteKey}. Other previews from this site can reuse it.`
      });
      return;
    }

    patchPreview(preview.id, {
      authorizationState: "site-ready",
      authorizationMessage: `Site session active for ${siteKey}. Automatically retrying ${siblings.length} other preview${siblings.length === 1 ? "" : "s"} from this site.`
    });
    for (const sibling of siblings) {
      await processSinglePreview(sibling, {
        authorizationState: "site-retry",
        authorizationMessage: `Reusing authorized ${siteKey} session automatically…`
      });
    }
  }

  function handleCardClick(event, id) {
    if (event.target.closest("a,button,input,summary,details")) return;
    toggleSelected(id);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Video Link Preview</h1>
          <p className="subtitle">Paste hundreds of video links. Preview and version-finder traffic are queued and rate-limited.</p>
        </div>
        <div className="topbar-statuses">
          <div className="limit-badge">{CLIENT_CONCURRENCY} preview workers · {BROWSER_FALLBACK_CONCURRENCY} browser fallback</div>
          {finderStats.total > 0 && <div className="limit-badge finder-badge">Finder: {finderStats.running} running · {finderStats.queued} queued</div>}
        </div>
      </header>

      <section className="import-panel">
        <form onSubmit={handleSubmit} className="input-form">
          <textarea placeholder="Paste video URLs here — one per line or separated by whitespace…" value={inputText} onChange={(event) => setInputText(event.target.value)} className="multi-input" disabled={processing} />
          <button type="submit" className="primary-button" disabled={processing || !inputText.trim()}>{processing ? "Processing…" : "Create previews"}</button>
        </form>
        {importSummary && (
          <div className="import-summary">
            <strong>{importSummary.added}</strong> added <span>·</span> <strong>{importSummary.duplicates}</strong> duplicates skipped
            {importSummary.invalid > 0 && <><span>·</span> <strong>{importSummary.invalid}</strong> invalid entries ignored</>}
          </div>
        )}
      </section>

      <section className={`privacy-panel ${privacyOpen ? "open" : ""}`}>
        <button type="button" className="privacy-panel-summary" onClick={() => setPrivacyOpen((value) => !value)} aria-expanded={privacyOpen}>
          <span><strong>Privacy & network activity</strong><small>{enabledPrivacyCount}/{Object.keys(FULL_PRIVACY).length} optional outbound features enabled · basic preview-page requests always occur when you create previews</small></span>
          <span className="privacy-summary-actions"><b>{privacyOpen ? "Hide" : "Configure"}</b><i>{privacyOpen ? "▴" : "▾"}</i></span>
        </button>
        {privacyOpen && (
          <div className="privacy-panel-body">
            <div className="privacy-presets">
              <div><strong>Sandbox-session controls</strong><p>These settings are stored only in this disposable Sandbox browser profile. They do not change the host or the .wsb file.</p></div>
              <div className="privacy-preset-buttons"><button type="button" onClick={() => setPrivacy({ ...FULL_PRIVACY })}>Full functionality</button><button type="button" onClick={() => setPrivacy({ ...MINIMUM_PRIVACY })}>Minimum exposure</button></div>
            </div>
            <div className="privacy-groups">
              <div className="privacy-group"><h3>Preview browsing</h3>
                <PrivacyToggle checked={privacy.remoteThumbnails} onChange={(v) => setPrivacyOption("remoteThumbnails", v)} title="Load remote thumbnails" detail="Downloads discovered poster/thumbnail images through the localhost safety proxy." />
                <PrivacyToggle checked={privacy.browserFallback} onChange={(v) => setPrivacyOption("browserFallback", v)} title="Edge browser fallback" detail="Lets Sandbox Edge load difficult video pages when lightweight metadata is insufficient." />
                <PrivacyToggle checked={privacy.interactiveAuthorization} onChange={(v) => setPrivacyOption("interactiveAuthorization", v)} title="Automatic site session recovery" detail="Automatically opens one reusable Sandbox Edge session after a no-thumbnail browser failure, refreshes once, and clicks recognized cookie/privacy consent. CAPTCHA, age, login, and other access-control prompts remain manual." />
              </div>
              <div className="privacy-group"><h3>Version Finder — destinations</h3>
                <PrivacyToggle checked={privacy.mediaTools} onChange={(v) => setPrivacyOption("mediaTools", v)} title="Media-tool probing" detail="Allows yt-dlp/Deno to inspect selected and candidate public video pages/CDNs inside Sandbox." />
                <PrivacyToggle checked={privacy.searchDuckDuckGo} onChange={(v) => setPrivacyOption("searchDuckDuckGo", v)} title="DuckDuckGo search" detail="Sends enabled finder queries to DuckDuckGo's public search endpoint." />
                <PrivacyToggle checked={privacy.searchBing} onChange={(v) => setPrivacyOption("searchBing", v)} title="Bing search" detail="Sends enabled finder queries to Bing's public search endpoint." />
                <PrivacyToggle checked={privacy.searchMojeek} onChange={(v) => setPrivacyOption("searchMojeek", v)} title="Mojeek search" detail="Sends enabled finder queries to Mojeek's public search endpoint." />
                <PrivacyToggle checked={privacy.searchBrave} onChange={(v) => setPrivacyOption("searchBrave", v)} title="Brave Search" detail="Uses Brave's independent web index with Safe Search explicitly requested off." />
                <PrivacyToggle checked={privacy.archiveLookups} onChange={(v) => setPrivacyOption("archiveLookups", v)} title="Archive discovery" detail="Queries Archive.org media search plus Wayback/Common Crawl captures to recover dead or poorly indexed source clues and archived outbound embeds." />
              </div>
              <div className="privacy-group"><h3>Version Finder — query contents</h3>
                <PrivacyToggle checked={privacy.searchTitleUploader} onChange={(v) => setPrivacyOption("searchTitleUploader", v)} title="Title & uploader" detail="May send the video's title and uploader/channel name to enabled search engines." />
                <PrivacyToggle checked={privacy.searchMediaIds} onChange={(v) => setPrivacyOption("searchMediaIds", v)} title="Media IDs & filenames" detail="May send discovered asset IDs, filename stems, or URL-path identifiers to enabled search engines." />
                <PrivacyToggle checked={privacy.searchDescription} onChange={(v) => setPrivacyOption("searchDescription", v)} title="Description phrases" detail="May send a distinctive phrase extracted from the video's description." />
                <PrivacyToggle checked={privacy.searchTranscript} onChange={(v) => setPrivacyOption("searchTranscript", v)} title="Transcript/subtitle phrases" detail="May download public subtitles and send one distinctive phrase to enabled search engines." />
              </div>
              <div className="privacy-group"><h3>Verification</h3>
                <PrivacyToggle checked={privacy.sampleComparison} onChange={(v) => setPrivacyOption("sampleComparison", v)} title="Perceptual sample comparison" detail="Allows FFmpeg to download small remote video samples for local frame comparison." />
              </div>
            </div>
            <div className="privacy-footnote"><strong>Always local:</strong> selection state, queues, ranking, perceptual hashes, temporary browser profiles, and caches remain inside Windows Sandbox. <strong>Always required for basic previews:</strong> creating a preview contacts the pasted public video URL itself.</div>
          </div>
        )}
      </section>

      <nav className="workspace-tabs" aria-label="Workspace">
        <button type="button" className={activeTab === "previews" ? "active" : ""} onClick={() => setActiveTab("previews")}>Previews <span>{livePreviews.length}</span></button>
        <button type="button" className={activeTab === "dead" ? "active" : ""} onClick={() => setActiveTab("dead")}>Dead Links <span>{deadPreviews.length}</span></button>
        <button type="button" className={activeTab === "finder" ? "active" : ""} onClick={() => setActiveTab("finder")}>
          Version Finder <span>{finderJobs.length}</span>
          {(finderStats.running > 0 || finderStats.queued > 0) && <i>{finderStats.running + finderStats.queued}</i>}
        </button>
      </nav>

      {copyStatus && <div className="copy-toast workspace-toast">{copyStatus}</div>}

      {(activeTab === "previews" || activeTab === "dead") && (
        <>
          {visiblePreviews.length > 0 && (
            <>
              <section className="status-strip">
                <div className="progress-copy">
                  <strong>{visibleStats.ready + visibleStats.failed} / {visibleStats.total}</strong> processed
                  {visibleStats.loading > 0 && <span> · {visibleStats.loading} active</span>}
                  {visibleStats.queued > 0 && <span> · {visibleStats.queued} queued</span>}
                  {visibleStats.failed > 0 && <span className="failed-text"> · {visibleStats.failed} failed</span>}
                </div>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${visibleStats.total ? ((visibleStats.ready + visibleStats.failed) / visibleStats.total) * 100 : 0}%` }} /></div>
              </section>

              <section className="actionbar">
                <div className="selection-count">{selected.size} selected</div>
                <div className="action-buttons">
                  <button type="button" onClick={selectAll}>Select all</button>
                  <button type="button" onClick={clearSelection}>Deselect</button>
                  <button type="button" onClick={invertSelection}>Invert</button>
                  <button type="button" onClick={copySelected} disabled={!selected.size}>Copy selected URLs</button>
                  <button type="button" onClick={queueSelectedVersionSearches} disabled={!selected.size || !finderSearchEnabled} title={finderSearchEnabled ? "Queue selected videos for independent background version searches" : "Enable a search engine and finder query signal in Privacy & network activity"}>Queue version search{selected.size > 1 ? ` (${selected.size})` : ""}</button>
                  <button type="button" onClick={removeSelected} disabled={!selected.size || processing}>Remove selected</button>
                  {visibleStats.failed > 0 && <button type="button" onClick={retryFailed} disabled={processing}>Retry failed</button>}
                  <button type="button" onClick={clearAll} disabled={processing}>Clear all</button>
                </div>
              </section>

              <section className="preview-grid">
                {visiblePreviews.map((preview) => {
                  const isSelected = selected.has(preview.id);
                  const duration = formatDuration(preview.durationSeconds);
                  const siteSessionEligible = needsAuthorizedSiteRetry(preview);
                  return (
                    <article key={preview.id} className={`preview-card ${isSelected ? "selected" : ""} ${preview.state}`} onClick={(event) => handleCardClick(event, preview.id)}>
                      <div className="card-selector"><input type="checkbox" checked={isSelected} onChange={() => toggleSelected(preview.id)} aria-label={`Select ${preview.title || preview.url}`} /></div>
                      {preview.state === "queued" || preview.state === "loading" ? (
                        <div className="thumbnail-shell"><div className="thumbnail-placeholder pulse"><span>{preview.state === "queued" ? "Queued…" : "Finding video thumbnail…"}</span></div></div>
                      ) : (
                        <LazyThumbnail sources={preview.images?.length ? preview.images : preview.image ? [preview.image] : []} sourceUrl={preview.url} title={preview.title} allowRemoteImages={privacy.remoteThumbnails} />
                      )}
                      <div className="preview-content">
                        <div className="meta-row">
                          <span className="source-domain">{preview.provider || domainFor(preview.url)}</span>
                          {duration && <span className="duration-badge">{duration}</span>}
                          {preview.alternateRelation && <span className="alternate-source-badge">{preview.alternateRelation}</span>}
                          {preview.method && <span className="method-badge">{preview.method}</span>}
                        </div>
                        <h2>{preview.title || (preview.state === "failed" ? "Preview failed" : "Video preview")}</h2>
                        {preview.description && <p>{preview.description}</p>}
                        {preview.deadLink && <p className="warning-message">{preview.deadHost ? `Host ${preview.deadHostName || domainFor(preview.url)} was confirmed unreachable; additional links on this host are skipped for this Sandbox session instead of repeatedly pinging it.` : "This individual URL returned 404/410. The host remains eligible for other links."} Version Finder can still use URL and archive clues.</p>}
                        {siteSessionEligible && preview.state !== "failed" && (
                          <div className="challenge-box">
                            <p className="warning-message">
                              {preview.challengeDetected
                                ? "The lightweight preview was blocked or challenged. Open one reusable Sandbox site session."
                                : "No thumbnail was exposed to the unattended preview. This site may require an Accept/consent/age/cookie prompt in a normal browser. Open one reusable Sandbox site session."}
                              {" "}After one successful Retry, other unresolved previews from this same site are retried automatically.
                            </p>
                            <div className="challenge-actions">
                              <button type="button" onClick={() => authorizeSite(preview)} disabled={!privacy.browserFallback || !privacy.interactiveAuthorization || preview.authorizationState === "launching" || preview.authorizationState === "authorizing"}>
                                {preview.authorizationState === "authorizing" ? "Site session open" : "Open site session"}
                              </button>
                              <button type="button" onClick={() => retryAuthorizedPreview(preview)} disabled={!privacy.browserFallback}>Retry preview</button>
                            </div>
                            {preview.authorizationMessage && <small>{preview.authorizationMessage}</small>}
                          </div>
                        )}
                        {!siteSessionEligible && preview.warning && preview.state !== "failed" && <p className="warning-message">Source restricted lightweight access; fallback was attempted.</p>}
                        {preview.state === "failed" && <p className="error-message">{preview.error || "Unable to retrieve preview metadata."}</p>}
                        <div className="card-footer">
                          <a href={preview.url} target="_blank" rel="noopener noreferrer">Open video ↗</a>
                          <span className="timing">{Number.isFinite(preview.elapsedMs) ? `${preview.elapsedMs} ms` : ""}{preview.cached ? " · cache" : ""}</span>
                        </div>
                        {(preview.state === "ready" || preview.state === "failed") && (
                          <details className="diagnostics">
                            <summary>Diagnostics</summary>
                            <dl>
                              <div><dt>Method</dt><dd>{preview.method || "none"}</dd></div>
                              <div><dt>Backend</dt><dd>{preview.clientStatus || "network error"}</dd></div>
                              <div><dt>Upstream</dt><dd>{preview.upstreamStatus ?? "—"}</dd></div>
                              <div><dt>Bytes read</dt><dd>{Number.isFinite(preview.bytesRead) ? preview.bytesRead.toLocaleString() : "—"}</dd></div>
                              <div><dt>Client time</dt><dd>{Number.isFinite(preview.clientMs) ? `${preview.clientMs} ms` : "—"}</dd></div>
                              <div><dt>Thumbnails</dt><dd>{preview.images?.length || (preview.image ? 1 : 0)}</dd></div>
                              <div><dt>HTTP extractor</dt><dd>{preview.extractorStats ? `meta ${preview.extractorStats.meta || 0} · json ${preview.extractorStats.json || 0} · script ${preview.extractorStats.script || 0} · poster ${preview.extractorStats.poster || 0} · dom ${preview.extractorStats.dom || 0}` : "—"}</dd></div>
                              <div><dt>Edge extractor</dt><dd>{preview.browserExtractorStats ? `meta ${preview.browserExtractorStats.meta || 0} · json ${preview.browserExtractorStats.json || 0} · script ${preview.browserExtractorStats.script || 0} · poster ${preview.browserExtractorStats.poster || 0} · dom ${preview.browserExtractorStats.dom || 0}` : "—"}</dd></div>
                              <div><dt>Browser fallback</dt><dd>{preview.browserFallback ? "used" : preview.browserFallbackAttempted ? "attempted" : "no"}</dd></div>
                              <div><dt>Authorized session</dt><dd>{preview.authorizedBrowserSession ? "live Edge" : preview.authorizedBrowserProfile ? "saved profile" : preview.authorizationState || "no"}</dd></div>
                              <div><dt>Fallback error</dt><dd>{preview.browserFallbackError || "none"}</dd></div>
                              <div><dt>Challenge</dt><dd>{preview.challengeDetected ? (preview.challengeProvider || "detected") : "none"}</dd></div>
                              <div><dt>Fallback skipped</dt><dd>{preview.browserFallbackSkippedReason || "none"}</dd></div>
                              <div><dt>Client network</dt><dd>{preview.clientNetworkError || "none"}</dd></div>
                              <div><dt>Warning</dt><dd>{preview.warning || "none"}</dd></div>
                              <div><dt>Dead link</dt><dd>{preview.deadLink ? (preview.deadHost ? `host unreachable${preview.hostSuppressed ? " · suppressed" : ""}` : preview.deadReason || "yes") : "no"}</dd></div>
                              <div><dt>Error</dt><dd>{preview.error || "none"}</dd></div>
                            </dl>
                          </details>
                        )}
                      </div>
                    </article>
                  );
                })}
              </section>
            </>
          )}
          {!visiblePreviews.length && <section className="empty-workspace"><strong>{activeTab === "dead" ? "No dead links" : "No previews yet"}</strong><p>{activeTab === "dead" ? "Confirmed unreachable hosts and individual 404/410 URLs are moved here automatically. They can still be queued into Version Finder using URL/archive clues." : "Paste video URLs above to begin."}</p></section>}
        </>
      )}

      {activeTab === "finder" && (
        <section className="finder-workspace">
          <header className="finder-workspace-header">
            <div>
              <div className="alternate-kicker">Persistent background discovery</div>
              <h2>Version Finder</h2>
              <p>Queue several selected videos, switch back to Previews, and keep browsing while searches continue.</p>
            </div>
            <div className="finder-header-actions">
              <span>{finderStats.running} running · {finderStats.queued} queued · {finderStats.ready} complete · {finderStats.failed} failed</span>
              <button type="button" onClick={clearCompletedFinderJobs} disabled={!finderJobs.some((job) => ["ready", "failed"].includes(job.state))}>Clear completed</button>
            </div>
          </header>

          {!finderJobs.length ? (
            <div className="alternate-empty">
              <strong>No version searches queued</strong>
              <p>Return to Previews, select one or more videos, and click <b>Queue version search</b>.</p>
            </div>
          ) : (
            <div className="finder-job-list">
              {finderJobs.map((job) => (
                <article className={`finder-job ${job.state}`} key={job.id}>
                  <header className="finder-job-header">
                    <div>
                      <div className="finder-job-state">{job.state === "queued" ? "Queued" : job.state === "running" ? "Searching…" : job.state === "ready" ? "Complete" : "Failed"}</div>
                      <h3>{job.source?.title || job.source?.url}</h3>
                      <div className="alternate-source-summary">
                        <span>{job.source?.provider || domainFor(job.source?.url || "")}</span>
                        {formatDuration(job.source?.durationSeconds) && <span>{formatDuration(job.source.durationSeconds)}</span>}
                        <a href={job.source?.url} target="_blank" rel="noopener noreferrer">Open source ↗</a>
                      </div>
                    </div>
                    <div className="finder-job-actions">
                      {job.state === "failed" && <button type="button" onClick={() => retryFinderJob(job)}>Retry</button>}
                      {job.state === "ready" && <button type="button" onClick={() => retryFinderJob(job)}>Search again</button>}
                      {!(["running"].includes(job.state)) && <button type="button" onClick={() => removeFinderJob(job.id)}>Remove</button>}
                    </div>
                  </header>

                  {job.state === "queued" && <div className="alternate-loading"><div className="alternate-spinner" /><div><strong>Waiting for a finder worker…</strong><p>Up to {FINDER_CONCURRENCY} version searches run at once.</p></div></div>}
                  {job.state === "running" && <div className="alternate-loading"><div className="alternate-spinner" /><div><strong>Extracting media evidence and searching broad public indexes…</strong><p>Low-confidence and unknown-host candidates are retained instead of being discarded.</p></div></div>}
                  {job.state === "failed" && <div className="alternate-empty error-message"><strong>Search failed</strong><p>{job.error || "Version search failed."}</p></div>}

                  {job.state === "ready" && (
                    <>
                      <div className="alternate-toolbar">
                        <span>{job.results.length} related · {(job.lowRelevanceResults || []).length} low relevance · {job.rawDiscoveredCount || job.candidateCount || 0} raw discovered · {job.evaluatedCount || 0} page-inspected · {job.toolEvaluatedCount || 0} tool-probed{job.cached ? " · cache" : ""}</span>
                        <span className="alternate-toolbar-right">
                          {job.privacy?.sampleComparison && (
                            <button type="button" className="compare-top-button" onClick={() => compareTopCandidates(job)} disabled={job.batchCompareState === "running" || !job.results.length}>
                              {job.batchCompareState === "running"
                                ? `Comparing ${job.batchCompareProgress?.done || 0}/${job.batchCompareProgress?.total || Math.min(BATCH_COMPARE_LIMIT, job.results.length)}…`
                                : `Compare top ${Math.min(BATCH_COMPARE_LIMIT, job.results.length)}`}
                            </button>
                          )}
                          {Number.isFinite(job.clientMs) && <span>{job.clientMs} ms</span>}
                          {job.manualSearchUrl && <a href={job.manualSearchUrl} target="_blank" rel="noopener noreferrer">Broader web search ↗</a>}
                        </span>
                      </div>

                      {job.results.length ? (
                        <div className="alternate-results">
                          {job.results.map((candidate) => (
                            <FinderResult
                              key={candidate.url}
                              job={job}
                              candidate={candidate}
                              alreadyInList={previews.some((item) => item.url.toLowerCase() === candidate.url.toLowerCase())}
                              onAdd={(value) => addAlternate(job.id, value)}
                              onCompare={(value) => compareCandidate(job, value)}
                              privacy={job.privacy || privacy}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="alternate-empty"><strong>No subject-related candidates ranked yet</strong><p>Low-relevance inspected results and Raw discovered results remain available below, so nothing is silently discarded.</p></div>
                      )}

                      {(job.lowRelevanceResults || []).length > 0 && (
                        <details className="raw-discovery low-relevance-results">
                          <summary>Low-relevance inspected results ({job.lowRelevanceResults.length})</summary>
                          <p>These URLs were real search results and were inspected, but they did not share enough subject/title/media evidence to appear in the primary list. They are retained for transparency and renamed-mirror edge cases.</p>
                          <div className="alternate-results">
                            {job.lowRelevanceResults.map((candidate) => (
                              <FinderResult
                                key={`low-${candidate.url}`}
                                job={job}
                                candidate={candidate}
                                alreadyInList={previews.some((item) => item.url.toLowerCase() === candidate.url.toLowerCase())}
                                onAdd={(value) => addAlternate(job.id, value)}
                                onCompare={(value) => compareCandidate(job, value)}
                                privacy={job.privacy || privacy}
                              />
                            ))}
                          </div>
                        </details>
                      )}

                      <details className="raw-discovery">
                        <summary>Raw discovered results ({job.rawDiscoveredCount || 0})</summary>
                        <p>These are URLs returned by the enabled public search indexes before page/tool ranking. Search provenance is not treated as proof that a video matches.</p>
                        {job.rawDiscoveredTruncated && <p className="warning-text">Showing the first {job.rawDiscovered?.length || 0} raw URLs of {job.rawDiscoveredCount}.</p>}
                        <div className="raw-discovery-list">
                          {(job.rawDiscovered || []).map((item, index) => (
                            <div className="raw-discovery-row" key={`${item.url}-${index}`}>
                              <div><strong>{item.searchTitle || domainFor(item.url)}</strong><span>{(item.engines || []).join(" + ") || "search"}</span><span>{(item.queryKinds || []).join(" · ") || "unknown query"}</span></div>
                              {item.snippet && <p>{item.snippet}</p>}
                              <a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a>
                            </div>
                          ))}
                        </div>
                      </details>

                      <details className="alternate-diagnostics">
                        <summary>Discovery diagnostics</summary>
                        <p>{job.note}</p>
                        {job.privacy && <div className="alternate-diagnostic-row"><strong>Privacy snapshot</strong><span>{[job.privacy.searchDuckDuckGo && "DDG", job.privacy.searchBing && "Bing", job.privacy.searchMojeek && "Mojeek", job.privacy.searchBrave && "Brave", job.privacy.archiveLookups && "Archives"].filter(Boolean).join("+") || "no search engines"}</span><span>{job.privacy.mediaTools ? "media tools on" : "media tools off"}</span><code>{[job.privacy.searchTranscript && "transcript", job.privacy.searchDescription && "description", job.privacy.searchMediaIds && "media IDs", job.privacy.searchTitleUploader && "title/uploader"].filter(Boolean).join(" · ") || "no query signals"}</code></div>}
                        {job.tools && (
                          <div className="alternate-diagnostic-row discovery-tool-row">
                            <strong>Media tools</strong><span>{job.tools.installed ? "installed" : "not found"}</span>
                            <span>{[job.tools.ytDlp && "yt-dlp", job.tools.deno && "Deno", job.tools.ffmpeg && "FFmpeg"].filter(Boolean).join(" · ") || "page probe only"}</span>
                            <code>{job.tools.sourceMode || "—"}{job.tools.sourceExtractor ? ` / ${job.tools.sourceExtractor}` : ""}</code>
                          </div>
                        )}
                        {job.searchPolicy && <div className="alternate-diagnostic-row"><strong>Search filtering</strong><span>DDG · Bing · Mojeek · Brave: Safe Search off requested</span><span>Archives: no app SafeSearch filter</span><code>{job.searchPolicy.note}</code></div>}
                        {job.sourceSignals?.urlClues && <div className="alternate-diagnostic-row"><strong>URL clues</strong><span>{job.sourceSignals.urlClues.slugPhrase || "no readable slug"}</span><span>{(job.sourceSignals.urlClues.ids || []).length} IDs</span><code>{(job.sourceSignals.urlClues.phrases || []).join(" · ") || "—"}</code></div>}
                        {job.sourceSignals?.archivedSource && <div className="alternate-diagnostic-row"><strong>Archived source</strong><span>{job.sourceSignals.archivedSource.provider || "archive"}</span><span>{job.sourceSignals.archivedSource.directCandidates || 0} outbound candidates</span><code>{job.sourceSignals.archivedSource.recoveredTitle || job.sourceSignals.archivedSource.capture || "metadata recovered"}</code></div>}
                        {job.archiveRecovery && <div className="alternate-diagnostic-row"><strong>Archive recovery</strong><span>{job.archiveRecovery.ok ? "recovered" : "not recovered"}</span><span>{job.archiveRecovery.provider || "Wayback + Common Crawl"}</span><code>{(job.archiveRecovery.attempts || []).map((item) => `${item.provider}:${item.ok ? "ok" : item.error || "miss"}`).join(" · ") || job.archiveRecovery.error || "—"}</code></div>}
                        {job.sourceSignals?.transcript?.phrase && <div className="alternate-diagnostic-row"><strong>Transcript</strong><span>{job.sourceSignals.transcript.lang || "unknown"}</span><span>{job.sourceSignals.transcript.automatic ? "automatic" : "subtitle"}</span><code>“{job.sourceSignals.transcript.phrase}”</code></div>}
                        {(job.queryEvidence || []).map((entry, index) => <div className="alternate-diagnostic-row" key={`query-${entry.kind}-${index}`}><strong>{entry.kind}</strong><span>{Math.round((entry.weight || 0) * 100)}% query priority</span><span>discovery only</span><code>{entry.query}</code></div>)}
                        {(job.diagnostics || []).map((entry, index) => <div className="alternate-diagnostic-row" key={`${entry.engine}-${entry.kind}-${index}`}><strong>{entry.engine}</strong><span>{entry.status || "network"}</span><span>{entry.found || 0} results</span><code>{entry.query}</code>{entry.error && <span className="failed-text">{entry.error}</span>}</div>)}
                      </details>
                    </>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export default App;
