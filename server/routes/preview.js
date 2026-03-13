import express from "express";
import { hybridPreview } from "../utils/hybridEngine.js";

const router = express.Router();

router.post("/", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.json({ type: "none", thumbnail: null });
  }

  const result = await hybridPreview(url);
  res.json(result);
});

export default router;