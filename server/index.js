import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const USER_AGENT = process.env.USER_AGENT;

app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent": USER_AGENT
      }
    });

    const $ = cheerio.load(html);

    const thumbnail =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      $('meta[property="og:image:url"]').attr("content") ||
      $('meta[property="og:image:secure_url"]').attr("content") ||
      $("video").attr("poster") ||
      null;

    const title =
      $('meta[property="og:title"]').attr("content") ||
      $("title").text() ||
      null;

    res.json({ url, title, thumbnail });
  } catch (err) {
    res.json({ url, title: null, thumbnail: null });
  }
});

app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));