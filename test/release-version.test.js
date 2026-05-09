"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveReleaseVersion,
} = require("../scripts/resolve-release-version.js");

test("resolves RC versions from a release branch", () => {
  const version = resolveReleaseVersion({
    mode: "rc",
    refName: "release/v1.2.3",
    sha: "abcdef1234567890",
    runNumber: "42",
  });

  assert.deepEqual(version, {
    baseVersion: "1.2.3",
    npmVersion: "1.2.3-rc.42.gabcdef12",
    tagName: "v1.2.3-rc.42",
    releaseTag: "v1.2.3",
    npmTag: "rc",
    shortSha: "abcdef12",
  });
});

test("resolves final versions from a release branch without v prefix", () => {
  const version = resolveReleaseVersion({
    mode: "release",
    refName: "release/1.2.3",
    sha: "1234567890abcdef",
    runNumber: "7",
  });

  assert.deepEqual(version, {
    baseVersion: "1.2.3",
    npmVersion: "1.2.3",
    tagName: "v1.2.3",
    releaseTag: "v1.2.3",
    npmTag: "latest",
    shortSha: "12345678",
  });
});

test("rejects non-release branches", () => {
  assert.throws(
    () =>
      resolveReleaseVersion({
        mode: "rc",
        refName: "main",
        sha: "abcdef1234567890",
        runNumber: "42",
      }),
    /release\/<version>/
  );
});
