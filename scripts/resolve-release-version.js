#!/usr/bin/env node

"use strict";

const fs = require("node:fs");

function resolveReleaseVersion({ mode, refName, sha, runNumber }) {
  const normalizedMode = String(mode || "").trim();
  if (!["rc", "release"].includes(normalizedMode)) {
    throw new Error("mode must be rc or release.");
  }

  const branchMatch = String(refName || "").trim().match(/^release\/v?([0-9]+\.[0-9]+\.[0-9]+)$/);
  if (!branchMatch) {
    throw new Error("ref-name must match release/<version> or release/v<version>.");
  }

  const baseVersion = branchMatch[1];
  const shortSha = String(sha || "").trim().slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(shortSha)) {
    throw new Error("sha must contain at least eight hexadecimal characters.");
  }

  const releaseTag = `v${baseVersion}`;
  if (normalizedMode === "release") {
    return {
      baseVersion,
      npmVersion: baseVersion,
      tagName: releaseTag,
      releaseTag,
      npmTag: "latest",
      shortSha,
    };
  }

  const normalizedRunNumber = String(runNumber || "").trim();
  if (!/^[0-9]+$/.test(normalizedRunNumber)) {
    throw new Error("run-number must be a positive integer for rc mode.");
  }

  return {
    baseVersion,
    npmVersion: `${baseVersion}-rc.${normalizedRunNumber}.g${shortSha}`,
    tagName: `${releaseTag}-rc.${normalizedRunNumber}`,
    releaseTag,
    npmTag: "rc",
    shortSha,
  };
}

function parseArgs(argv) {
  const parsed = {};
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--mode":
        parsed.mode = requireValue(args, (index += 1), arg);
        break;
      case "--ref-name":
        parsed.refName = requireValue(args, (index += 1), arg);
        break;
      case "--sha":
        parsed.sha = requireValue(args, (index += 1), arg);
        break;
      case "--run-number":
        parsed.runNumber = requireValue(args, (index += 1), arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function writeOutputs(version, outputPath = process.env.GITHUB_OUTPUT) {
  for (const [name, value] of Object.entries({
    "base-version": version.baseVersion,
    "npm-version": version.npmVersion,
    "tag-name": version.tagName,
    "release-tag": version.releaseTag,
    "npm-tag": version.npmTag,
    "short-sha": version.shortSha,
  })) {
    console.log(`${name}=${value}`);
    if (outputPath) {
      fs.appendFileSync(outputPath, `${name}=${value}\n`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const version = resolveReleaseVersion(parseArgs(argv));
  writeOutputs(version);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  resolveReleaseVersion,
};
