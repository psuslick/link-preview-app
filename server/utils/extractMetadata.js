import fetch from "node-fetch";
import * as cheerio from "cheerio";

export async function extractMetadata(url) {
  try {
    const html = await fetch(url).then(r => r.text());
    const $ = cheerio.load(html);

    const get = sel => $(sel).attr("content") || null;

    const og = get('meta[property="og:image"]');
    const tw = get('meta[name="twitter:image"]');
    const poster = $("video").attr("poster") || null;
    const firstImg = $("img").attr("src") || null;

    return og || tw || poster || firstImg || null;
  } catch {
    return null;
  }
}