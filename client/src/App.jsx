import { useEffect, useMemo, useRef, useState } from "react";
import {
  authorizationStatus,
  authorizePreviewHost,
  bingSessionStatus,
  configureBingSession,
  compareVideoSamples,
  fetchAlternates,
  fetchPreview,
  imageProxyUrl,
  networkStatus,
  recoverVideoMetadata,
  readWorkspace,
  writeWorkspace,
  searxngStatus
} from "./api.js";
import "./App.css";
import { extractVideoUrls, videoUrlIdentity } from "./url-identity.js";
import { normalizeExcludedDomain, excludeUrls } from "./domain-exclusions.js";
import { shouldContinueHostProbes } from "./preview-batch-policy.js";
import { buildSafePreviewDiagnosticReport } from "./safe-preview-diagnostics.js";
import { pendingSiteRecoveryItems, siteRecoveryDelayMs, recoveryFailureCount } from "./site-recovery-policy.js";

const CLIENT_CONCURRENCY = 4;
const BROWSER_FALLBACK_CONCURRENCY = 1;
const HOST_FALLBACK_SAMPLE_LIMIT = 3; // Cap independent page probes before deferring a uniformly blocked host.
const SITE_RECOVERY_BASE_DELAY_MS = 850; // A single sequential site session, paced between attempts.
const SITE_RECOVERY_MAX_CONSECUTIVE_FAILURES = 3;
const WORKSPACE_SAVE_DELAY_MS = 650;
const FINDER_CONCURRENCY = 1;
const BATCH_COMPARE_LIMIT = 5;
const PRIVACY_STORAGE_KEY = "linkPreviewPrivacyV1";
const SEARXNG_ENDPOINT_STORAGE_KEY = "linkPreviewSearxngEndpointV1";
const DEFAULT_SEARXNG_ENDPOINT = "http://127.0.0.1:8888";
const FULL_PRIVACY = Object.freeze({
  remoteThumbnails: true,
  browserFallback: true,
  interactiveAuthorization: true,
  mediaTools: true,
  searchSearxng: true,
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

function loadSearxngEndpoint() {
  try { return localStorage.getItem(SEARXNG_ENDPOINT_STORAGE_KEY) || DEFAULT_SEARXNG_ENDPOINT; }
  catch { return DEFAULT_SEARXNG_ENDPOINT; }
}

function formatSessionTime(timestamp) {
  if (!timestamp) return "—";
  try { return new Date(timestamp).toLocaleString(); } catch { return "—"; }
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
    }, { rootMargin: "250px 0px" });
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
          referrerPolicy="origin"
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
          <span className="confidence-badge" title="Heuristic evidence score, not a probability">{candidate.confidence ?? 0}/99 evidence</span>
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
        {candidate.relevanceReasons?.length > 0 && <div className="search-support-note">Identity evidence: {candidate.relevanceReasons.join(" · ")}</div>}
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
  const [excludedDomainInput, setExcludedDomainInput] = useState("");
  const [excludedDomains, setExcludedDomains] = useState([]);
  const [exclusionError, setExclusionError] = useState("");
  const [collectedTabText, setCollectedTabText] = useState("");
  const [tabCollectorStatus, setTabCollectorStatus] = useState("");
  const [tabCollectorBusy, setTabCollectorBusy] = useState(false);
  const pendingTabRequestRef = useRef(null);
  const authorizedSiteAutoRetryRef = useRef(new Set());
  const siteRecoveryStopRef = useRef(new Set());
  const [siteRecoveryProgress, setSiteRecoveryProgress] = useState({});
  const [previews, setPreviews] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [processing, setProcessing] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [activeTab, setActiveTab] = useState("previews");
  const [finderJobs, setFinderJobs] = useState([]);
  const finderRunningRef = useRef(new Set());
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [workspaceStatus, setWorkspaceStatus] = useState("Connecting to Sandbox memory…");
  const workspaceRevisionRef = useRef(0);
  const workspaceReadStartedRef = useRef(false);
  const workspaceSaveInFlightRef = useRef(Promise.resolve());
  const latestWorkspaceSnapshotRef = useRef(null);
  const pendingSiteReturnRef = useRef(null);
  const siteReturnAttemptRef = useRef(false);
  const siteSessionLeftAppRef = useRef(false);

  const [privacy, setPrivacy] = useState(loadPrivacySettings);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [bingState, setBingState] = useState({ state: "unverified", browserStatus: "none", live: false, evidence: null });
  const [bingBusy, setBingBusy] = useState(false);
  const [searxngEndpoint, setSearxngEndpoint] = useState(loadSearxngEndpoint);
  const [searxngState, setSearxngState] = useState({ ok: false, status: 0, error: "not_checked", engineCount: 0, local: true });
  const [searxngBusy, setSearxngBusy] = useState(false);
  const [networkState, setNetworkState] = useState({ ok: false, dns: null, http: null });
  const telemetryBaselineRef = useRef(null);
  const [sessionTelemetry, setSessionTelemetry] = useState(() => ({
    startedAt: Date.now(),
    totalBatches: 0,
    totalLinks: 0,
    largestBatch: 0,
    lastBatchAt: null,
    lastBatchSize: 0,
    peakDnsQueue: 0,
    peakDnsRate: 0,
    peakDnsLatencyMs: 0,
    peakHttpActive: 0,
    peakHttpQueue: 0,
    dnsPressureEvents: 0,
    dnsErrors: 0,
    lastPressureAt: null,
    lastPressureReason: null
  }));

  // Restore from a RAM-only backend snapshot after a discarded/reloaded app tab.
  // Never restart unattended network requests from a stale snapshot.
  useEffect(() => {
    if (workspaceReadStartedRef.current) return;
    workspaceReadStartedRef.current = true;
    // One in-flight read also survives React StrictMode effect cleanup/replay.
    readWorkspace().then((result) => {
      if (result?.ok) workspaceRevisionRef.current = result.revision || 0;
      const state = result?.state;
      if (state?.schema === 1) {
        const restored = (state.previews || []).map((item) =>
          item.state === "loading" || item.state === "queued"
            ? { ...item, state: "failed", browserFallbackQueued: false, error: "Interrupted by app-tab reload; use Retry failed to resume." }
            : item
        );
        setPreviews(restored);
        setFinderJobs((state.finderJobs || []).map((job) =>
          job.state === "queued" || job.state === "running"
            ? { ...job, state: "failed", error: "Interrupted by app-tab reload. Select Search again to resume." }
            : job
        ));
        setSelected(new Set((state.selectedIds || []).filter((id) => restored.some((item) => item.id === id))));
        if (Array.isArray(state.excludedDomains)) setExcludedDomains(state.excludedDomains);
        if (typeof state.inputText === "string") setInputText(state.inputText);
        if (typeof state.collectedTabText === "string") setCollectedTabText(state.collectedTabText);
        if (["previews", "dead", "finder"].includes(state.activeTab)) setActiveTab(state.activeTab);
        if (state.sessionTelemetry && typeof state.sessionTelemetry === "object") setSessionTelemetry(state.sessionTelemetry);
        setWorkspaceStatus(`Restored ${restored.length} links from Sandbox memory`);
      } else {
        setWorkspaceStatus(result?.ok ? "Workspace protected in Sandbox memory" : "Workspace memory unavailable — this tab only");
      }
      setWorkspaceLoaded(true);
    }).catch(() => { setWorkspaceStatus("Workspace memory unavailable — this tab only"); setWorkspaceLoaded(true); });
  }, []);

  // Debounced RAM-only snapshots: no localStorage, sessionStorage, IndexedDB,
  // filesystem, remote telemetry, or cross-process history.
  useEffect(() => {
    if (!workspaceLoaded) return;
    const snapshot = {
      schema: 1, previews, finderJobs, selectedIds: [...selected], excludedDomains,
      inputText, collectedTabText, activeTab, sessionTelemetry
    };
    latestWorkspaceSnapshotRef.current = snapshot;
    const timer = window.setTimeout(() => saveWorkspaceSnapshot(snapshot), WORKSPACE_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [workspaceLoaded, previews, finderJobs, selected, excludedDomains, inputText, collectedTabText, activeTab, sessionTelemetry]);

  function saveWorkspaceSnapshot(snapshot) {
    if (!snapshot) return;
    workspaceSaveInFlightRef.current = workspaceSaveInFlightRef.current.then(async () => {
      const result = await writeWorkspace(snapshot, workspaceRevisionRef.current);
      if (result.ok) workspaceRevisionRef.current = result.revision;
      else if (result.status === 409) {
        const current = await readWorkspace();
        if (current.ok) workspaceRevisionRef.current = current.revision || 0;
        const retry = await writeWorkspace(snapshot, workspaceRevisionRef.current);
        if (retry.ok) workspaceRevisionRef.current = retry.revision;
      }
      if (!result.ok && result.status !== 409) setWorkspaceStatus("Workspace snapshot unavailable or too large — current tab only");
    }).catch(() => { setWorkspaceStatus("Workspace snapshot unavailable — current tab only"); });
  }

  useEffect(() => {
    if (!workspaceLoaded) return undefined;
    const flushOnHide = () => {
      if (document.visibilityState === "hidden") saveWorkspaceSnapshot(latestWorkspaceSnapshotRef.current);
    };
    document.addEventListener("visibilitychange", flushOnHide);
    window.addEventListener("pagehide", flushOnHide);
    return () => { document.removeEventListener("visibilitychange", flushOnHide); window.removeEventListener("pagehide", flushOnHide); };
  }, [workspaceLoaded]);

  useEffect(() => {
    try { localStorage.setItem(PRIVACY_STORAGE_KEY, JSON.stringify(privacy)); } catch {}
  }, [privacy]);

  useEffect(() => {
    try { localStorage.setItem(SEARXNG_ENDPOINT_STORAGE_KEY, searxngEndpoint); } catch {}
  }, [searxngEndpoint]);

  useEffect(() => {
    const handleCollectedTabs = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const response = event.data;
      const pending = pendingTabRequestRef.current;
      if (!pending || response?.source !== "sandbox-link-preview-tab-collector" || response?.type !== "SANDBOX_TAB_RESULTS_V1" || response.requestId !== pending.id) return;
      window.clearTimeout(pending.timer);
      pendingTabRequestRef.current = null;
      setTabCollectorBusy(false);
      if (response.error) { setTabCollectorStatus(`Edge tab collection failed: ${response.error}`); return; }
      const urls = extractVideoUrls((response.urls || []).join("\n")).urls;
      setCollectedTabText(urls.join("\n"));
      setTabCollectorStatus(`${urls.length} distinct web tab URL${urls.length === 1 ? "" : "s"} collected in this Sandbox Edge profile (not host tabs).`);
    };
    window.addEventListener("message", handleCollectedTabs);
    return () => {
      window.removeEventListener("message", handleCollectedTabs);
      if (pendingTabRequestRef.current) window.clearTimeout(pendingTabRequestRef.current.timer);
    };
  }, []);

  function addExcludedDomain() {
    const domain = normalizeExcludedDomain(excludedDomainInput);
    if (!domain) { setExclusionError("Enter a valid domain, such as example.com or *.example.com."); return; }
    setExcludedDomains((current) => current.includes(domain) ? current : [...current, domain]);
    setExcludedDomainInput("");
    setExclusionError("");
  }

  function collectOpenEdgeTabs() {
    if (pendingTabRequestRef.current) return;
    const id = crypto.randomUUID();
    setTabCollectorBusy(true);
    setTabCollectorStatus("Requesting web tab URLs from the optional Sandbox Edge extension…");
    const timer = window.setTimeout(() => {
      if (pendingTabRequestRef.current?.id !== id) return;
      pendingTabRequestRef.current = null;
      setTabCollectorBusy(false);
      setTabCollectorStatus("Collector extension not detected. Load edge-tab-collector as an unpacked extension in this Sandbox Edge, then refresh this page.");
    }, 6500);
    pendingTabRequestRef.current = { id, timer };
    window.postMessage({ source: "sandbox-link-preview-app", type: "SANDBOX_APP_COLLECT_TABS_V1", requestId: id }, window.location.origin);
  }

  function appendCollectedTabs() {
    const parsed = extractVideoUrls(collectedTabText);
    const filtered = excludeUrls(parsed.urls, excludedDomains);
    if (!filtered.kept.length) { setTabCollectorStatus(`No importable URLs. ${filtered.removed.length} excluded by domain rules.`); return; }
    setInputText((current) => [current.trim(), filtered.kept.join("\n")].filter(Boolean).join("\n"));
    setTabCollectorStatus(`Added ${filtered.kept.length} tab URL${filtered.kept.length === 1 ? "" : "s"} to the paste list; ${filtered.removed.length} excluded. Press Create previews when ready.`);
  }

  async function copyCollectedTabs() {
    try {
      await navigator.clipboard.writeText(collectedTabText);
      setTabCollectorStatus("Tab URL list copied to clipboard (one per line).");
    } catch { setTabCollectorStatus("Clipboard unavailable; select and copy the text field manually."); }
  }


  async function refreshSearxngState() {
    setSearxngBusy(true);
    const result = await searxngStatus(searxngEndpoint);
    setSearxngState(result);
    setSearxngBusy(false);
    return result;
  }


  async function refreshBingState() {
    const result = await bingSessionStatus();
    setBingState(result);
    return result;
  }

  async function refreshNetworkState() {
    const result = await networkStatus();
    setNetworkState(result);
    const dns = result?.dns;
    const http = result?.http;
    if (dns) {
      if (!telemetryBaselineRef.current) {
        telemetryBaselineRef.current = {
          pressureEvents: Number(dns.pressureEvents) || 0,
          errors: Number(dns.errors) || 0
        };
      }
      const baseline = telemetryBaselineRef.current;
      setSessionTelemetry((current) => {
        const pressureEvents = Math.max(0, (Number(dns.pressureEvents) || 0) - baseline.pressureEvents);
        const errors = Math.max(0, (Number(dns.errors) || 0) - baseline.errors);
        const pressureActive = dns.pressure && dns.pressure !== "normal";
        const pressureAdvanced = pressureEvents > current.dnsPressureEvents;
        const next = {
          ...current,
          peakDnsQueue: Math.max(current.peakDnsQueue, Number(dns.queued) || 0),
          peakDnsRate: Math.max(current.peakDnsRate, Number(dns.recentFreshLookupsPerSecond) || 0),
          peakDnsLatencyMs: Math.max(current.peakDnsLatencyMs, Number(dns.averageLatencyMs) || 0, Number(dns.lastLatencyMs) || 0),
          peakHttpActive: Math.max(current.peakHttpActive, Number(http?.active) || 0),
          peakHttpQueue: Math.max(current.peakHttpQueue, Number(http?.queued) || 0),
          dnsPressureEvents: pressureEvents,
          dnsErrors: errors,
          lastPressureAt: pressureAdvanced || (pressureActive && !current.lastPressureAt) ? Date.now() : current.lastPressureAt,
          lastPressureReason: pressureActive && dns.lastPressureReason ? dns.lastPressureReason : current.lastPressureReason
        };
        return Object.keys(next).every((key) => Object.is(next[key], current[key])) ? current : next;
      });
    }
    return result;
  }

  async function copySafePreviewDiagnostics() {
    const report = buildSafePreviewDiagnosticReport({ previews, networkState, workspaceLoaded, processing });
    try {
      await navigator.clipboard.writeText(report);
      setCopyStatus("Copied privacy-safe diagnostic report — no links or content");
    } catch { setCopyStatus("Could not copy diagnostic summary"); }
    window.setTimeout(() => setCopyStatus(""), 4000);
  }

  async function copySessionSnapshot() {
    const dns = networkState?.dns || {};
    const http = networkState?.http || {};
    const traffic = networkState?.traffic || {};
    const lines = [
      "Video Link Preview — memory-only session snapshot",
      `Session started: ${formatSessionTime(sessionTelemetry.startedAt)}`,
      `Last batch started: ${formatSessionTime(sessionTelemetry.lastBatchAt)}`,
      `Last batch size: ${sessionTelemetry.lastBatchSize}`,
      `Batches this session: ${sessionTelemetry.totalBatches}`,
      `Links submitted this session: ${sessionTelemetry.totalLinks}`,
      `Largest batch: ${sessionTelemetry.largestBatch}`,
      `Current DNS pressure: ${dns.pressure || "unknown"}`,
      `Current fresh DNS: ${dns.recentFreshLookupsPerSecond ?? 0}/s`,
      `Current DNS queue: ${dns.queued ?? 0}`,
      `Current DNS avg latency: ${dns.averageLatencyMs ?? 0} ms`,
      `Current HTTP active/queued: ${http.active ?? 0}/${http.queued ?? 0}`,
      `Observed response MB (last minute): ${((traffic.observedBytesLastMinute || 0) / 1048576).toFixed(2)}`,
      `Backend HTTP MB (session): ${((traffic.backendResponseBytesTotal || 0) / 1048576).toFixed(2)}`,
      `Backend image MB (session): ${((traffic.backendImageBytesTotal || 0) / 1048576).toFixed(2)}`,
      `Headless browser proxy MB (session): ${((traffic.browserProxyBytesTotal || 0) / 1048576).toFixed(2)}`,
      'Traffic counters exclude separate visible Edge windows and local search service.',
      `Peak DNS rate: ${sessionTelemetry.peakDnsRate}/s`,
      `Peak DNS queue: ${sessionTelemetry.peakDnsQueue}`,
      `Peak DNS latency: ${sessionTelemetry.peakDnsLatencyMs} ms`,
      `Peak HTTP active: ${sessionTelemetry.peakHttpActive}`,
      `Peak HTTP queue: ${sessionTelemetry.peakHttpQueue}`,
      `DNS pressure events this UI session: ${sessionTelemetry.dnsPressureEvents}`,
      `DNS errors this UI session: ${sessionTelemetry.dnsErrors}`,
      `Last pressure time: ${formatSessionTime(sessionTelemetry.lastPressureAt)}`,
      `Last pressure category: ${/^slow_lookup_/.test(sessionTelemetry.lastPressureReason || "") ? "slow_lookup" : ["EAI_AGAIN", "ETIMEOUT", "SERVFAIL", "dns_pressure", "dns_lookup_timeout"].includes(sessionTelemetry.lastPressureReason) ? sessionTelemetry.lastPressureReason : "other_or_none"}`,
      "Privacy: aggregate counters/timestamps only; no URLs, hostnames, titles, IDs, or search terms included."
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\r\n"));
      setCopyStatus("Copied memory-only network snapshot (no URLs or hostnames)");
    } catch {
      setCopyStatus("Snapshot copy failed");
    }
    setTimeout(() => setCopyStatus(""), 3000);
  }

  async function openBingConfiguration() {
    setBingBusy(true);
    const result = await configureBingSession();
    if (!result?.ok) {
      setCopyStatus(`Could not open Bing configuration: ${result?.error || "unknown error"}`);
      setTimeout(() => setCopyStatus(""), 3500);
    } else {
      setCopyStatus("Bing settings opened in the Sandbox profile. Set SafeSearch to Off and leave the window open until status says Off verified.");
      setTimeout(() => setCopyStatus(""), 5000);
    }
    await refreshBingState();
    setBingBusy(false);
  }

  useEffect(() => {
    refreshBingState();
    refreshSearxngState();
    refreshNetworkState();
    const timer = setInterval(() => { refreshNetworkState(); }, 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!privacy.searchBing) return undefined;
    const timer = setInterval(() => { refreshBingState(); }, bingState?.live || bingState?.browserStatus === "authorizing" ? 2500 : 10000);
    return () => clearInterval(timer);
  }, [privacy.searchBing, bingState?.live, bingState?.browserStatus]);

  const enabledPrivacyCount = useMemo(() => Object.values(privacy).filter(Boolean).length, [privacy]);
  const finderSearchEnabled = useMemo(() =>
    (privacy.searchSearxng || privacy.searchDuckDuckGo || privacy.searchBing || privacy.searchMojeek || privacy.searchBrave || privacy.archiveLookups) &&
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

  const unresolvedBySite = useMemo(() => {
    const counts = new Map();
    for (const item of previews) {
      if (!needsAuthorizedSiteRetry(item)) continue;
      const site = siteKeyFor(item.url);
      if (!site) continue;
      counts.set(site, (counts.get(site) || 0) + 1);
    }
    return counts;
  }, [previews]);

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

  async function processItems(items, { forceReachability = false } = {}) {
    if (!items.length) return;
    setProcessing(true);
    const browserFallbackItems = [];
    const siteSessionItems = [];
    try {
      await runPool(items, async (item) => {
        patchPreview(item.id, { state: "loading", error: null });
        const result = await fetchPreview(item.url, { allowBrowserFallback: false, privacy, forceReachability: forceReachability && Boolean(item.deadLink) });
        patchPreview(item.id, {
          ...result,
          browserFallbackQueued: Boolean(result.clientOk && result.needsBrowserFallback && privacy.browserFallback),
          state: result.clientOk ? "ready" : "failed",
          error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
        });
        if (result.clientOk && result.needsBrowserFallback) browserFallbackItems.push(item);
        else if (result.clientOk && needsAuthorizedSiteRetry(result)) siteSessionItems.push({ ...item, ...result });
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
          // A single difficult page is not proof that every other URL on this host
          // is behind the same interstitial. Sample a few *distinct* URLs, not
          // just the first. Stop after a successful public preview; otherwise
          // defer the remainder to avoid hammering an inaccessible site.
          let sampleCount = 0;
          let foundWorkingPublicPreview = false;
          for (const item of hostItems.slice(0, HOST_FALLBACK_SAMPLE_LIMIT)) {
            sampleCount += 1;
            patchPreview(item.id, { state: "loading", error: null, method: "edge-fallback-queued" });
            const result = await fetchPreview(item.url, { allowBrowserFallback: true, privacy, forceReachability: forceReachability && Boolean(item.deadLink) });
            patchPreview(item.id, {
              ...result,
              browserFallbackQueued: false,
              state: result.clientOk ? "ready" : "failed",
              error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
            });
            if (result.clientOk && result.image) {
              foundWorkingPublicPreview = true;
              break;
            }
            if (result.clientOk && needsAuthorizedSiteRetry(result)) siteSessionItems.push({ ...item, ...result });
            // Known verification/challenge responses and broken browser tooling
            // should not trigger more attempts against the same host.
            if (!shouldContinueHostProbes(result, sampleCount, HOST_FALLBACK_SAMPLE_LIMIT)) break;
          }
          const rest = hostItems.slice(sampleCount);
          if (foundWorkingPublicPreview) {
            // The host can serve public thumbnails; do not suppress its other
            // video URLs merely because an earlier page was blocked.
            remainingFallbackItems.push(...rest);
          } else {
            // Bound the cost when several distinct pages on this host could not
            // expose public metadata, while keeping retries explicitly available.
            for (const sibling of rest) {
              patchPreview(sibling.id, {
                browserFallbackQueued: false,
                browserFallbackSkippedReason: "same_host_public_probe_unresolved",
                siteSessionRecommended: true,
                authorizationState: "needs-attention",
                authorizationMessage: `No thumbnail found on ${sampleCount} independent ${host} pages. Additional browser probes were paused to protect network responsiveness; open a site session or retry this item.`
              });
            }
          }
        }

        if (remainingFallbackItems.length) {
          await runPool(remainingFallbackItems, async (item) => {
            patchPreview(item.id, { state: "loading", error: null, method: "edge-fallback-queued" });
            const result = await fetchPreview(item.url, { allowBrowserFallback: true, privacy, forceReachability: forceReachability && Boolean(item.deadLink) });
            patchPreview(item.id, {
              ...result,
              browserFallbackQueued: false,
              state: result.clientOk ? "ready" : "failed",
              error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
            });
            if (result.clientOk && needsAuthorizedSiteRetry(result)) siteSessionItems.push({ ...item, ...result });
          }, BROWSER_FALLBACK_CONCURRENCY);
        }
      }
    } finally {
      setProcessing(false);
      for (const item of siteSessionItems) {
        patchPreview(item.id, {
          siteSessionRecommended: true,
          authorizationState: "needs-attention",
          authorizationMessage: `This preview may need a reusable site session for ${siteKeyFor(item.url)}. Open it manually when convenient; no automatic retry will run.`
        });
      }
    }
  }

  async function processSinglePreview(item, extraPatch = {}, { forceReachability = false } = {}) {
    patchPreview(item.id, { state: "loading", error: null, method: "retrying", ...extraPatch });
    const result = await fetchPreview(item.url, { allowBrowserFallback: privacy.browserFallback, privacy, forceReachability });
    patchPreview(item.id, {
      ...result,
      state: result.clientOk ? "ready" : "failed",
      error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
    });
    return result;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!workspaceLoaded || processing || !inputText.trim()) return;
    const parsed = extractVideoUrls(inputText);
    const filtered = excludeUrls(parsed.urls, excludedDomains);
    const existing = new Set(previews.map((item) => videoUrlIdentity(item.url)));
    const newUrls = filtered.kept.filter((url) => !existing.has(videoUrlIdentity(url)));
    const duplicateCount = filtered.kept.length - newUrls.length;
    const stamp = Date.now();
    const items = newUrls.map((url, index) => ({
      id: `${stamp}-${index}`, url, state: "queued", title: null, description: null,
      image: null, provider: null, method: null, error: null
    }));
    if (items.length) {
      setSessionTelemetry((current) => ({
        ...current,
        totalBatches: current.totalBatches + 1,
        totalLinks: current.totalLinks + items.length,
        largestBatch: Math.max(current.largestBatch, items.length),
        lastBatchAt: stamp,
        lastBatchSize: items.length
      }));
    }
    setImportSummary({ added: items.length, duplicates: duplicateCount, excluded: filtered.removed.length, invalid: parsed.invalid });
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
    await processItems(visiblePreviews.filter((item) => item.state === "failed" || item.deadLink), { forceReachability: true });
  }

  async function recheckDeadPreview(preview) {
    if (processing) return;
    setProcessing(true);
    try {
      await processSinglePreview(preview, { authorizationMessage: "Rechecking URL/host reachability…" }, { forceReachability: true });
    } finally {
      setProcessing(false);
    }
  }

  async function recoverPreviewHistory(preview) {
    patchPreview(preview.id, { historical: { state: "loading" } });
    const result = await recoverVideoMetadata(preview.url, { privacy });
    if (!result.clientOk) {
      patchPreview(preview.id, { historical: { state: "failed", error: result.error || "archive_lookup_failed" } });
      return;
    }
    patchPreview(preview.id, {
      historical: { ...result, state: "ready" },
      title: result.titleOrigin === "archived_page" ? result.title : preview.title || null,
      description: result.description || preview.description || null,
      durationSeconds: result.durationSeconds || preview.durationSeconds || null,
      images: result.images?.length ? result.images : preview.images || []
    });
  }

  function queueSelectedVersionSearches() {
    if (!finderSearchEnabled) { setCopyStatus("Enable a search engine and at least one finder query signal in Privacy & network activity"); setTimeout(() => setCopyStatus(""), 3200); return; }
    const sources = previews.filter((item) => selected.has(item.id));
    if (!sources.length) return;
    const now = Date.now();
    const activeSourceUrls = new Set(
      finderJobs.filter((job) => ["queued", "running"].includes(job.state)).map((job) => videoUrlIdentity(job.source.url))
    );
    const jobs = sources.filter((source) => !activeSourceUrls.has(videoUrlIdentity(source.url))).map((source, index) => ({
      id: `finder-${now}-${index}-${Math.random().toString(36).slice(2, 7)}`,
      source: { ...source }, privacy: { ...privacy }, searxngEndpoint, state: "queued", results: [], lowRelevanceResults: [], error: null, queuedAt: Date.now(),
      note: null, diagnostics: [], queryEvidence: [], candidateCount: 0, rawDiscovered: [], rawDiscoveredCount: 0, evaluatedCount: 0, toolEvaluatedCount: 0, batchCompareState: "idle", batchCompareProgress: null
    }));
    if (!jobs.length) { setCopyStatus("Selected videos are already queued/running"); setTimeout(() => setCopyStatus(""), 2200); return; }
    setFinderJobs((current) => [...jobs, ...current]);
    setCopyStatus(`Queued ${jobs.length} version search${jobs.length === 1 ? "" : "es"}`);
    setTimeout(() => setCopyStatus(""), 2200);
  }

  async function executeFinderJob(job) {
    patchFinderJob(job.id, { state: "running", startedAt: Date.now(), error: null });
    const result = await fetchAlternates(job.source, { privacy: job.privacy || privacy, searxngEndpoint: job.searxngEndpoint || searxngEndpoint });
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
      archiveRecovery: result.archiveRecovery || null,
      searxng: result.searxng || null
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
    patchFinderJob(job.id, { state: "queued", privacy: { ...privacy }, searxngEndpoint, results: [], lowRelevanceResults: [], rawDiscovered: [], rawDiscoveredCount: 0, error: null, diagnostics: [], queryEvidence: [], archiveRecovery: null, cached: false, batchCompareState: "idle", batchCompareProgress: null });
  }
  function removeFinderJob(id) { setFinderJobs((current) => current.filter((job) => job.id !== id)); }
  function clearCompletedFinderJobs() { setFinderJobs((current) => current.filter((job) => ["queued", "running"].includes(job.state))); }

  function addAlternate(jobId, candidate) {
    const normalized = candidate.url && videoUrlIdentity(candidate.url);
    if (!normalized) return;
    const existing = previews.find((item) => videoUrlIdentity(item.url) === normalized);
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
    pendingSiteReturnRef.current = preview.id;
    siteReturnAttemptRef.current = false;
    siteSessionLeftAppRef.current = false;
    patchPreview(preview.id, { authorizationState: "launching", authorizationMessage: null });
    if (!privacy.interactiveAuthorization || !privacy.browserFallback) {
      patchPreview(preview.id, { authorizationState: "disabled", authorizationMessage: "Enable Edge fallback and interactive authorization in Privacy & network activity." });
      return;
    }
    const result = await authorizePreviewHost(preview.url, { privacy });
    if (!result.clientOk) {
      pendingSiteReturnRef.current = null;
      patchPreview(preview.id, { authorizationState: "failed", authorizationMessage: result.error || "Unable to open authorization browser" });
      return;
    }
    patchPreview(preview.id, {
      authorizationState: "authorizing",
      authorizationMessage: "Finish any required on-site confirmation in Sandbox Edge, then return to this app. One automatic Retry will run and, if successful, recover all remaining previews from that site sequentially."
    });
  }

  const latestPreviewsRef = useRef(previews);
  latestPreviewsRef.current = previews;
  const latestPrivacyRef = useRef(privacy);
  latestPrivacyRef.current = privacy;
  const retryAuthorizedRef = useRef(null);
  useEffect(() => {
    const onAway = () => {
      if (pendingSiteReturnRef.current) siteSessionLeftAppRef.current = true;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onAway();
      else void onReturn();
    };
    const onReturn = async () => {
      if (document.visibilityState === "hidden" || !document.hasFocus() || !siteSessionLeftAppRef.current || siteReturnAttemptRef.current) return;
      const id = pendingSiteReturnRef.current;
      if (!id || !latestPrivacyRef.current.browserFallback) return;
      const item = latestPreviewsRef.current.find((preview) => preview.id === id);
      if (!item) { pendingSiteReturnRef.current = null; return; }
      // Wait for the site's own page transition and confirm the authorized
      // Sandbox Edge process exists before spending one bounded preview retry.
      siteReturnAttemptRef.current = true;
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      if (!document.hasFocus() || document.visibilityState === "hidden") { siteReturnAttemptRef.current = false; return; }
      const status = await authorizationStatus(item.url);
      if (!status.clientOk || (!status.live && !status.ready)) { siteReturnAttemptRef.current = false; return; }
      pendingSiteReturnRef.current = null;
      // Only user-initiated site sessions receive one automatic retry on return.
      // Actual site verification remains a user's action in the visible window.
      await retryAuthorizedRef.current?.(item);
    };
    window.addEventListener("blur", onAway);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.removeEventListener("blur", onAway); window.removeEventListener("focus", onReturn); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  async function runAuthorizedSiteRecovery(preview) {
    const siteKey = siteKeyFor(preview.url);
    if (!siteKey || authorizedSiteAutoRetryRef.current.has(siteKey)) return;
    const items = pendingSiteRecoveryItems(
      latestPreviewsRef.current, siteKey, preview.id, siteKeyFor, needsAuthorizedSiteRetry
    );
    if (!items.length) {
      patchPreview(preview.id, {
        authorizationState: "site-ready", authorizationMessage: "All eligible previews for this site have been processed."
      });
      return;
    }
    authorizedSiteAutoRetryRef.current.add(siteKey);
    siteRecoveryStopRef.current.delete(siteKey);
    const total = items.length;
    let completed = 0;
    let succeeded = 0;
    let consecutiveFailures = 0;
    let stopReason = "completed";
    setSiteRecoveryProgress((current) => ({ ...current, [siteKey]: { status: "running", completed, total, succeeded } }));
    patchPreview(preview.id, {
      authorizationState: "site-recovering",
      authorizationMessage: `Recovering all ${total} unresolved previews for this site sequentially. Network pacing remains active.`
    });
    try {
      for (const target of items) {
        if (siteRecoveryStopRef.current.has(siteKey)) { stopReason = "stopped"; break; }
        if (!latestPrivacyRef.current.browserFallback || !latestPrivacyRef.current.interactiveAuthorization) {
          stopReason = "settings";
          break;
        }
        const latest = latestPreviewsRef.current.find((item) => item.id === target.id);
        if (!latest || !needsAuthorizedSiteRetry(latest)) {
          completed += 1;
          setSiteRecoveryProgress((current) => ({ ...current, [siteKey]: { status: "running", completed, total, succeeded } }));
          continue;
        }
        const result = await processSinglePreview(latest, {
          authorizationState: "site-retry",
          authorizationMessage: "Using the existing approved Sandbox site session…"
        });
        completed += 1;
        if (result?.clientOk && result.image) succeeded += 1;
        consecutiveFailures = recoveryFailureCount(consecutiveFailures, Boolean(result?.clientOk && result.image));
        setSiteRecoveryProgress((current) => ({ ...current, [siteKey]: { status: "running", completed, total, succeeded } }));
        if (completed < total && consecutiveFailures >= SITE_RECOVERY_MAX_CONSECUTIVE_FAILURES) {
          stopReason = "repeated-failures";
          break;
        }
        if (completed < total) {
          await new Promise((resolve) => window.setTimeout(resolve, siteRecoveryDelayMs(consecutiveFailures, SITE_RECOVERY_BASE_DELAY_MS)));
        }
      }
    } finally {
      authorizedSiteAutoRetryRef.current.delete(siteKey);
      siteRecoveryStopRef.current.delete(siteKey);
      const status = stopReason === "completed" ? "completed" : "paused";
      setSiteRecoveryProgress((current) => ({ ...current, [siteKey]: { status, completed, total, succeeded, reason: stopReason } }));
      const summary = stopReason === "completed"
        ? `Finished all ${total} eligible same-site previews: ${succeeded} recovered.`
        : stopReason === "repeated-failures"
          ? `Paused after ${SITE_RECOVERY_MAX_CONSECUTIVE_FAILURES} consecutive unsuccessful previews (${completed}/${total} attempted). Resume remaining items when the site is responsive.`
          : stopReason === "settings"
            ? `Paused at ${completed}/${total} because site-session previewing was disabled.`
            : `Stopped at ${completed}/${total}. The remaining items can be resumed using the same session.`;
      patchPreview(preview.id, { authorizationState: "site-ready", authorizationMessage: summary });
    }
  }

  function stopSiteRecovery(siteKey) {
    if (!authorizedSiteAutoRetryRef.current.has(siteKey)) return;
    siteRecoveryStopRef.current.add(siteKey);
    setSiteRecoveryProgress((current) => ({
      ...current, [siteKey]: { ...(current[siteKey] || {}), status: "stopping" }
    }));
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
    await runAuthorizedSiteRecovery(preview);
  }

  retryAuthorizedRef.current = retryAuthorizedPreview;

  async function retrySiteBatch(preview) {
    const siteKey = siteKeyFor(preview.url);
    if (!siteKey || authorizedSiteAutoRetryRef.current.has(siteKey)) return;
    const status = await authorizationStatus(preview.url);
    if (!status.clientOk || (!status.live && !status.ready)) {
      patchPreview(preview.id, {
        authorizationState: "needs-attention",
        authorizationMessage: "The reusable site session is not available. Open the site session and finish any required confirmation before recovering the remaining previews."
      });
      return;
    }
    await runAuthorizedSiteRecovery(preview);
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
          {networkState?.traffic && <div className="limit-badge" title="Aggregate backend HTTP and headless Edge proxy response bytes in the previous 60 seconds, excluding visible Edge windows and local search service">Observed {((networkState.traffic.observedBytesLastMinute || 0) / 1048576).toFixed(1)} MB/min</div>}
          {networkState?.dns && <div className={`limit-badge dns-badge ${networkState.dns.pressure || "normal"}`} title={`DNS: ${networkState.dns.active} active, ${networkState.dns.queued} queued, ${networkState.dns.averageLatencyMs} ms average, ${networkState.dns.errors} errors`}>DNS {networkState.dns.pressure || "normal"} · {networkState.dns.recentFreshLookupsPerSecond ?? 0}/s · cache {networkState.dns.cacheHitPercent ?? 0}%</div>}
          {finderStats.total > 0 && <div className="limit-badge finder-badge">Finder: {finderStats.running} running · {finderStats.queued} queued</div>}
        </div>
      </header>

      <section className="import-panel">
        <div className="import-tools-grid">
          <div className="import-tool-box">
            <h3>Exclude domains before import</h3>
            <p>Ignore a domain and every subdomain in pasted links; no preview, DNS or Finder work starts for excluded URLs. Rules stay in this session only.</p>
            <div className="import-inline-actions">
              <input aria-label="Domain to exclude" placeholder="example1.com or *.example1.com" value={excludedDomainInput} onChange={(event) => setExcludedDomainInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addExcludedDomain(); } }} />
              <button type="button" onClick={addExcludedDomain}>Exclude domain</button>
            </div>
            {exclusionError && <small className="warning-text">{exclusionError}</small>}
            <div className="excluded-domain-list">{excludedDomains.map((domain) => <button key={domain} type="button" onClick={() => setExcludedDomains((current) => current.filter((value) => value !== domain))} title={`Remove exclusion for ${domain}`}>{domain} ×</button>)}</div>
          </div>
          <div className="import-tool-box">
            <h3>Collect open Sandbox Edge tabs</h3>
            <p>Requires the included local, unpacked Edge extension. Collects web URLs from all windows in this Sandbox Edge profile, one per line. Cannot inspect the host browser.</p>
            <div className="import-inline-actions">
              <button type="button" onClick={collectOpenEdgeTabs} disabled={tabCollectorBusy}>{tabCollectorBusy ? "Collecting…" : "Collect open Edge tabs"}</button>
              <button type="button" onClick={appendCollectedTabs} disabled={!collectedTabText.trim()}>Add to paste list</button>
              <button type="button" onClick={copyCollectedTabs} disabled={!collectedTabText.trim()}>Copy URLs</button>
            </div>
            <textarea aria-label="Collected tab URLs, one per line" className="tab-collector-text" placeholder="Collected URLs will appear here. You can also paste a list manually." value={collectedTabText} onChange={(event) => setCollectedTabText(event.target.value)} />
            {tabCollectorStatus && <small>{tabCollectorStatus}</small>}
          </div>
        </div>
        <form onSubmit={handleSubmit} className="input-form">
          <textarea placeholder="Paste video URLs here — one per line or separated by whitespace…" value={inputText} onChange={(event) => setInputText(event.target.value)} className="multi-input" disabled={processing} />
          <button type="submit" className="primary-button" disabled={processing || !inputText.trim()}>{processing ? "Processing…" : "Create previews"}</button>
        </form>
        {importSummary && (
          <div className="import-summary">
            <strong>{importSummary.added}</strong> added <span>·</span> <strong>{importSummary.duplicates}</strong> duplicates skipped
            {importSummary.excluded > 0 && <><span>·</span> <strong>{importSummary.excluded}</strong> excluded by domain</>}
            {importSummary.invalid > 0 && <><span>·</span> <strong>{importSummary.invalid}</strong> invalid entries ignored</>}
          </div>
        )}
      </section>

      {networkState?.dns && (
        <section className={`dns-health-strip ${networkState.dns.pressure || "normal"}`}>
          <div><strong>DNS pressure: {networkState.dns.pressure || "unknown"}</strong><small>New hostname resolutions are globally governed before they reach Windows / NextDNS.</small></div>
          <dl>
            <div><dt>Fresh DNS</dt><dd>{networkState.dns.recentFreshLookupsPerSecond ?? 0}/s</dd></div>
            <div><dt>Rate ceiling</dt><dd>{networkState.dns.currentRateLimitPerSecond ?? 0}/s</dd></div>
            <div><dt>DNS queue</dt><dd>{networkState.dns.queued ?? 0}</dd></div>
            <div><dt>Avg lookup</dt><dd>{networkState.dns.averageLatencyMs ?? 0} ms</dd></div>
            <div><dt>Cache</dt><dd>{networkState.dns.cacheHitPercent ?? 0}%</dd></div>
            <div><dt>Shared lookups</dt><dd>{networkState.dns.singleFlightShares ?? 0}</dd></div>
            <div><dt>DNS errors</dt><dd>{networkState.dns.errors ?? 0}</dd></div>
          </dl>
          <div className="session-telemetry">
            <div>
              <strong>Memory-only session diagnostics</strong>
              <small>Aggregate counters and timestamps only. No URLs, hostnames, titles, IDs, or search terms are recorded. Nothing is sent to any monitoring service or written to a diagnostic log.</small>
            </div>
            <dl>
              <div><dt>Last batch</dt><dd>{sessionTelemetry.lastBatchAt ? `${sessionTelemetry.lastBatchSize} · ${new Date(sessionTelemetry.lastBatchAt).toLocaleTimeString()}` : "—"}</dd></div>
              <div><dt>Largest batch</dt><dd>{sessionTelemetry.largestBatch}</dd></div>
              <div><dt>Peak DNS queue</dt><dd>{sessionTelemetry.peakDnsQueue}</dd></div>
              <div><dt>Peak DNS</dt><dd>{sessionTelemetry.peakDnsRate}/s</dd></div>
              <div><dt>Peak latency</dt><dd>{sessionTelemetry.peakDnsLatencyMs} ms</dd></div>
              <div><dt>Pressure events</dt><dd>{sessionTelemetry.dnsPressureEvents}</dd></div>
            </dl>
            <button type="button" className="telemetry-copy-button" onClick={copySessionSnapshot}>Copy aggregate snapshot</button>
            <button type="button" className="telemetry-copy-button" onClick={copySafePreviewDiagnostics}>Copy preview diagnostic report (no links)</button>
          </div>
          {networkState.dns.lastPressureReason && networkState.dns.pressure !== "normal" && <p>Adaptive throttle reason: {networkState.dns.lastPressureReason}. The app will ramp back up automatically after DNS recovers.</p>}
        </section>
      )}

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
                <PrivacyToggle checked={privacy.interactiveAuthorization} onChange={(v) => setPrivacyOption("interactiveAuthorization", v)} title="Interactive site sessions" detail="Allows one reusable Sandbox Edge session. After one successful approved-session Retry, recover all eligible unresolved same-site previews sequentially. Pause automatically after repeated failures." />
              </div>
              <div className="privacy-group"><h3>Version Finder — destinations</h3>
                <PrivacyToggle checked={privacy.mediaTools} onChange={(v) => setPrivacyOption("mediaTools", v)} title="Media-tool probing" detail="Allows yt-dlp/Deno to inspect selected and candidate public video pages/CDNs inside Sandbox." />
                <PrivacyToggle checked={privacy.searchSearxng} onChange={(v) => setPrivacyOption("searchSearxng", v)} title="SearXNG metasearch" detail="Uses a SearXNG JSON API as the primary general-web discovery layer with Safe Search requested off (0). Direct DDG/Mojeek/Brave remain automatic fallback when SearXNG is unavailable or sparse." />
                {privacy.searchSearxng && (
                  <div className={`searxng-control ${searxngState?.ok ? "ready" : "unavailable"}`}>
                    <div><strong>SearXNG</strong><span>{searxngState?.ok ? `${searxngState.instanceName || "SearXNG"} · ${searxngState.engineCount || 0} engines` : "Unavailable"}</span></div>
                    <small>{searxngState?.ok ? `${searxngState.local ? "Local Sandbox endpoint" : "Remote endpoint"} · instance default SafeSearch ${searxngState.safeSearchDefault ?? "unknown"}; Finder still sends safesearch=0 on every query.` : (searxngState?.error || "Start a SearXNG instance or change the endpoint. Finder will fall back automatically while it is unavailable.")}</small>
                    <div className="searxng-endpoint-row">
                      <input value={searxngEndpoint} onChange={(event) => setSearxngEndpoint(event.target.value)} spellCheck="false" aria-label="SearXNG endpoint" />
                      <button type="button" onClick={refreshSearxngState} disabled={searxngBusy}>{searxngBusy ? "Testing…" : "Test"}</button>
                    </div>
                    {!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(searxngEndpoint) && <small className="warning-text">Remote SearXNG endpoints receive your Finder queries and are operated by a third party. Local 127.0.0.1:8888 is preferred.</small>}
                  </div>
                )}
                <PrivacyToggle checked={privacy.searchDuckDuckGo} onChange={(v) => setPrivacyOption("searchDuckDuckGo", v)} title="DuckDuckGo search" detail="Sends enabled finder queries to DuckDuckGo's public search endpoint." />
                <PrivacyToggle checked={privacy.searchBing} onChange={(v) => setPrivacyOption("searchBing", v)} title="Bing search" detail="Uses a dedicated Sandbox Edge/Bing profile. Finder skips Bing unless SafeSearch Off has been verified for that session." />
                {privacy.searchBing && (
                  <div className={`bing-session-control ${bingState?.state || "unverified"}`}>
                    <div><strong>Bing SafeSearch</strong><span>{bingState?.state === "off" ? "Off verified" : bingState?.state === "moderate" ? "Moderate detected" : bingState?.state === "strict" ? "Strict detected" : "Unverified"}</span></div>
                    <small>{bingState?.evidence || "Configure the disposable Sandbox Bing profile once per Sandbox session. Finder will not use Bing while Off is unverified."}</small>
                    <div className="bing-session-actions">
                      <button type="button" onClick={openBingConfiguration} disabled={bingBusy}>{bingBusy ? "Opening…" : "Configure Bing Off"}</button>
                      <button type="button" onClick={refreshBingState}>Refresh status</button>
                    </div>
                  </div>
                )}
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
            <div className="privacy-footnote"><strong>Always local:</strong> selection state, queues, ranking, perceptual hashes, temporary browser profiles, and caches remain inside Windows Sandbox. <strong>Network diagnostics:</strong> aggregate telemetry is memory-only in the running UI/server process and is not written to a diagnostic log or exported to a monitoring service. <strong>Always required for basic previews:</strong> creating a preview contacts the pasted public video URL itself.</div>
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

      <div className="workspace-memory-status" role="status">{workspaceStatus}. Session-only; cleared when the Sandbox server stops.</div>
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
                  const previewSiteKey = siteKeyFor(preview.url);
                  const siteUnresolvedCount = previewSiteKey ? (unresolvedBySite.get(previewSiteKey) || 0) : 0;
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
                        {(preview.deadLink || preview.state === "failed") && (
                          <div className="challenge-box">
                            <p className="warning-message">{preview.deadHost ? `Host ${preview.deadHostName || domainFor(preview.url)} was confirmed unreachable after repeated hard network failures; sibling links were suppressed to avoid repeated network traffic.` : preview.deadLink ? "This individual URL returned the same 404/410 twice. The host itself remains eligible for other links." : "This preview failed; the site may be unavailable, protected, or temporarily unreachable."} Version Finder can still use URL and archive clues.</p>
                            <div className="challenge-actions">
                              <button type="button" onClick={() => recheckDeadPreview(preview)} disabled={processing}>Recheck URL/host</button>
                              <button type="button" onClick={() => recoverPreviewHistory(preview)} disabled={preview.historical?.state === "loading"} title="On demand: use enabled Wayback/Common Crawl archives; if no title survives and DDG plus media-ID search are enabled, search DuckDuckGo for the exact URL.">{preview.historical?.state === "loading" ? "Searching archives…" : "Recover historical video details"}</button>
                            </div>
                            <small>Recovery is on demand. If enabled in Privacy settings, a missing archive title may trigger one DuckDuckGo lookup of this exact URL.</small>
                            {preview.historical?.state === "failed" && <small>Recovery failed: {preview.historical.error}</small>}
                            {preview.historical?.state === "ready" && <div className="historical-recovery">
                              <strong>Historical information · {preview.historical.titleOrigin === "archived_page" ? "archived page" : "URL clue only"}</strong>
                              <p>{preview.historical.note}</p>
                              <label>Video title for Finder (editable)
                                <input type="text" defaultValue={preview.title || preview.historical.title || ""} onChange={(event) => patchPreview(preview.id, { title: event.target.value })} placeholder="Enter known original video title" />
                              </label>
                              {preview.historical.uploader && <p>Uploader: {preview.historical.uploader}</p>}
                              {preview.historical.uploadDate && <p>Published: {preview.historical.uploadDate}</p>}
                              {preview.historical.archive?.snapshotUrl && <a href={preview.historical.archive.snapshotUrl} target="_blank" rel="noopener noreferrer">Open archived capture ↗</a>}
                              {preview.historical.archive && <small>Source: {preview.historical.archive.provider || "Archive not found"} · {preview.historical.archive.capture || preview.historical.archive.error || "no snapshot"}</small>}
                              {preview.historical.urlClues?.ids?.length > 0 && <small>URL IDs: {preview.historical.urlClues.ids.slice(0, 4).join(", ")}</small>}
                              {preview.historical.archivedOutboundUrls?.length > 0 && <details><summary>Links mentioned by the archived page ({preview.historical.archivedOutboundUrls.length})</summary>{preview.historical.archivedOutboundUrls.map((link) => <div key={link}><a href={link} target="_blank" rel="noopener noreferrer">{link}</a></div>)}</details>}
                              {preview.historical.historicalSearchDisclosure && <small>{preview.historical.historicalSearchDisclosure}</small>}
                              {preview.historical.historicalMentions?.length > 0 && <details open><summary>Potential historical mentions ({preview.historical.historicalMentions.length}) — unverified</summary>{preview.historical.historicalMentions.map((mention, index) => <div key={`${mention.url}-${index}`}><a href={mention.url} target="_blank" rel="noopener noreferrer">{mention.title || mention.url}</a>{mention.snippet && <small>{mention.snippet}</small>}</div>)}</details>}
                              <small>Select this item and queue Version Finder to search by the recovered or edited title.</small>
                            </div>}
                          </div>
                        )}
                        {siteSessionEligible && preview.state !== "failed" && (
                          <div className="challenge-box">
                            <p className="warning-message">
                              {preview.manualVerificationRequired
                                ? "This site appears to require user verification. Public metadata did not expose a thumbnail; opening the site manually may be necessary."
                                : preview.challengeDetected
                                  ? "The lightweight preview was blocked or challenged. Open one reusable Sandbox site session."
                                  : "No public thumbnail could be recovered from page headers, body metadata or the unattended browser. This site may require a cookie-consent or login step."}
                              {" "}After on-site confirmation, returning to the app automatically retries this item once. A successful result starts paced, sequential recovery of all eligible unresolved same-site previews.
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
                        {(preview.authorizationState === "site-ready" || preview.authorizationState === "site-recovering") && (siteUnresolvedCount > 0 || siteRecoveryProgress[previewSiteKey]?.status === "running") && (
                          <div className="challenge-box">
                            <p className="warning-message">
                              {siteRecoveryProgress[previewSiteKey]?.status === "running" || siteRecoveryProgress[previewSiteKey]?.status === "stopping"
                                ? `Sequential site recovery: ${siteRecoveryProgress[previewSiteKey]?.completed || 0}/${siteRecoveryProgress[previewSiteKey]?.total || 0} attempted, ${siteRecoveryProgress[previewSiteKey]?.succeeded || 0} recovered.`
                                : `Approved session available. ${siteUnresolvedCount} unresolved preview${siteUnresolvedCount === 1 ? "" : "s"} remain for this site.`}
                            </p>
                            <div className="challenge-actions">
                              {siteRecoveryProgress[previewSiteKey]?.status === "running" || siteRecoveryProgress[previewSiteKey]?.status === "stopping"
                                ? <button type="button" onClick={() => stopSiteRecovery(previewSiteKey)} disabled={siteRecoveryProgress[previewSiteKey]?.status === "stopping"}>Stop after current preview</button>
                                : <button type="button" onClick={() => retrySiteBatch(preview)} disabled={!privacy.browserFallback || !privacy.interactiveAuthorization}>Recover all remaining from site</button>}
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
                              <div><dt>Body metadata scanned</dt><dd>{preview.passiveBodyRead ? "yes" : "not needed"}</dd></div>
                              <div><dt>Additional HTML fetch</dt><dd>{preview.passiveBodyRetry ? "yes — bounded" : "no"}</dd></div>
                              <div><dt>Verification indicator</dt><dd>{preview.manualVerificationRequired ? "manual verification may be required" : "none detected"}</dd></div>
                              <div><dt>Browser fallback</dt><dd>{preview.browserFallbackQueued ? "queued" : preview.browserFallback ? "used" : preview.browserFallbackAttempted ? "attempted" : "no"}</dd></div>
                              <div><dt>Authorized session</dt><dd>{preview.authorizedBrowserSession ? "live Edge" : preview.authorizedBrowserProfile ? "saved profile" : preview.authorizationState || "no"}</dd></div>
                              <div><dt>Fallback error</dt><dd>{preview.browserFallbackError || "none"}</dd></div>
                              <div><dt>Challenge</dt><dd>{preview.challengeDetected ? (preview.challengeProvider || "detected") : "none"}</dd></div>
                              <div><dt>Fallback skipped</dt><dd>{preview.browserFallbackSkippedReason || "none"}</dd></div>
                              <div><dt>Client network</dt><dd>{preview.clientNetworkError || "none"}</dd></div>
                              <div><dt>Warning</dt><dd>{preview.warning || "none"}</dd></div>
                              <div><dt>Dead link</dt><dd>{preview.deadLink ? (preview.deadHost ? `host unreachable${preview.hostSuppressed ? " · suppressed" : ""}` : preview.deadReason || "yes") : "no"}</dd></div>
                              <div><dt>Host reachability confirmations</dt><dd>{preview.reachabilityConfirmations || "—"}</dd></div>
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
          {!visiblePreviews.length && <section className="empty-workspace"><strong>{activeTab === "dead" ? "No dead links" : "No previews yet"}</strong><p>{activeTab === "dead" ? "Hosts confirmed unreachable by repeated hard network failures and individual URLs confirmed 404/410 twice are moved here automatically. They can still be queued into Version Finder using URL/archive clues." : "Paste video URLs above to begin."}</p></section>}
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
                              alreadyInList={previews.some((item) => videoUrlIdentity(item.url) === videoUrlIdentity(candidate.url))}
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
                                alreadyInList={previews.some((item) => videoUrlIdentity(item.url) === videoUrlIdentity(candidate.url))}
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
                        {job.privacy && <div className="alternate-diagnostic-row"><strong>Privacy snapshot</strong><span>{[job.privacy.searchSearxng && "SearXNG", job.privacy.searchDuckDuckGo && "DDG", job.privacy.searchBing && "Bing", job.privacy.searchMojeek && "Mojeek", job.privacy.searchBrave && "Brave", job.privacy.archiveLookups && "Archives"].filter(Boolean).join("+") || "no search engines"}</span><span>{job.privacy.mediaTools ? "media tools on" : "media tools off"}</span><code>{[job.privacy.searchTranscript && "transcript", job.privacy.searchDescription && "description", job.privacy.searchMediaIds && "media IDs", job.privacy.searchTitleUploader && "title/uploader"].filter(Boolean).join(" · ") || "no query signals"}</code></div>}
                        {job.tools && (
                          <div className="alternate-diagnostic-row discovery-tool-row">
                            <strong>Media tools</strong><span>{job.tools.installed ? "installed" : "not found"}</span>
                            <span>{[job.tools.ytDlp && "yt-dlp", job.tools.deno && "Deno", job.tools.ffmpeg && "FFmpeg"].filter(Boolean).join(" · ") || "page probe only"}</span>
                            <code>{job.tools.sourceMode || "—"}{job.tools.sourceExtractor ? ` / ${job.tools.sourceExtractor}` : ""}</code>
                          </div>
                        )}
                        {job.searxng && <div className="alternate-diagnostic-row"><strong>SearXNG</strong><span>{job.searxng.healthy ? "healthy" : "fallback used"}</span><span>{job.searxng.endpoint || job.searxngEndpoint || "—"}</span><code>{job.searxng.enabled ? "primary metasearch when healthy" : "disabled"}</code></div>}
                        {job.searchPolicy && <div className="alternate-diagnostic-row"><strong>Search filtering</strong><span>SearXNG: safesearch=0 · DDG/Mojeek/Brave: off requested · Bing: verified Off session required</span><span>Archives: no app SafeSearch filter</span><code>{job.searchPolicy.note}</code></div>}
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
