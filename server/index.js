import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Health check route
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Universal Playwright scraper with stealth + safe URL handling
app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  // Prevent undefined or empty URLs from breaking Playwright
  if (!url || typeof url !== "string" || url.trim() === "") {
    return res.json({ url: null, title: null, thumbnail: null });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true
    });

    const page = await context.newPage();

    // Avoid networkidle — many sites never reach it due to bot detection
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    // Give JS time to inject metadata
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      const get = (sel) => document.querySelector(sel)?.content || null;

      const ogImage =
        get('meta[property="og:image"]') ||
        get('meta[name="twitter:image"]') ||
        get('meta[property="og:image:url"]') ||
        get('meta[property="og:image:secure_url"]');

      const title =
        get('meta[property="og:title"]') ||
        document.querySelector("title")?.innerText ||
        null;

      const firstImg = document.querySelector("img")?.src || null;
      const poster = document.querySelector("video")?.poster || null;

      return {
        title,
        thumbnail: ogImage || poster || firstImg || null
      };
    });

    res.json({ url, ...data });
  } catch (err) {
    console.error("Scrape error:", err);
    res.json({ url, title: null, thumbnail: null });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));