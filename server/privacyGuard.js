import fs from "fs";
import path from "path";

const repoRoot = process.cwd();

// Wrap writeFile
const originalWriteFile = fs.writeFile;
fs.writeFile = function (filePath, ...rest) {
  if (filePath.startsWith(repoRoot)) {
    throw new Error(`Disk write blocked: ${filePath}`);
  }
  return originalWriteFile.call(fs, filePath, ...rest);
};

// Wrap writeFileSync
const originalWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function (filePath, ...rest) {
  if (filePath.startsWith(repoRoot)) {
    throw new Error(`Disk write blocked: ${filePath}`);
  }
  return originalWriteFileSync.call(fs, filePath, ...rest);
};

// Wrap appendFile
const originalAppendFile = fs.appendFile;
fs.appendFile = function (filePath, ...rest) {
  if (filePath.startsWith(repoRoot)) {
    throw new Error(`Disk write blocked: ${filePath}`);
  }
  return originalAppendFile.call(fs, filePath, ...rest);
};

console.log("PrivacyGuard active: Disk writes inside repo are blocked.");