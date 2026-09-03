import { useEffect, useMemo, useRef, useState } from "react";
import { fetchAlternates, fetchPreview, imageProxyUrl } from "./api.js";
import "./App.css";

const CLIENT_CONCURRENCY = 12;
const BROWSER_FALLBACK_CONCURRENCY = 1;

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
    if (!normalized) {
      invalid += 1;
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(normalized);
  }

  return { urls: valid, invalid };
}

function domainFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown source";
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function LazyThumbnail({ sources, sourceUrl, title }) {
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
    if (!candidates.length) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return undefined;
    }

    const node = holderRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "700px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [candidates]);

  const current = candidates[candidateIndex] || null;
  const exhausted = candidates.length > 0 && candidateIndex >= candidates.length;

  return (
    <div className="thumbnail-shell" ref={holderRef}>
      {current && shouldLoad && !exhausted ? (
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
          <span>
            {!candidates.length || exhausted
              ? "Thumbnail unavailable"
              : shouldLoad
                ? "Trying alternate thumbnail…"
                : "Thumbnail queued…"}
          </span>
        </div>
      )}
      <div className="play-mark" aria-hidden="true">▶</div>
      {candidates.length > 1 && candidateIndex < candidates.length && (
        <div className="thumbnail-candidate-count" title="Thumbnail fallback candidate">
          {candidateIndex + 1}/{candidates.length}
        </div>
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

function App() {
  const [inputText, setInputText] = useState("");
  const [previews, setPreviews] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [processing, setProcessing] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [alternatePanel, setAlternatePanel] = useState(null);

  const stats = useMemo(() => {
    let queued = 0;
    let loading = 0;
    let ready = 0;
    let failed = 0;
    for (const item of previews) {
      if (item.state === "queued") queued += 1;
      else if (item.state === "loading") loading += 1;
      else if (item.state === "failed") failed += 1;
      else if (item.state === "ready") ready += 1;
    }
    return { queued, loading, ready, failed, total: previews.length };
  }, [previews]);

  function patchPreview(id, patch) {
    setPreviews((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  async function processItems(items) {
    if (!items.length) return;
    setProcessing(true);
    const browserFallbackItems = [];
    try {
      // Fast pass first: let all lightweight/provider previews finish before any
      // one-at-a-time browser fallbacks can hold up the queue.
      await runPool(items, async (item) => {
        patchPreview(item.id, { state: "loading", error: null });
        const result = await fetchPreview(item.url, { allowBrowserFallback: false });
        patchPreview(item.id, {
          ...result,
          state: result.clientOk ? "ready" : "failed",
          error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
        });
        if (result.clientOk && result.needsBrowserFallback) browserFallbackItems.push(item);
      });

      // Slow lane second: only sources that actually need a real browser enter it.
      if (browserFallbackItems.length) {
        await runPool(
          browserFallbackItems,
          async (item) => {
            patchPreview(item.id, { state: "loading", error: null, method: "edge-fallback-queued" });
            const result = await fetchPreview(item.url, { allowBrowserFallback: true });
            patchPreview(item.id, {
              ...result,
              state: result.clientOk ? "ready" : "failed",
              error: result.clientOk ? result.error || null : result.error || `HTTP ${result.clientStatus}`
            });
          },
          BROWSER_FALLBACK_CONCURRENCY
        );
      }
    } finally {
      setProcessing(false);
    }
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
      id: `${stamp}-${index}`,
      url,
      state: "queued",
      title: null,
      description: null,
      image: null,
      provider: null,
      method: null,
      error: null
    }));

    setImportSummary({
      added: items.length,
      duplicates: duplicateCount,
      invalid: parsed.invalid
    });
    setInputText("");

    if (!items.length) return;
    setPreviews((current) => [...current, ...items]);
    await processItems(items);
  }

  function toggleSelected(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(previews.map((item) => item.id)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function invertSelection() {
    setSelected((current) => {
      const next = new Set();
      for (const item of previews) if (!current.has(item.id)) next.add(item.id);
      return next;
    });
  }

  async function copySelected() {
    const urls = previews.filter((item) => selected.has(item.id)).map((item) => item.url);
    if (!urls.length) return;
    try {
      await navigator.clipboard.writeText(urls.join("\r\n"));
      setCopyStatus(`Copied ${urls.length} URL${urls.length === 1 ? "" : "s"}`);
    } catch {
      setCopyStatus("Clipboard copy failed");
    }
    setTimeout(() => setCopyStatus(""), 2200);
  }

  function removeSelected() {
    if (processing || !selected.size) return;
    setPreviews((current) => current.filter((item) => !selected.has(item.id)));
    setSelected(new Set());
  }

  function clearAll() {
    if (processing) return;
    setPreviews([]);
    setSelected(new Set());
    setImportSummary(null);
  }

  async function retryFailed() {
    if (processing) return;
    const failed = previews.filter((item) => item.state === "failed");
    await processItems(failed);
  }

  async function findSelectedAlternates() {
    if (selected.size !== 1) return;
    const source = previews.find((item) => selected.has(item.id));
    if (!source) return;

    setAlternatePanel({
      sourceId: source.id,
      source,
      state: "loading",
      results: [],
      error: null,
      note: null,
      diagnostics: []
    });

    const result = await fetchAlternates(source);
    if (!result.clientOk) {
      setAlternatePanel((current) => current?.sourceId === source.id ? {
        ...current,
        state: "failed",
        error: result.error || `Search failed (${result.clientStatus || "network"})`
      } : current);
      return;
    }

    setAlternatePanel((current) => current?.sourceId === source.id ? {
      ...current,
      state: "ready",
      source: { ...source, ...(result.source || {}) },
      results: Array.isArray(result.results) ? result.results : [],
      note: result.note || null,
      diagnostics: result.searchDiagnostics || [],
      candidateCount: result.candidateCount || 0,
      evaluatedCount: result.evaluatedCount || 0,
      cached: Boolean(result.cached),
      clientMs: result.clientMs,
      manualSearchUrl: result.manualSearchUrl || null
    } : current);
  }

  function addAlternate(candidate) {
    const normalized = candidate.url?.toLowerCase();
    if (!normalized) return;
    const existing = previews.find((item) => item.url.toLowerCase() === normalized);
    if (!existing) {
      const item = {
        id: `alternate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        url: candidate.url,
        state: "ready",
        title: candidate.title || null,
        description: candidate.description || null,
        image: candidate.image || null,
        images: candidate.images || (candidate.image ? [candidate.image] : []),
        provider: candidate.provider || null,
        durationSeconds: candidate.durationSeconds || null,
        method: candidate.method || "alternate-search",
        error: null,
        alternateRelation: candidate.relation || null,
        alternateConfidence: candidate.confidence || null
      };
      setPreviews((current) => [...current, item]);
    }
    setAlternatePanel((current) => current ? {
      ...current,
      results: current.results.map((item) => item.url === candidate.url ? { ...item, added: true } : item)
    } : current);
  }

  function closeAlternates() {
    setAlternatePanel(null);
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
          <p className="subtitle">Paste hundreds of video links. Preview traffic is queued and rate-limited.</p>
        </div>
        <div className="limit-badge" title="Client preview workers">
          {CLIENT_CONCURRENCY} fast workers · {BROWSER_FALLBACK_CONCURRENCY} browser fallback
        </div>
      </header>

      <section className="import-panel">
        <form onSubmit={handleSubmit} className="input-form">
          <textarea
            placeholder="Paste video URLs here — one per line or separated by whitespace…"
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            className="multi-input"
            disabled={processing}
          />
          <button type="submit" className="primary-button" disabled={processing || !inputText.trim()}>
            {processing ? "Processing…" : "Create previews"}
          </button>
        </form>

        {importSummary && (
          <div className="import-summary">
            <strong>{importSummary.added}</strong> added
            <span>·</span>
            <strong>{importSummary.duplicates}</strong> duplicates skipped
            {importSummary.invalid > 0 && (
              <>
                <span>·</span>
                <strong>{importSummary.invalid}</strong> invalid entries ignored
              </>
            )}
          </div>
        )}
      </section>

      {previews.length > 0 && (
        <>
          <section className="status-strip">
            <div className="progress-copy">
              <strong>{stats.ready + stats.failed} / {stats.total}</strong> processed
              {stats.loading > 0 && <span> · {stats.loading} active</span>}
              {stats.queued > 0 && <span> · {stats.queued} queued</span>}
              {stats.failed > 0 && <span className="failed-text"> · {stats.failed} failed</span>}
            </div>
            <div className="progress-track" aria-label="Preview processing progress">
              <div
                className="progress-fill"
                style={{ width: `${stats.total ? ((stats.ready + stats.failed) / stats.total) * 100 : 0}%` }}
              />
            </div>
          </section>

          <section className="actionbar">
            <div className="selection-count">{selected.size} selected</div>
            <div className="action-buttons">
              <button type="button" onClick={selectAll}>Select all</button>
              <button type="button" onClick={clearSelection}>Deselect</button>
              <button type="button" onClick={invertSelection}>Invert</button>
              <button type="button" onClick={copySelected} disabled={!selected.size}>Copy selected URLs</button>
              <button
                type="button"
                onClick={findSelectedAlternates}
                disabled={selected.size !== 1 || processing}
                title={selected.size === 1 ? "Find likely mirrors and longer versions of this video" : "Select exactly one video"}
              >
                Find alternates
              </button>
              <button type="button" onClick={removeSelected} disabled={!selected.size || processing}>Remove selected</button>
              {stats.failed > 0 && (
                <button type="button" onClick={retryFailed} disabled={processing}>Retry failed</button>
              )}
              <button type="button" onClick={clearAll} disabled={processing}>Clear all</button>
            </div>
            {copyStatus && <div className="copy-toast">{copyStatus}</div>}
          </section>

          <section className="preview-grid">
            {previews.map((preview) => {
              const isSelected = selected.has(preview.id);
              const duration = formatDuration(preview.durationSeconds);
              return (
                <article
                  key={preview.id}
                  className={`preview-card ${isSelected ? "selected" : ""} ${preview.state}`}
                  onClick={(event) => handleCardClick(event, preview.id)}
                >
                  <div className="card-selector">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(preview.id)}
                      aria-label={`Select ${preview.title || preview.url}`}
                    />
                  </div>

                  {preview.state === "queued" || preview.state === "loading" ? (
                    <div className="thumbnail-shell">
                      <div className="thumbnail-placeholder pulse">
                        <span>{preview.state === "queued" ? "Queued…" : "Finding video thumbnail…"}</span>
                      </div>
                    </div>
                  ) : (
                    <LazyThumbnail
                      sources={preview.images?.length ? preview.images : preview.image ? [preview.image] : []}
                      sourceUrl={preview.url}
                      title={preview.title}
                    />
                  )}

                  <div className="preview-content">
                    <div className="meta-row">
                      <span className="source-domain">{preview.provider || domainFor(preview.url)}</span>
                      {duration && <span className="duration-badge">{duration}</span>}
                      {preview.alternateRelation && (
                        <span className="alternate-source-badge" title={`${preview.alternateConfidence || "?"}% discovery confidence`}>
                          {preview.alternateRelation}
                        </span>
                      )}
                      {preview.method && <span className="method-badge">{preview.method}</span>}
                    </div>

                    <h2>{preview.title || (preview.state === "failed" ? "Preview failed" : "Video preview")}</h2>
                    {preview.description && <p>{preview.description}</p>}
                    {preview.warning && preview.state !== "failed" && (
                      <p className="warning-message">Source restricted lightweight access; fallback was attempted.</p>
                    )}
                    {preview.state === "failed" && (
                      <p className="error-message">{preview.error || "Unable to retrieve preview metadata."}</p>
                    )}

                    <div className="card-footer">
                      <a href={preview.url} target="_blank" rel="noopener noreferrer">Open video ↗</a>
                      <span className="timing">
                        {Number.isFinite(preview.elapsedMs) ? `${preview.elapsedMs} ms` : ""}
                        {preview.cached ? " · cache" : ""}
                      </span>
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
                          <div><dt>Browser fallback</dt><dd>{preview.browserFallback ? "used" : preview.browserFallbackAttempted ? "attempted" : "no"}</dd></div>
                          <div><dt>Fallback error</dt><dd>{preview.browserFallbackError || "none"}</dd></div>
                          <div><dt>Client network</dt><dd>{preview.clientNetworkError || "none"}</dd></div>
                          <div><dt>Warning</dt><dd>{preview.warning || "none"}</dd></div>
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

      {alternatePanel && (
        <div className="alternate-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeAlternates();
        }}>
          <section className="alternate-panel" role="dialog" aria-modal="true" aria-label="Find alternate video versions">
            <header className="alternate-header">
              <div>
                <div className="alternate-kicker">Alternate video discovery</div>
                <h2>{alternatePanel.source?.title || "Selected video"}</h2>
                <p>
                  Finds public search results that look like mirrors or longer versions. Results are ranked from metadata; they are not content-fingerprint verified.
                </p>
              </div>
              <button type="button" className="close-button" onClick={closeAlternates} aria-label="Close alternate search">×</button>
            </header>

            <div className="alternate-source-summary">
              <span>{alternatePanel.source?.provider || domainFor(alternatePanel.source?.url || "")}</span>
              {formatDuration(alternatePanel.source?.durationSeconds) && (
                <span>{formatDuration(alternatePanel.source.durationSeconds)}</span>
              )}
              <a href={alternatePanel.source?.url} target="_blank" rel="noopener noreferrer">Open source ↗</a>
            </div>

            {alternatePanel.state === "loading" && (
              <div className="alternate-loading">
                <div className="alternate-spinner" />
                <div>
                  <strong>Searching for related copies…</strong>
                  <p>Search and candidate checks use the same bounded network queue as previews.</p>
                </div>
              </div>
            )}

            {alternatePanel.state === "failed" && (
              <div className="alternate-empty error-message">
                <strong>Alternate search failed</strong>
                <p>{alternatePanel.error || "No search results were available."}</p>
                <button type="button" onClick={findSelectedAlternates}>Try again</button>
              </div>
            )}

            {alternatePanel.state === "ready" && (
              <>
                <div className="alternate-toolbar">
                  <span>
                    {alternatePanel.results.length} ranked result{alternatePanel.results.length === 1 ? "" : "s"}
                    {alternatePanel.evaluatedCount ? ` · ${alternatePanel.evaluatedCount} evaluated` : ""}
                    {alternatePanel.cached ? " · cache" : ""}
                  </span>
                  <span className="alternate-toolbar-right">
                    {Number.isFinite(alternatePanel.clientMs) && <span>{alternatePanel.clientMs} ms</span>}
                    {alternatePanel.manualSearchUrl && (
                      <a href={alternatePanel.manualSearchUrl} target="_blank" rel="noopener noreferrer">Broader web search ↗</a>
                    )}
                  </span>
                </div>

                {alternatePanel.results.length ? (
                  <div className="alternate-results">
                    {alternatePanel.results.map((candidate) => {
                      const candidateDuration = formatDuration(candidate.durationSeconds);
                      const sourceDuration = Number(alternatePanel.source?.durationSeconds) || 0;
                      const longerBy = sourceDuration && candidate.durationSeconds > sourceDuration
                        ? formatDuration(candidate.durationSeconds - sourceDuration)
                        : null;
                      const alreadyInList = previews.some((item) => item.url.toLowerCase() === candidate.url.toLowerCase());
                      return (
                        <article className="alternate-result" key={candidate.url}>
                          <div className="alternate-thumb">
                            <LazyThumbnail
                              sources={candidate.images?.length ? candidate.images : candidate.image ? [candidate.image] : []}
                              sourceUrl={candidate.url}
                              title={candidate.title}
                            />
                          </div>
                          <div className="alternate-result-body">
                            <div className="alternate-result-topline">
                              <span className={`relation-badge ${["Likely longer", "Possible longer"].includes(candidate.relation) ? "longer" : candidate.relation === "Likely mirror" ? "mirror" : "possible"}`}>
                                {candidate.relation}
                              </span>
                              <span className="confidence-badge">{candidate.confidence}% confidence</span>
                              {candidateDuration && <span className="duration-badge">{candidateDuration}</span>}
                              {longerBy && <span className="longer-by">+{longerBy}</span>}
                            </div>
                            <h3>{candidate.title || candidate.url}</h3>
                            <div className="alternate-domain">{candidate.provider || domainFor(candidate.url)}</div>
                            {candidate.description && <p>{candidate.description}</p>}
                            <div className="alternate-result-actions">
                              <a href={candidate.url} target="_blank" rel="noopener noreferrer">Open candidate ↗</a>
                              <button
                                type="button"
                                onClick={() => addAlternate(candidate)}
                                disabled={candidate.added || alreadyInList}
                              >
                                {candidate.added || alreadyInList ? "Already in list" : "Add to list"}
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="alternate-empty">
                    <strong>No convincing alternates found</strong>
                    <p>The search may not have enough distinctive title metadata, or public indexes may not expose another copy.</p>
                  </div>
                )}

                <details className="alternate-diagnostics">
                  <summary>Search diagnostics</summary>
                  <p>{alternatePanel.note}</p>
                  {(alternatePanel.diagnostics || []).map((entry, index) => (
                    <div className="alternate-diagnostic-row" key={`${entry.engine}-${index}`}>
                      <strong>{entry.engine}</strong>
                      <span>{entry.status || "network"}</span>
                      <span>{entry.found || 0} results</span>
                      <code>{entry.query}</code>
                      {entry.error && <span className="failed-text">{entry.error}</span>}
                    </div>
                  ))}
                </details>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
