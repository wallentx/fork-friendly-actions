#!/usr/bin/env node

"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const bundledDataDir = path.join(repoRoot, "dist", "data");

childProcess.execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["ncc", "build", "src/action.js", "--out", "dist/action", "--license", "licenses.txt"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  }
);

fs.mkdirSync(bundledDataDir, { recursive: true });
fs.copyFileSync(
  path.join(repoRoot, "data", "public-github-hosted-runners.txt"),
  path.join(bundledDataDir, "public-github-hosted-runners.txt")
);
