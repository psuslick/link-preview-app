import express from "express";
import { captureVideoScreenshot } from "../utils/captureVideo.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { url } = req.body;
    const screenshot = await captureVideoScreenshot(url);

    res.json({
      success: true,
      url,
      screenshot: `data:image/png;base64,${screenshot}`
    });
  } catch (err) {
    console.error("Screenshot error:", err.message);
    res.json({ success: false, error: "Unable to capture screenshot" });
  }
});

export default router;