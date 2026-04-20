"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { auditWorkflowFile, fixWorkflowFile, parseRunnerLabels, shouldFail } = require("../src/index.js");
const { parseOwnerFromRemote } = require("../bin/fork-friendly-actions.js");

function audit(source) {
  return auditWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source,
    cwd: "/repo",
    allowList: new Set(),
  });
}

test("parses inline runner arrays", () => {
  assert.deepEqual(parseRunnerLabels("[self-hosted, Linux, ARM64]"), ["self-hosted", "Linux", "ARM64"]);
});

test("flags private runner labels without an owner guard", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  benchmark:
    runs-on: benchmark
    steps:
      - run: npm test
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /benchmark/);
});

test("allows Chia-style dynamic owner runner fallback", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  benchmark:
    runs-on: \${{ github.repository_owner == 'Chia-Network' && 'benchmark' || 'ubuntu-latest' }}
    steps:
      - run: npm test
`);

  assert.deepEqual(findings, []);
});

test("allows private runners on owner-gated jobs", () => {
  const findings = audit(`
name: Release
on: push
jobs:
  start_release:
    if: github.repository_owner == 'Chia-Network'
    runs-on: [glue-notify]
    steps:
      - run: ./start-release.sh
`);

  assert.deepEqual(findings, []);
});

test("flags block-style private runner arrays", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  arm:
    runs-on:
      - self-hosted
      - Linux
      - ARM64
    steps:
      - run: npm test
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /self-hosted/);
  assert.match(findings[0].message, /Linux/);
  assert.match(findings[0].message, /ARM64/);
});

test("warns when normal secrets are not owner-gated", () => {
  const findings = audit(`
name: Publish
on: pull_request
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: twine upload dist/*
        env:
          TWINE_PASSWORD: \${{ secrets.PYPI_TOKEN }}
`);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, "warning");
  assert.equal(findings[0].title, "Publish or deploy step is not owner-gated");
  assert.equal(findings[1].title, "Secret usage is not owner-gated");
});

test("ignores GITHUB_TOKEN secret compatibility", () => {
  const findings = audit(`
name: Label
on: pull_request
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - run: gh pr edit --add-label ci
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`);

  assert.deepEqual(findings, []);
});

test("fail-on warning includes both warnings and errors", () => {
  assert.equal(shouldFail([{ severity: "warning" }], "warning"), true);
  assert.equal(shouldFail([{ severity: "warning" }], "error"), false);
  assert.equal(shouldFail([{ severity: "error" }], "error"), true);
  assert.equal(shouldFail([{ severity: "error" }], "none"), false);
});

test("fixes scalar private runners with an owner-gated public fallback", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  benchmark:
    runs-on: benchmark
    steps:
      - run: npm test
`,
    cwd: "/repo",
    upstreamOwner: "ExampleOrg",
  });

  assert.match(result.fixedSource, /runs-on: \$\{\{ github\.repository_owner == 'ExampleOrg' && 'benchmark' \|\| 'ubuntu-latest' \}\}/);
  assert.equal(result.changes.length, 1);
});

test("fixes publish and secret steps with one step-level owner guard", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/publish.yml",
    source: `
name: Publish
on: pull_request
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: twine upload dist/*
        env:
          TWINE_PASSWORD: \${{ secrets.PYPI_TOKEN }}
`,
    cwd: "/repo",
    upstreamOwner: "ExampleOrg",
  });

  assert.match(result.fixedSource, /- run: twine upload dist\/\*\n        if: github\.repository_owner == 'ExampleOrg'\n        env:/);
  assert.equal(result.changes.length, 1);
});

test("fixes block-style private runner arrays with fromJSON", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  arm:
    runs-on:
      - self-hosted
      - Linux
      - ARM64
    steps:
      - run: npm test
`,
    cwd: "/repo",
    upstreamOwner: "ExampleOrg",
  });

  assert.match(result.fixedSource, /runs-on: \$\{\{ github\.repository_owner == 'ExampleOrg' && fromJSON\('\["self-hosted","Linux","ARM64"\]'\) \|\| fromJSON\('\["ubuntu-latest"\]'\) \}\}/);
  assert.doesNotMatch(result.fixedSource, /- self-hosted/);
});

test("parses GitHub remote owners", () => {
  assert.equal(parseOwnerFromRemote("git@github.com:wallentx/fork-friendly-actions.git"), "wallentx");
  assert.equal(parseOwnerFromRemote("https://github.com/Chia-Network/chia-blockchain.git"), "Chia-Network");
});
