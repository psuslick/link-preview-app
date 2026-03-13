import { execFile } from "child_process";
import path from "path";
import fs from "fs";

export async function extractVideoFrame(url) {
  return new Promise((resolve) => {
    const ffmpeg = path.join(process.cwd(), "ffmpeg", "ffmpeg.exe");
    const out = path.join(process.cwd(), "thumb.png");

    execFile(ffmpeg, [
      "-ss", "00:00:01",
      "-i", url,
      "-frames:v", "1",
      out
    ], (err) => {
      if (err) return resolve(null);

      const data = fs.readFileSync(out).toString("base64");
      fs.unlinkSync(out);
      resolve(`data:image/png;base64,${data}`);
    });
  });
}