"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const YAML = require("yaml");
const { auditWorkflowFile, fixWorkflowFile } = require("../src/index.js");

const scope = {
  filePath: "/repo/.github/workflows/ci.yml",
  cwd: "/repo",
  upstreamRepo: "ExampleOrg/example-repo",
};
const upstream = "github.repository == 'ExampleOrg/example-repo'";

function workflow(run) {
  return YAML.stringify({
    on: "pull_request",
    jobs: { publish: { "runs-on": "ubuntu-latest", steps: [{ run }] } },
  });
}

for (const command of [
  "npm publish",
  "pnpm publish --access public",
  "pnpm dlx pkg-pr-new@0.0.75 publish --pnpm --bin './apps/ccusage'",
  "pnpm dlx pkg-pr-new publish ./packages/*",
  "pnpm exec pkg-pr-new publish",
  "npx pkg-pr-new@latest publish",
  "npx pkg-pr-new publish",
  "pkg-pr-new publish",
  "pnpm publish; echo complete",
  "pnpm publish&&echo complete",
  "pkg-pr-new publish>publish.log",
]) {
  test(`gates publisher: ${command}`, () => {
    const source = workflow(command);
    const findings = auditWorkflowFile({ ...scope, source });
    assert.deepEqual(findings.map((finding) => finding.ruleCode), ["FF004"]);
    const result = fixWorkflowFile({ ...scope, source });
    const step = YAML.parse(result.fixedSource).jobs.publish.steps[0];
    assert.equal(step.if, upstream);
    assert.equal(step.run, command);
    assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), []);
    assert.equal(fixWorkflowFile({ ...scope, source: result.fixedSource }).changes.length, 0);
  });
}

test("does not flag package installation, packing, or unrelated commands", () => {
  for (const command of [
    "pnpm install --frozen-lockfile", "pnpm pack", "pnpm dlx pkg-pr-new --help",
    "npx pkg-pr-new@0.0.75 --version", "pnpm dlx another-tool publish",
    "pnpm publish:docs", "pnpm publish-preview", "pnpm publish_docs",
    "pnpm run publish:docs", "pnpm dlx pkg-pr-new publish-preview",
    "pkg-pr-new publish:docs",
  ]) {
    const source = workflow(command);
    assert.deepEqual(auditWorkflowFile({ ...scope, source }), [], command);
    assert.equal(fixWorkflowFile({ ...scope, source }).fixedSource, source, command);
  }
});

test("propagates publishing guards through transformed outputs and downstream jobs in one pass", () => {
  const source = YAML.stringify({
    on: "pull_request",
    jobs: {
      publish: {
        if: "success()",
        "runs-on": "ubuntu-latest",
        outputs: { url: "${{ steps.final-url.outputs.url }}" },
        steps: [
          { id: "publish", run: "pnpm dlx pkg-pr-new@0.0.75 publish --pnpm --bin './apps/ccusage'" },
          { id: "preview-url", env: { URLS: "${{ steps.publish.outputs.urls }}" }, run: "echo transform" },
          { id: "final-url", env: { URL: "${{ steps.preview-url.outputs.url }}" }, run: "echo transform" },
        ],
      },
      e2e: {
        needs: "publish", "runs-on": "ubuntu-latest",
        env: { URL: "${{ needs.publish.outputs.url }}" }, steps: [{ run: "echo test" }],
      },
      report: {
        if: "always()", needs: "publish", "runs-on": "ubuntu-latest",
        env: { URL: "${{ needs.publish.outputs.url }}" }, steps: [{ run: "echo report" }],
      },
      independent: { "runs-on": "ubuntu-latest", steps: [{ run: "echo lint" }] },
    },
  });
  const findings = auditWorkflowFile({ ...scope, source });
  assert.deepEqual(findings.map((finding) => finding.ruleCode).sort(), ["FF004", "FF006", "FF007", "FF007", "FF007"]);
  const result = fixWorkflowFile({ ...scope, source });
  const jobs = YAML.parse(result.fixedSource).jobs;
  assert.equal(jobs.publish.if, `${upstream} && (success())`);
  for (const step of jobs.publish.steps) assert.equal(step.if, upstream);
  assert.equal(jobs.report.if, `${upstream} && (always())`);
  // Ordinary needs propagation already skips e2e when publishing is skipped.
  assert.deepEqual(jobs.e2e, YAML.parse(source).jobs.e2e);
  assert.deepEqual(jobs.independent, YAML.parse(source).jobs.independent);
  assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), []);
  assert.equal(fixWorkflowFile({ ...scope, source: result.fixedSource }).changes.length, 0);
});

for (const [name, consumerFields] of [
  ["dynamic matrix", { strategy: { matrix: "${{ fromJSON(needs.publish.outputs.matrix) }}" } }],
  ["indexed job", { env: { URL: "${{ needs['publish'].outputs.url }}" } }],
  ["indexed outputs", { env: { URL: "${{ needs.publish['outputs']['url'] }}" } }],
  ["fully indexed reference", { env: { URL: "${{ needs[ 'publish' ][ 'outputs' ][ 'url' ] }}" } }],
  ["whole output object", { env: { DATA: "${{ toJSON(needs.publish.outputs) }}" } }],
  ["indexed output object", { env: { DATA: "${{ toJSON(needs['publish']['outputs']) }}" } }],
  ["output object in condition", { if: "always() && toJSON(needs.publish.outputs)" }],
  ["container image", { container: { image: "${{ needs.publish.outputs.image }}" } }],
  ["service image", { services: { database: { image: "${{ needs.publish.outputs.image }}" } } }],
  ["concurrency group", { concurrency: { group: "${{ needs.publish.outputs.group }}" } }],
  ["timeout", { "timeout-minutes": "${{ fromJSON(needs.publish.outputs.minutes) }}" }],
  ["continue-on-error", { "continue-on-error": "${{ fromJSON(needs.publish.outputs.ignore) }}" }],
]) {
  test(`guards an always consumer of a skipped publisher's ${name}`, () => {
    const source = YAML.stringify({
      on: "pull_request",
      jobs: {
        publish: {
          if: upstream, "runs-on": "ubuntu-latest",
          outputs: {
            url: "https://example.com", matrix: '{"os":["ubuntu-latest"]}',
            image: "alpine:3", group: "consumer", minutes: "10", ignore: "false",
          },
          steps: [{ run: "echo publish" }],
        },
        consumer: {
          if: "always()", needs: "publish", "runs-on": "ubuntu-latest",
          outputs: { summary: "consumer completed" },
          ...consumerFields, steps: [{ run: "echo consume" }],
        },
        downstream: {
          if: "always()", needs: "consumer", "runs-on": "ubuntu-latest",
          env: { DATA: "${{ toJSON(needs.consumer.outputs) }}" }, steps: [{ run: "echo downstream" }],
        },
      },
    });
    const findings = auditWorkflowFile({ ...scope, source });
    assert.deepEqual(findings.map((finding) => finding.ruleCode), ["FF006", "FF006"]);
    assert.ok(findings.every((finding) => finding.fixable));
    const result = fixWorkflowFile({ ...scope, source });
    assert.equal(result.changes.length, 2);
    const jobs = YAML.parse(result.fixedSource).jobs;
    const originalJobs = YAML.parse(source).jobs;
    for (const job of ["consumer", "downstream"]) {
      assert.deepEqual(jobs[job], { ...originalJobs[job], if: `${upstream} && (${originalJobs[job].if})` });
    }
    assert.deepEqual(jobs.publish, originalJobs.publish);
    assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), []);
    assert.equal(fixWorkflowFile({ ...scope, source: result.fixedSource }).changes.length, 0);
  });
}

test("preserves equivalent dotted and indexed Boolean output gates", () => {
  for (const reference of [
    "needs.publish.outputs.enabled",
    "needs['publish'].outputs.enabled",
    "needs.publish['outputs']['enabled']",
    "needs[ 'publish' ][ 'outputs' ][ 'enabled' ]",
  ]) {
    for (const condition of [
      `always() && ${reference} == 'true'`,
      `always() && ('true' == ${reference})`,
    ]) {
      const source = YAML.stringify({
        on: "pull_request",
        jobs: {
          publish: { if: upstream, "runs-on": "ubuntu-latest", steps: [{ run: "echo publish" }] },
          consumer: { if: condition, needs: "publish", "runs-on": "ubuntu-latest", steps: [{ run: "echo consume" }] },
        },
      });
      assert.deepEqual(auditWorkflowFile({ ...scope, source }), [], condition);
      assert.equal(fixWorkflowFile({ ...scope, source }).fixedSource, source, condition);
    }
  }
});

test("Boolean output comparisons cannot suppress findings when bypassed", () => {
  const reference = "needs['publish']['outputs']['enabled']";
  for (const condition of [
    `always() || ${reference} == 'true'`,
    `always() && (${reference} == 'true' || inputs.force)`,
    `always() && !(${reference} == 'true')`,
  ]) {
    const source = YAML.stringify({
      on: "pull_request",
      jobs: {
        publish: { if: upstream, "runs-on": "ubuntu-latest", steps: [{ run: "echo publish" }] },
        consumer: { if: condition, needs: "publish", "runs-on": "ubuntu-latest", steps: [{ run: "echo consume" }] },
      },
    });
    const result = fixWorkflowFile({ ...scope, source });
    assert.deepEqual(result.findings.map((finding) => finding.ruleCode), ["FF006"], condition);
    assert.equal(YAML.parse(result.fixedSource).jobs.consumer.if, `${upstream} && (${condition})`);
  }
});

test("keeps status and timeline jobs running without propagating skips through them", () => {
  const source = YAML.stringify({
    on: { workflow_call: { outputs: { summary: { value: "${{ jobs.report.outputs.summary }}" } } } },
    jobs: {
      publish: { if: upstream, "runs-on": "ubuntu-latest", steps: [{ run: "pnpm publish" }] },
      report: {
        if: "always()", needs: "publish", "runs-on": "ubuntu-latest",
        concurrency: { group: "status-${{ needs.publish.result }}" },
        outputs: { summary: "${{ steps.status.outputs.summary }}" },
        steps: [{ id: "status", env: {
          RESULTS: "${{ join(needs.*.result, ' ') }}",
          PUBLISH_RESULT: "${{ needs['publish']['result'] }}",
        }, run: "echo status" }],
      },
      timeline: {
        if: "always()", needs: "publish", "runs-on": "ubuntu-latest",
        steps: [{ uses: "Kesin11/actions-timeline@v2" }],
      },
      downstream: {
        if: "always()", needs: "report", "runs-on": "ubuntu-latest",
        env: { SUMMARY: "${{ needs.report.outputs.summary }}" }, steps: [{ run: "echo report" }],
      },
    },
  });
  const result = fixWorkflowFile({ ...scope, source });
  assert.equal(result.fixedSource, source);
  assert.equal(result.changes.length, 0);
  assert.equal(result.findings.length, 2);
  for (const finding of result.findings) {
    assert.equal(finding.ruleCode, "FF006");
    assert.equal(finding.fixable, false);
    assert.match(finding.message, /review manually/);
  }
});
