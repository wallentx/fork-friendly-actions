"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const YAML = require("yaml");
const { auditWorkflowFile, fixWorkflowFile } = require("../src/index.js");

const scope = {
  filePath: "/repo/.github/workflows/ci.yml",
  cwd: "/repo",
  upstreamRepo: "ExampleOrg/example-repo",
};

function workflow(matrix, reference = "matrix.os") {
  return YAML.stringify({
    name: "Matrix runners",
    on: "pull_request",
    jobs: {
      build: {
        "runs-on": `\${{ ${reference} }}`,
        strategy: { matrix },
        steps: [{ run: "echo build" }],
      },
    },
  });
}

// This evaluates only the generated string/boolean expression from the trusted
// fixtures below, whose operators have the same semantics in JS and Actions.
function selectRunner(expression, matrix, repository) {
  return vm.runInNewContext(expression.slice(3, -2), {
    github: { repository },
    matrix,
  }, { timeout: 1000 });
}

const runnerMappings = [
  ["blacksmith-32vcpu-ubuntu-2404", "ubuntu-24.04"],
  ["blacksmith-32vcpu-ubuntu-2404-arm", "ubuntu-24.04-arm"],
  ["blacksmith-8vcpu-ubuntu-2204", "ubuntu-22.04"],
  ["blacksmith-8vcpu-ubuntu-2204-arm", "ubuntu-22.04-arm"],
  ["blacksmith-12vcpu-macos-26", "macos-26"],
  ["blacksmith-6vcpu-macos-15", "macos-15"],
  ["blacksmith-6vcpu-macos-latest", "macos-latest"],
  ["blacksmith-32vcpu-windows-2025", "windows-2025"],
  ["macos-15-large", "macos-15-intel"],
  ["macos-15-xlarge", "macos-15"],
  ["macos-26-large", "macos-26-intel"],
  ["macos-latest-large", "macos-26-intel"],
  ["macos-latest-xlarge", "macos-latest"],
  ["linux-arm64", "ubuntu-24.04-arm"],
  ["windows-arm64", "windows-11-arm"],
  ["macos-15-intel", "macos-15-intel"],
  ["windows-11-arm", "windows-11-arm"],
  ["ubuntu-latest", "ubuntu-latest"],
  ["custom-public-runner", "custom-public-runner"],
];

test("scalar runner fallbacks preserve the same OS/version/architecture as matrices", () => {
  for (const [original, fallback] of runnerMappings) {
    const source = YAML.stringify({
      on: "pull_request",
      jobs: { build: { "runs-on": original, steps: [{ run: "echo build" }] } },
    });
    const options = { ...scope, source, allowList: new Set(["custom-public-runner"]) };
    const result = fixWorkflowFile(options);
    const runner = YAML.parse(result.fixedSource).jobs.build["runs-on"];
    if (original === fallback) {
      assert.equal(runner, original);
      assert.equal(result.changes.length, 0);
    } else {
      assert.equal(selectRunner(runner, {}, scope.upstreamRepo), original);
      assert.equal(selectRunner(runner, {}, "Contributor/fork"), fallback, original);
    }
    assert.deepEqual(auditWorkflowFile({ ...options, source: result.fixedSource }), []);
  }
});

test("matrix clause order is stable and earlier unsorted fixes remain accepted", () => {
  const mappings = runnerMappings.slice(0, 4);
  const runners = mappings.map(([runner]) => runner);
  const first = fixWorkflowFile({ ...scope, source: workflow({ os: runners }) });
  const reversed = fixWorkflowFile({ ...scope, source: workflow({ os: [...runners].reverse() }) });
  const expression = YAML.parse(first.fixedSource).jobs.build["runs-on"];
  assert.equal(YAML.parse(reversed.fixedSource).jobs.build["runs-on"], expression);

  const clauses = [...mappings].reverse().map(([original, fallback]) => `matrix.os == '${original}' && '${fallback}'`);
  const previous = YAML.parse(workflow({ os: runners }));
  previous.jobs.build["runs-on"] = `\${{ github.repository == '${scope.upstreamRepo}' && (matrix.os) || (${clauses.join(" || ")} || matrix.os) }}`;
  const source = YAML.stringify(previous);
  assert.deepEqual(auditWorkflowFile({ ...scope, source }), []);
  assert.equal(fixWorkflowFile({ ...scope, source }).changes.length, 0);

  for (const unsafe of [
    previous.jobs.build["runs-on"].replace("'ubuntu-22.04-arm'", "'private-runner'"),
    previous.jobs.build["runs-on"].replace(" || matrix.os)", " || 'private-runner')"),
    previous.jobs.build["runs-on"].replace(" || matrix.os)", " || 'private-runner' || matrix.os)"),
  ]) {
    previous.jobs.build["runs-on"] = unsafe;
    assert.equal(auditWorkflowFile({ ...scope, source: YAML.stringify(previous) })[0].ruleCode, "FF002");
  }
});

for (const shape of ["axis", "include", "nested"]) {
  test(`preserves platform and architecture for every ${shape} matrix runner`, () => {
    const rows = runnerMappings.map(([os], index) => ({
      os,
      name: `build-${index}`,
      // Target architecture need not match the runner: ccusage cross-builds
      // Intel macOS packages on its Apple Silicon build runner.
      arch: "x64",
      binary: "result/bin/tool",
    }));
    const matrix = shape === "axis" ? { os: rows.map((row) => row.os) }
      : shape === "include" ? { include: rows }
        : { config: rows };
    const reference = shape === "nested" ? "matrix.config.os" : "matrix.os";
    const source = workflow(matrix, reference);
    const options = {
      ...scope, source, allowList: new Set(["custom-public-runner"]),
      runnerFallback: "windows-latest",
    };
    const result = fixWorkflowFile(options);
    assert.equal(result.changes.length, 1);
    const fixed = YAML.parse(result.fixedSource).jobs.build;
    assert.deepEqual(fixed.strategy.matrix, matrix);
    assert.deepEqual(fixed.steps, YAML.parse(source).jobs.build.steps);

    for (const [index, [original, fallback]] of runnerMappings.entries()) {
      const row = shape === "nested" ? { config: rows[index] } : rows[index];
      assert.equal(selectRunner(fixed["runs-on"], row, scope.upstreamRepo), original);
      assert.equal(selectRunner(fixed["runs-on"], row, "Contributor/fork"), fallback, original);
    }
    assert.deepEqual(auditWorkflowFile({ ...options, source: result.fixedSource }), []);
    const secondPass = fixWorkflowFile({ ...options, source: result.fixedSource });
    assert.equal(secondPass.changes.length, 0);
    assert.equal(secondPass.fixedSource, result.fixedSource);
  });
}

for (const unknown of ["private-runner", "custom-linux-riscv64", "custom-windows-arm64", "blacksmith-12vcpu-macos-27", "macos-14-large", "${{ inputs.runner }}"]) {
  test(`does not collapse the matrix when ${unknown} has no known compatible fallback`, () => {
    const source = workflow({ os: ["ubuntu-latest", "blacksmith-32vcpu-ubuntu-2404-arm", unknown] });
    const result = fixWorkflowFile({ ...scope, source, runnerFallback: "ubuntu-latest" });
    assert.equal(result.fixedSource, source);
    assert.equal(result.changes.length, 0);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].fixable, false);
    assert.match(result.findings[0].message, /configure OS\/architecture-compatible fallbacks manually/);
  });
}

for (const shape of ["axis", "include", "nested", "indexed", "fallback pair"]) {
  test(`requires manual review for array-valued ${shape} matrix runners`, () => {
    for (const publicRunner of [["ubuntu-latest"], "ubuntu-latest"]) {
      const runners = [["blacksmith-32vcpu-ubuntu-2404"], publicRunner];
      let matrix;
      let reference = "matrix.runner";
      if (shape === "axis") {
        matrix = { runner: runners };
      } else if (shape === "include") {
        matrix = { include: runners.map((runner) => ({ runner })) };
      } else if (shape === "nested") {
        matrix = { config: runners.map((runner) => ({ runner })) };
        reference = "matrix.config.runner";
      } else if (shape === "indexed") {
        matrix = { config: runners.map((runner) => ({ x64: runner })), arch: ["x64"] };
        reference = "matrix.config[matrix.arch]";
      } else {
        matrix = { pool: [{ group: "private-pool" }], runner: runners };
        reference = "matrix.pool || matrix.runner";
      }

      const source = workflow(matrix, reference);
      const result = fixWorkflowFile({ ...scope, source, runnerFallback: "ubuntu-latest" });
      assert.equal(result.fixedSource, source);
      assert.equal(result.changes.length, 0);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].fixable, false);
      assert.match(result.findings[0].message, /configure OS\/architecture-compatible fallbacks manually/);
    }
  });
}

test("reports manual matrix fallback review in CLI dry runs without writing files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ffactions-matrix-"));
  try {
    const file = path.join(directory, "ci.yml");
    const source = workflow({ os: ["ubuntu-latest", "unknown-runner"] });
    fs.writeFileSync(file, source);
    const output = execFileSync(process.execPath, [
      path.resolve(__dirname, "../bin/fork-friendly-actions.js"),
      "--dry-run", "--upstream-repo", scope.upstreamRepo, file,
    ], { encoding: "utf8" });
    assert.match(output, /Would apply 0 changes/);
    assert.match(output, /Manual review required:/);
    assert.match(output, /FF002 .*configure OS\/architecture-compatible fallbacks manually/);
    assert.equal(fs.readFileSync(file, "utf8"), source);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("leaves dynamically generated and unsupported matrix expressions unchanged", () => {
  for (const [matrix, reference] of [
    ["${{ fromJSON(needs.plan.outputs.matrix) }}", "matrix.os"],
    [{ os: ["ubuntu-latest", "unknown-runner"] }, "matrix['os']"],
    [{ os: ["ubuntu-latest", "blacksmith-32vcpu-ubuntu-2404-arm"] }, "format('{0}', matrix.os)"],
  ]) {
    const source = workflow(matrix, reference);
    const result = fixWorkflowFile({ ...scope, source });
    assert.equal(result.fixedSource, source);
    assert.equal(result.changes.length, 0);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].fixable, false);
  }
});
