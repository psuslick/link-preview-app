import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { URL as NodeURL } from "url";

const app = express();
app.use(cors());

async function tryOEmbed(targetUrl) {
  try {
    const u = new NodeURL(targetUrl);
    const oembedUrl = `${u.origin}/oembed?url=${encodeURIComponent(targetUrl)}`;

    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) return null;

    const data = await res.json();

    return {
      title: data.title || null,
      description: data.description || null,
      image: data.thumbnail_url || null,
      provider: data.provider_name || null,
      raw: data
    };
  } catch {
    return null;
  }
}

async function fetchHTML(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) {
      return { error: "upstream_error", status: res.status };
    }

    const html = await res.text();
    return { html, status: res.status };
  } catch (err) {
    return { error: err.message };
  }
}

function extractMetadata(html, url) {
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text() ||
    null;

  const description =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content") ||
    null;

  const image =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    null;

  return { title, description, image, url };
}

app.get("/api/preview", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "missing_url" });

  // 1. Try oEmbed first
  const oembed = await tryOEmbed(targetUrl);
  if (oembed && (oembed.title || oembed.image)) {
    return res.json({
      title: oembed.title,
      description: oembed.description,
      image: oembed.image,
      provider: oembed.provider,
      url: targetUrl,
      oembed: true,
      raw: oembed.raw
    });
  }

  // 2. Fallback to HTML fetch
  const result = await fetchHTML(targetUrl);

  if (result.error) {
    return res.status(502).json({
      error: "upstream_error",
      status: result.status || 502,
      url: targetUrl
    });
  }

  const metadata = extractMetadata(result.html, targetUrl);

  return res.json(metadata);
});

app.listen(3000, () => {
  console.log("Hybrid preview engine listening on port 3000");
});