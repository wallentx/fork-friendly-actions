"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_PUBLIC_RUNNERS_FILE,
  RULES,
  auditWorkflowFile,
  buildUpstreamGuardExpression,
  fixWorkflows,
  fixWorkflowFile,
  loadPublicGithubHostedRunners,
  normalizeUpstreamScope,
  ownerFromRepoSlug,
  parseRunnerLabels,
  shouldFail,
} = require("../src/index.js");
const {
  detectRepoSlugFromGit,
  buildInteractiveBuffer,
  main,
  parseInteractiveAction,
  parseArgs,
  parseInteractiveChoice,
  parseOwnerFromRemote,
  parseRepoSlugFromRemote,
  readInteractiveChoice,
  runInteractiveFix,
} = require("../bin/fork-friendly-actions.js");

function audit(source) {
  return auditWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source,
    cwd: "/repo",
    allowList: new Set(),
  });
}

function runCli(args, env = {}) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalEnv = { ...process.env };
  const stdout = [];
  const stderr = [];

  console.log = (...parts) => stdout.push(parts.join(" "));
  console.error = (...parts) => stderr.push(parts.join(" "));
  Object.assign(process.env, env);

  try {
    const status = main(args);
    return {
      status,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  }
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
  assert.equal(findings[0].ruleCode, RULES.RUNNER_LABEL.code);
  assert.equal(findings[0].rule, RULES.RUNNER_LABEL.slug);
  assert.deepEqual(findings[0].location, { line: 6, column: 5, length: 7 });
  assert.match(findings[0].message, /benchmark/);
});

test("loads the committed public GitHub-hosted runner list", () => {
  const runners = loadPublicGithubHostedRunners();
  assert.equal(runners.has("ubuntu-latest"), true);
  assert.equal(runners.has("ubuntu-slim"), true);
  assert.equal(runners.has("windows-11-arm"), true);
  assert.equal(runners.has("windows-2025-vs2026"), true);
  assert.equal(runners.has("macos-26-intel"), true);
});

test("runner list file is sorted and deduplicated", () => {
  const lines = fs
    .readFileSync(DEFAULT_PUBLIC_RUNNERS_FILE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  assert.deepEqual(lines, [...new Set(lines)]);
  assert.deepEqual(lines, [...lines].sort());
});

test("treats documented public GitHub-hosted runners as public", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  linux:
    runs-on: ubuntu-slim
    steps:
      - run: npm test
  windows:
    runs-on: windows-11-arm
    steps:
      - run: npm test
  macos:
    runs-on: macos-26-intel
    steps:
      - run: npm test
`);

  assert.deepEqual(findings, []);
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

test("flags snapshot jobs without an owner guard", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  image:
    runs-on: ubuntu-latest
    snapshot:
      image-name: custom-runner
    steps:
      - run: echo build
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.SNAPSHOT_GATE.code);
  assert.equal(findings[0].line, 7);
});

test("propagates upstream-only gating through needs dependencies", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  image:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo build
  test:
    needs: image
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].ruleCode, RULES.RUNNER_LABEL.code);
  assert.equal(findings[1].ruleCode, RULES.NEEDS_GATE.code);
  assert.equal(findings[1].line, 10);
});

test("flags reusable workflow caller secrets while allowing GITHUB_TOKEN", () => {
  const findings = audit(`
name: Reuse
on: pull_request
jobs:
  unsafe:
    uses: owner/repo/.github/workflows/reusable.yml@v1
    secrets:
      access-token: \${{ secrets.PERSONAL_ACCESS_TOKEN }}
  safe:
    uses: owner/repo/.github/workflows/reusable.yml@v1
    secrets:
      token: \${{ secrets.GITHUB_TOKEN }}
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.SECRET_GATE.code);
  assert.match(findings[0].message, /reusable-workflow caller passes secrets\.PERSONAL_ACCESS_TOKEN/);
  assert.equal(findings[0].location.line, 7);
});

test("flags inherited reusable workflow secrets", () => {
  const findings = audit(`
name: Reuse
on: pull_request
jobs:
  unsafe:
    uses: owner/repo/.github/workflows/reusable.yml@v1
    secrets: inherit
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.SECRET_GATE.code);
  assert.match(findings[0].message, /inherits all caller secrets/);
});

test("allows dynamic runners on owner-gated jobs", () => {
  const findings = audit(`
name: Release
on: push
jobs:
  start_release:
    if: github.repository_owner == 'Chia-Network'
    runs-on: \${{ matrix.runner }}
    steps:
      - run: ./start-release.sh
`);

  assert.deepEqual(findings, []);
});

test("allows dynamic matrix runners when all resolved values are public", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        runner:
          - ubuntu-24.04
          - macos-15
    runs-on: \${{ matrix.os || matrix.runner }}
    steps:
      - run: npm test
`);

  assert.deepEqual(findings, []);
});

test("flags dynamic matrix runners when any resolved value is private", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        runner:
          - benchmark
          - ubuntu-latest
    runs-on: \${{ matrix.runner }}
    steps:
      - run: npm test
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.RUNNER_EXPRESSION.code);
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

test("flags runs-on groups as upstream-only", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  gated:
    runs-on:
      group: ubuntu-runners
      labels: ubuntu-24.04-16core
    steps:
      - run: npm test
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.RUNNER_LABEL.code);
  assert.match(findings[0].message, /Runner group ubuntu-runners requires private runner access/);
});

test("flags inline runs-on objects with private runner groups", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  gated:
    runs-on: { group: ubuntu-runners, labels: [ubuntu-24.04-16core] }
    steps:
      - run: npm test
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.RUNNER_LABEL.code);
  assert.match(findings[0].message, /Runner group ubuntu-runners requires private runner access/);
});

test("fixes self-hosted runner arrays by skipping the job on forks", () => {
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
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(result.fixedSource, /arm:\n    if: github\.repository == 'ExampleOrg\/example-repo'\n    runs-on:/);
  assert.match(result.fixedSource, /- self-hosted/);
  assert.equal(result.changes.length, 1);
});

test("fixes runs-on groups by skipping the job on forks", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  gated:
    runs-on:
      group: ubuntu-runners
      labels: ubuntu-24.04-16core
    steps:
      - run: npm test
`,
    cwd: "/repo",
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(result.fixedSource, /gated:\n    if: github\.repository == 'ExampleOrg\/example-repo'\n    runs-on:/);
  assert.match(result.fixedSource, /group: ubuntu-runners/);
  assert.match(result.fixedSource, /labels: ubuntu-24\.04-16core/);
  assert.equal(result.changes.length, 1);
});

test("fixes paid macOS runners with a same-family free fallback", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  build:
    runs-on: macos-latest-large
    steps:
      - run: npm test
`,
    cwd: "/repo",
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(result.fixedSource, /runs-on: \$\{\{ github\.repository == 'ExampleOrg\/example-repo' && 'macos-latest-large' \|\| 'macos-latest' \}\}/);
  assert.equal(result.changes.length, 1);
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
  assert.deepEqual(findings.map((finding) => finding.severity), ["warning", "warning"]);
  assert.deepEqual(
    [...findings.map((finding) => finding.ruleCode)].sort(),
    [RULES.PUBLISH_GATE.code, RULES.SECRET_GATE.code].sort()
  );
  assert.equal(findings.find((finding) => finding.ruleCode === RULES.PUBLISH_GATE.code)?.title, "Publish, deploy, or auth step is not upstream-gated");
  assert.equal(findings.find((finding) => finding.ruleCode === RULES.PUBLISH_GATE.code)?.fixable, false);
  assert.equal(findings.find((finding) => finding.ruleCode === RULES.SECRET_GATE.code)?.title, "Secret usage is not owner-gated");
  assert.equal(findings.find((finding) => finding.ruleCode === RULES.SECRET_GATE.code)?.fixable, false);
});

test("collapses multiple secret references in one step into one finding", () => {
  const findings = audit(`
name: Sign
on: pull_request
jobs:
  sign:
    runs-on: ubuntu-latest
    steps:
      - uses: example/sign@v1
        with:
          app-id: \${{ secrets.APP_ID }}
          private-key: \${{ secrets.PRIVATE_KEY }}
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.SECRET_GATE.code);
  assert.match(findings[0].message, /secrets\.APP_ID/);
  assert.match(findings[0].message, /secrets\.PRIVATE_KEY/);
});

test("check mode marks publish and secret findings fixable when an owner guard can be inserted", () => {
  const findings = auditWorkflowFile({
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
    allowList: new Set(),
  });

  assert.equal(findings.length, 2);
  assert.equal(findings.find((finding) => finding.ruleCode === RULES.PUBLISH_GATE.code)?.fixable, true);
  assert.equal(findings.find((finding) => finding.ruleCode === RULES.SECRET_GATE.code)?.fixable, true);
});

test("does not flag release read commands or publish keywords in step names", () => {
  const findings = audit(`
name: Release
on: pull_request
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Determine npm publish settings
        run: echo "not publishing yet"
      - name: Check release
        run: |
          gh release view "$TAG"
          gh release download "$TAG"
`);

  assert.deepEqual(findings, []);
});

test("does not treat steps.*.outputs as secrets", () => {
  const findings = audit(`
name: Build
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: check_secrets
        run: echo "has_win_cert=false" >> "$GITHUB_OUTPUT"
      - name: Setup Windows Certificate
        if: "steps.check_secrets.outputs.has_win_cert == 'true'"
        run: echo "setup"
`);

  assert.deepEqual(findings, []);
});

test("flags step output consumers when the producer is upstream-gated", () => {
  const findings = audit(`
name: Build
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: auth
        if: github.repository == 'ExampleOrg/example-repo'
        run: echo "token=abc" >> "$GITHUB_OUTPUT"
      - name: Use token
        run: echo "\${{ steps.auth.outputs.token }}"
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.OUTPUT_GATE.code);
  assert.match(findings[0].message, /reads outputs from auth/);
  assert.equal(findings[0].location.line, 12);
});

test("flags reusable workflow outputs that depend on upstream-only jobs", () => {
  const findings = audit(`
name: Reusable
on:
  workflow_call:
    outputs:
      token:
        value: \${{ jobs.build.outputs.token }}
jobs:
  build:
    if: github.repository == 'ExampleOrg/example-repo'
    runs-on: ubuntu-latest
    outputs:
      token: \${{ steps.auth.outputs.token }}
    steps:
      - id: auth
        run: echo "token=abc" >> "$GITHUB_OUTPUT"
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.OUTPUT_GATE.code);
  assert.match(findings[0].message, /Reusable workflow output token depends on build/);
  assert.equal(findings[0].fixable, false);
});

test("flags release write commands and cloud auth actions", () => {
  const findings = auditWorkflowFile({
    filePath: "/repo/.github/workflows/release.yml",
    source: `
name: Release
on: pull_request
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Create release
        run: gh release create "$TAG"
      - uses: google-github-actions/auth@v2
`,
    cwd: "/repo",
    upstreamOwner: "ExampleOrg",
    allowList: new Set(),
  });

  assert.equal(findings.length, 2);
  assert.equal(findings[0].ruleCode, RULES.PUBLISH_GATE.code);
  assert.equal(findings[0].line, 9);
  assert.equal(findings[1].ruleCode, RULES.PUBLISH_GATE.code);
  assert.equal(findings[1].line, 10);
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

test("fixes scalar private runners with a repo-gated public fallback when upstream repo is known", () => {
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
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(result.fixedSource, /runs-on: \$\{\{ github\.repository == 'ExampleOrg\/example-repo' && 'benchmark' \|\| 'ubuntu-latest' \}\}/);
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

test("fixes publish and secret steps with repo-level guard when upstream repo is known", () => {
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
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(result.fixedSource, /- run: twine upload dist\/\*\n        if: github\.repository == 'ExampleOrg\/example-repo'\n        env:/);
  assert.equal(result.changes.length, 1);
});

test("fixes snapshot jobs with a job-level upstream guard", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/image.yml",
    source: `
name: Image
on: pull_request
jobs:
  image:
    runs-on: ubuntu-latest
    snapshot:
      image-name: custom-runner
    steps:
      - run: echo build
`,
    cwd: "/repo",
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(result.fixedSource, /image:\n    if: github\.repository == 'ExampleOrg\/example-repo'\n    runs-on: ubuntu-latest/);
  assert.equal(result.changes.length, 1);
});

test("fixes dependent jobs when an upstream-only prerequisite is skipped on forks", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  image:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo build
  test:
    needs: image
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`,
    cwd: "/repo",
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(result.fixedSource, /image:\n    if: github\.repository == 'ExampleOrg\/example-repo'\n    runs-on: \[self-hosted, linux\]/);
  assert.match(result.fixedSource, /test:\n    if: github\.repository == 'ExampleOrg\/example-repo'\n    needs: image/);
  assert.equal(result.changes.length, 2);
});

test("fixes job outputs that depend on upstream-only step outputs with a job guard", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/reusable.yml",
    source: `
name: Reusable
on:
  workflow_call:
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      token: \${{ steps.auth.outputs.token }}
    steps:
      - id: auth
        if: github.repository == 'ExampleOrg/example-repo'
        run: echo "token=abc" >> "$GITHUB_OUTPUT"
`,
    cwd: "/repo",
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(result.fixedSource, /build:\n    if: github\.repository == 'ExampleOrg\/example-repo'\n    runs-on: ubuntu-latest/);
  assert.equal(result.findings[0].ruleCode, RULES.OUTPUT_GATE.code);
});

test("fixes block-style self-hosted runner arrays with an owner-gated job skip", () => {
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

  assert.match(result.fixedSource, /arm:\n    if: github\.repository_owner == 'ExampleOrg'\n    runs-on:/);
  assert.match(result.fixedSource, /- self-hosted/);
});

test("fixes dynamic runner expressions with an owner-gated public fallback", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  test:
    runs-on: \${{ matrix.runs_on || matrix.runner }}
    steps:
      - run: npm test
`,
    cwd: "/repo",
    upstreamOwner: "ExampleOrg",
  });

  assert.match(result.fixedSource, /runs-on: \$\{\{ github\.repository_owner == 'ExampleOrg' && \(matrix\.runs_on \|\| matrix\.runner\) \|\| 'ubuntu-latest' \}\}/);
  assert.equal(result.changes.length, 1);
  assert.equal(result.findings[0].fixable, true);
  assert.equal(result.findings[0].ruleCode, RULES.RUNNER_EXPRESSION.code);
});

test("fixes matrix object-or-runner expressions with a row-wise scalar fallback", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        include:
          - runner: ubuntu-24.04
          - runner: windows-x64
            runs_on:
              group: codex-runners
              labels: codex-windows-x64
    runs-on: \${{ matrix.runs_on || matrix.runner }}
    steps:
      - run: npm test
`,
    cwd: "/repo",
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(
    result.fixedSource,
    /runs-on: \$\{\{ github\.repository == 'ExampleOrg\/example-repo' && \(matrix\.runs_on \|\| matrix\.runner\) \|\| \(matrix\.runner == 'windows-x64' && 'windows-latest' \|\| matrix\.runner\) \}\}/
  );
});

test("fixes single matrix runner expressions with value-aware fallback mapping", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        os:
          - ubuntu-24.04
          - macos-15-xlarge
    runs-on: \${{ matrix.os }}
    steps:
      - run: npm test
`,
    cwd: "/repo",
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(
    result.fixedSource,
    /runs-on: \$\{\{ github\.repository == 'ExampleOrg\/example-repo' && \(matrix\.os\) \|\| \(matrix\.os == 'macos-15-xlarge' && 'macos-latest' \|\| matrix\.os\) \}\}/
  );
});

test("allows nested matrix object property runner expressions when all resolved values are public", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        os:
          - runs-on: ubuntu-latest
          - runs-on: ubuntu-24.04-arm
    runs-on: \${{ matrix.os.runs-on }}
    steps:
      - run: npm test
`);

  assert.deepEqual(findings, []);
});

test("allows nested indexed matrix runner expressions when all resolved values are public", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        os:
          - runs-on:
              intel: ubuntu-latest
              arm: ubuntu-24.04-arm
          - runs-on:
              intel: macos-15-intel
              arm: macos-15
        arch:
          - matrix: intel
          - matrix: arm
    runs-on: \${{ matrix.os.runs-on[matrix.arch.matrix] }}
    steps:
      - run: npm test
`);

  assert.deepEqual(findings, []);
});

test("allows indexed matrix runner expressions when missing branches are excluded", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        os:
          - name: Linux
            matrix: linux
            runs-on:
              intel: ubuntu-latest
              arm: ubuntu-24.04-arm
          - name: Windows
            matrix: windows
            runs-on:
              intel: windows-latest
        arch:
          - matrix: intel
          - matrix: arm
        exclude:
          - os:
              matrix: windows
            arch:
              matrix: arm
    runs-on: \${{ matrix.os.runs-on[matrix.arch.matrix] }}
    steps:
      - run: npm test
`);

  assert.deepEqual(findings, []);
});

test("allows indexed matrix runner expressions when nested runner values use bracket arrays", () => {
  const findings = audit(`
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        os:
          - runs-on:
              arm: [ubuntu-24.04-arm]
              intel: [ubuntu-latest]
        arch:
          - matrix: arm
          - matrix: intel
    runs-on: \${{ matrix.os.runs-on[matrix.arch.matrix] }}
    steps:
      - run: npm test
`);

  assert.deepEqual(findings, []);
});

test("fixes nested matrix object property runner expressions with value-aware fallback mapping", () => {
  const result = fixWorkflowFile({
    filePath: "/repo/.github/workflows/ci.yml",
    source: `
name: CI
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        os:
          - runs-on: ubuntu-latest
          - runs-on: macos-15-xlarge
    runs-on: \${{ matrix.os.runs-on }}
    steps:
      - run: npm test
`,
    cwd: "/repo",
    upstreamRepo: "ExampleOrg/example-repo",
  });

  assert.match(
    result.fixedSource,
    /runs-on: \$\{\{ github\.repository == 'ExampleOrg\/example-repo' && \(matrix\.os\.runs-on\) \|\| \(matrix\.os\.runs-on == 'macos-15-xlarge' && 'macos-latest' \|\| matrix\.os\.runs-on\) \}\}/
  );
});

test("parses GitHub remote owners", () => {
  assert.equal(parseOwnerFromRemote("git@github.com:wallentx/fork-friendly-actions.git"), "wallentx");
  assert.equal(parseOwnerFromRemote("https://github.com/Chia-Network/chia-blockchain.git"), "Chia-Network");
});

test("parses GitHub remote repository slugs", () => {
  assert.equal(parseRepoSlugFromRemote("git@github.com:wallentx/fork-friendly-actions.git"), "wallentx/fork-friendly-actions");
  assert.equal(parseRepoSlugFromRemote("https://github.com/Chia-Network/chia-blockchain.git"), "Chia-Network/chia-blockchain");
});

test("detects upstream repo slug before origin by default", () => {
  const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-ffactions-git-"));
  try {
    childProcess.execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    childProcess.execFileSync("git", ["remote", "add", "origin", "https://github.com/fork-user/example-repo.git"], {
      cwd: tmpDir,
      stdio: "ignore",
    });
    childProcess.execFileSync("git", ["remote", "add", "upstream", "git@github.com:ExampleOrg/example-repo.git"], {
      cwd: tmpDir,
      stdio: "ignore",
    });

    assert.equal(detectRepoSlugFromGit(tmpDir), "ExampleOrg/example-repo");

    childProcess.execFileSync("git", ["remote", "remove", "upstream"], { cwd: tmpDir, stdio: "ignore" });
    assert.equal(detectRepoSlugFromGit(tmpDir), "fork-user/example-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("derives owner and guard expressions from upstream repo scope", () => {
  assert.equal(ownerFromRepoSlug("Chia-Network/chia-blockchain"), "Chia-Network");
  assert.deepEqual(normalizeUpstreamScope({ upstreamRepo: "Chia-Network/chia-blockchain" }), {
    upstreamRepo: "Chia-Network/chia-blockchain",
    upstreamOwner: "Chia-Network",
    guardExpression: "github.repository == 'Chia-Network/chia-blockchain'",
  });
  assert.equal(
    buildUpstreamGuardExpression({ upstreamRepo: "", upstreamOwner: "Chia-Network" }),
    "github.repository_owner == 'Chia-Network'"
  );
});

test("parses short aliases and positional path", () => {
  assert.equal(parseArgs(["--fix"]).fix, true);
  assert.equal(parseArgs(["-f"]).fix, true);
  assert.equal(parseArgs(["--interactive"]).interactive, true);
  assert.equal(parseArgs(["-i"]).interactive, true);
  assert.equal(parseArgs(["-r", "openai/codex"]).upstreamRepo, "openai/codex");
  assert.equal(parseArgs(["-w", "some/path"]).workflows, "some/path");
  assert.equal(parseArgs(["-d"]).dryRun, true);
  assert.equal(parseArgs(["-a", "runner1"]).allowRunners, "runner1");
  assert.equal(parseArgs(["-o", "Org"]).upstreamOwner, "Org");
  assert.equal(parseArgs(["-R", "fallback"]).runnerFallback, "fallback");
  assert.equal(parseArgs(["-l", "none"]).failOn, "none");
  assert.equal(parseArgs(["my/path"]).cwd, "my/path");
  assert.equal(parseArgs(["-f", "my/path"]).cwd, "my/path");
  assert.throws(() => parseArgs(["-i", "-d"]), /cannot be combined/);
});

test("parses interactive keypress choices", () => {
  assert.equal(parseInteractiveChoice("y"), "apply");
  assert.equal(parseInteractiveChoice("Y"), "apply");
  assert.equal(parseInteractiveChoice("n"), "skip");
  assert.equal(parseInteractiveChoice("q"), "quit");
  assert.equal(parseInteractiveChoice("\u001b"), "quit");
  assert.equal(parseInteractiveChoice("\u0003"), "quit");
  assert.equal(parseInteractiveChoice("x"), "");
});

test("parses interactive reviewer navigation keys", () => {
  assert.equal(parseInteractiveAction("j"), "scroll-down");
  assert.equal(parseInteractiveAction("k"), "scroll-up");
  assert.equal(parseInteractiveAction("\u001b[B"), "scroll-down");
  assert.equal(parseInteractiveAction("\u001b[A"), "scroll-up");
  assert.equal(parseInteractiveAction("\u001b[6~"), "page-down");
  assert.equal(parseInteractiveAction("\u001b[5~"), "page-up");
});

test("interactive choice reader retries EAGAIN reads", () => {
  let attempts = 0;
  const sleeps = [];

  const choice = readInteractiveChoice({
    stdin: {
      fd: 0,
      isTTY: true,
      isRaw: false,
      setRawMode() {},
      resume() {},
      pause() {},
    },
    stdout: { write() {} },
    readSync(_fd, buffer) {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("resource temporarily unavailable");
        error.code = "EAGAIN";
        throw error;
      }
      buffer.write("y", 0, "utf8");
      return 1;
    },
    sleep(durationMs) {
      sleeps.push(durationMs);
    },
  });

  assert.equal(choice, "apply");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [10]);
});

test("builds interactive buffers with inline selected diff lines", () => {
  const preview = buildInteractiveBuffer(
    ["name: CI", "jobs:", "  test:", "    runs-on: benchmark", "    steps:"],
    {
      start: 3,
      end: 4,
      replacement: ["    runs-on: ${{ github.repository_owner == 'ExampleOrg' && 'benchmark' || 'ubuntu-latest' }}"],
    }
  );

  assert.equal(preview.selectedStart, 3);
  assert.equal(preview.selectedEnd, 4);
  assert.deepEqual(
    preview.lines.slice(3, 5).map((line) => ({ type: line.type, selected: line.selected, marker: line.marker })),
    [
      { type: "delete", selected: true, marker: "-" },
      { type: "add", selected: true, marker: "+" },
    ]
  );
});

test("rule codes use stable FFxxx identifiers", () => {
  assert.deepEqual(
    Object.values(RULES).map((rule) => rule.code),
    ["FF001", "FF002", "FF003", "FF004", "FF005", "FF006", "FF007"]
  );
});

test("default CLI mode is check and does not rewrite files", () => {
  const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-ffactions-"));
  const workflowsDir = path.join(tmpDir, ".github", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  const workflowPath = path.join(workflowsDir, "ci.yml");
  const original = `name: CI
on: pull_request
jobs:
  benchmark:
    runs-on: benchmark
    steps:
      - run: npm test
`;
  fs.writeFileSync(workflowPath, original);

  const result = runCli([tmpDir, "-o", "ExampleOrg"], { NO_COLOR: "1" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FF001 runner-label: Private runner is not fork-friendly/);
  assert.match(result.stdout, /\.github\/workflows\/ci\.yml \(1 finding\)/);
  assert.match(result.stdout, /- (?:✅|⚠️) \.github\/workflows\/ci\.yml:5:5 \(runner label: benchmark\)/);
  assert.match(result.stdout, /4 \|   benchmark:/);
  assert.match(result.stdout, /5 \|     runs-on: benchmark/);
  assert.match(result.stdout, /6 \|     steps:/);
  assert.equal(fs.readFileSync(workflowPath, "utf8"), original);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CLI labels inherited reusable workflow secrets as secrets: inherit", () => {
  const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-ffactions-inherit-"));
  const workflowsDir = path.join(tmpDir, ".github", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, "reuse.yml"),
    `name: Reuse
on: pull_request
jobs:
  unsafe:
    uses: owner/repo/.github/workflows/reusable.yml@v1
    secrets: inherit
`
  );

  const result = runCli([tmpDir, "-o", "ExampleOrg"], { NO_COLOR: "1" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /FF003 secret-gate: Secret usage is not owner-gated/);
  assert.match(result.stdout, /- (?:✅|⚠️) \.github\/workflows\/reuse\.yml:6:5 \(secrets: inherit\)/);
  assert.match(result.stdout, /6 \|     secrets: inherit/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("interactive mode applies accepted changes one edit at a time", () => {
  const tmpDir = fs.mkdtempSync(path.join(process.cwd(), "tmp-ffactions-interactive-"));
  const workflowsDir = path.join(tmpDir, ".github", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  const workflowPath = path.join(workflowsDir, "ci.yml");
  fs.writeFileSync(
    workflowPath,
    `name: CI
on: pull_request
jobs:
  publish:
    runs-on: benchmark
    steps:
      - run: twine upload dist/*
        env:
          TWINE_PASSWORD: \${{ secrets.PYPI_TOKEN }}
`
  );

  const result = fixWorkflows({
    cwd: tmpDir,
    upstreamOwner: "ExampleOrg",
    dryRun: true,
  });

  const choices = ["apply", "skip"];
  const summary = runInteractiveFix(result, {
    cwd: tmpDir,
    stdin: { isTTY: true, setRawMode() {}, resume() {}, pause() {} },
    stdout: { write() {} },
    readChoice() {
      return choices.shift() || "quit";
    },
  });

  const updated = fs.readFileSync(workflowPath, "utf8");
  assert.equal(summary.appliedChanges, 1);
  assert.match(updated, /runs-on: \$\{\{ github\.repository_owner == 'ExampleOrg' && 'benchmark' \|\| 'ubuntu-latest' \}\}/);
  assert.doesNotMatch(updated, /if: github\.repository_owner == 'ExampleOrg'/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("flags unresolved dynamic inputs.runs-on in reusable workflows", () => {
  const findings = audit(`
name: Reusable
on:
  workflow_call:
    inputs:
      runs-on:
        type: string
        default: ubuntu-latest
jobs:
  test:
    runs-on: \${{ inputs.runs-on }}
    steps:
      - run: echo hello
`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleCode, RULES.RUNNER_EXPRESSION.code);
  assert.match(findings[0].message, /cannot be locally resolved to a known public GitHub-hosted runner/);
});

test("workflow template lives outside marketplace-disqualifying workflow paths", () => {
  assert.equal(
    fs.existsSync(path.resolve(__dirname, "..", "contrib", "update-public-github-hosted-runners.workflow.yml")),
    true
  );
  assert.equal(
    fs.existsSync(path.resolve(__dirname, "..", ".github", "workflows", "update-public-github-hosted-runners.yml")),
    false
  );
});
