import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/scrape", async (req, res) => {
  const { url } = req.body;

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
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

    res.json({
      url,
      title,
      thumbnail
    });
  } catch (err) {
    res.json({
      url,
      title: null,
      thumbnail: null
    });
  }
});

app.listen(4000, () => console.log("Scraper running on port 4000"));
