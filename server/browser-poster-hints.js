// Browser DOM snapshots used only inside the disposable Sandbox. Extract image
// references from initialized player elements, without downloading media.
// Inputs/outputs remain in process memory; nothing is logged or transmitted.
export const BROWSER_POSTER_SNAPSHOT = String.raw`(() => {
  const html = document.documentElement?.outerHTML || '';
  const pageUrl = typeof location === 'object' && location?.href ? location.href : 'about:blank';
  const cues = /player|video|poster|thumb|preview|cover|watch|hero/i;
  const imageTypes = /\.(?:jpe?g|png|webp|avif|gif)(?:$|[?#])/i;
  const hints = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || hints.length >= 12) return;
    try {
      const url = new URL(String(candidate).trim(), pageUrl);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
      if (/\.(?:mp4|m4v|webm|mov|m3u8|mpd)(?:$|[?#])/i.test(url.href)) return;
      const value = url.href;
      if (!seen.has(value)) { seen.add(value); hints.push(value); }
    } catch {}
  };
  for (const video of [...document.querySelectorAll('video')].slice(0, 12)) {
    add(video.poster || video.getAttribute('poster'));
  }
  for (const img of [...document.querySelectorAll('img')].slice(0, 100)) {
    const parent = img.closest('[class],[id]');
    const context = [img.id, img.className, img.alt, parent?.className, parent?.id].map(x => typeof x === 'string' ? x : '').join(' ');
    const candidate = img.currentSrc || img.src || img.getAttribute('data-src');
    const rect = img.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 70) continue;
    if (!cues.test(context) && !imageTypes.test(candidate || '')) continue;
    if (!img.complete || img.naturalWidth < 100) continue;
    add(candidate);
  }
  // Many players display a cover as CSS, not a serialized DOM attribute.
  for (const el of [...document.querySelectorAll('[class],[id],[style]')].slice(0, 120)) {
    const context = [el.id, el.className].map(x => typeof x === 'string' ? x : '').join(' ');
    if (!cues.test(context)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 70) continue;
    const bg = getComputedStyle(el).backgroundImage || '';
    const matches = bg.matchAll(/url\([\s]*["']?([^"')]+)["']?[\s]*\)/g);
    for (const match of matches) add(match[1]);
    if (hints.length >= 12) break;
  }
  return { html, posterHints: hints, pageUrl, title: document.title || '', readyState: document.readyState };
})()`;

function isHttpPosterUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      !/\.(?:mp4|webm|mov|m3u8|mpd)(?:$|[?#])/i.test(url.href);
  } catch { return false; }
}

// Turn live image properties (img.currentSrc, computed CSS covers, video.poster)
// into standard video poster elements the existing HTML extractor understands.
export function appendLivePosterHints(html, candidates = []) {
  const source = String(html || '');
  if (!Array.isArray(candidates) || !candidates.length) return source;
  const unique = [...new Set(candidates.filter(isHttpPosterUrl))].slice(0, 8);
  if (!unique.length) return source;
  const markup = unique.map((url) => `<video poster="${url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"></video>`).join('');
  return `${source}\n${markup}`;
}
