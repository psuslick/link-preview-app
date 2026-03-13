import { execFile } from "child_process";
import path from "path";
import fs from "fs";

export async function screenshotPortable(url) {
  return new Promise((resolve) => {
    const chrome = path.join(process.cwd(), "browser", "chrome.exe");
    const out = path.join(process.cwd(), "page.png");

    execFile(chrome, [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      `--screenshot=${out}`,
      url
    ], (err) => {
      if (err) return resolve(null);

      const data = fs.readFileSync(out).toString("base64");
      fs.unlinkSync(out);
      resolve(`data:image/png;base64,${data}`);
    });
  });
}