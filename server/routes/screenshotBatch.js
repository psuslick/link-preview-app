import express from "express";
import pLimit from "p-limit";
import { captureVideoScreenshot } from "../utils/captureVideo.js";

const router = express.Router();

// Limit concurrency to avoid Playwright overload
const limit = pLimit(3);

router.post("/", async (req, res) => {
  try {
    const { urls } = req.body;

    if (!Array.isArray(urls)) {
      return res.json({ success: false, error: "urls must be an array" });
    }

    const tasks = urls.map((url) =>
      limit(async () => {
        try {
          const screenshot = await captureVideoScreenshot(url);
          return { url, screenshot: `data:image/png;base64,${screenshot}` };
        } catch {
          return { url, screenshot: null };
        }
      })
    );

    const results = await Promise.all(tasks);

    res.json({ success: true, results });
  } catch (err) {
    console.error("Batch screenshot error:", err.message);
    res.json({ success: false, error: "Batch processing failed" });
  }
});

export default router;