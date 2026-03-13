import { chromium } from "playwright";

export async function captureVideoScreenshot(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });

  // Wait for a video element
  const video = await page.waitForSelector("video", { timeout: 8000 });

  // Seek to 1 second
  await page.evaluate(() => {
    const v = document.querySelector("video");
    v.currentTime = 1;
  });

  await page.waitForTimeout(500);

  // Screenshot video element directly into memory
  const buffer = await video.screenshot();

  await browser.close();

  return buffer.toString("base64");
}