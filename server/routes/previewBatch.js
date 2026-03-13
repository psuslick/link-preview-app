import express from "express";
import { hybridPreview } from "../utils/hybridEngine.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const { urls } = req.body;

  if (!Array.isArray(urls)) {
    return res.json({ results: [] });
  }

  const results = [];

  for (const url of urls) {
    const result = await hybridPreview(url);
    results.push({ url, ...result });
  }

  res.json({ results });
});

export default router;