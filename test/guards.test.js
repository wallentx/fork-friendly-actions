"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const YAML = require("yaml");
const { auditWorkflowFile, evaluateWorkflows, fixWorkflowFile } = require("../src/index.js");

const scope = {
  cwd: "/repo",
  filePath: "/repo/.github/workflows/release.yml",
  upstreamRepo: "ExampleOrg/example-repo",
};
const upstream = "github.repository == 'ExampleOrg/example-repo'";
const tagpr = "github.event_name != 'pull_request' || startsWith(github.head_ref, 'tagpr-from-')";

function workflow(condition, runner = "private-runner", step = { run: "echo build" }) {
  return YAML.stringify({
    name: "Guard regression",
    on: ["push", "pull_request", "workflow_dispatch"],
    jobs: { build: { if: condition, "runs-on": runner, steps: [step] } },
  });
}

const unsafeConditions = [
  tagpr,
  "github.event_name != 'pull_request'",
  "github.event_name == 'push'",
  "github.event_name == 'schedule'",
  "github.event.pull_request.head.repo.full_name == github.repository",
  "github.event.pull_request.head.repo.fork == false",
  "github.repository != 'ExampleOrg/example-repo'",
  "github.repository_owner != 'ExampleOrg'",
  "github.repository == 'Contributor/fork'",
  "github.repository_owner == 'Contributor'",
  `${upstream} || true`,
  `true || (${upstream})`,
  `${upstream} || inputs.force`,
  `(${upstream} && success()) || failure()`,
  `!(${upstream})`,
  `'github.repository == ''ExampleOrg/example-repo'''`,
  `contains('github.repository == ''ExampleOrg/example-repo''', 'repository')`,
  `startsWith(github.repository, 'ExampleOrg/')`,
  `${upstream} || 'false'`,
  `${upstream} || (`,
];

for (const condition of unsafeConditions) {
  test(`does not suppress the private runner for ${condition}`, () => {
    const source = workflow(`\${{ ${condition} }}`);
    const findings = auditWorkflowFile({ ...scope, source });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "FF001");
    const result = fixWorkflowFile({ ...scope, source });
    assert.equal(result.changes.length, 1);
    const fixed = YAML.parse(result.fixedSource).jobs.build;
    assert.equal(fixed.if, YAML.parse(source).jobs.build.if);
    assert.match(fixed["runs-on"], /github.repository == 'ExampleOrg\/example-repo'.*\|\| 'ubuntu-latest'/);
    assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), []);
    assert.equal(fixWorkflowFile({ ...scope, source: result.fixedSource }).changes.length, 0);
  });
}

test("mixed interpolation does not suppress private-runner or step findings", () => {
  for (const condition of [
    "${{ false }} && true",
    "false && ${{ true }}",
    "${{ false }} && ${{ true }}",
    `\${{ ${upstream} }} && true`,
    `false && (\${{ ${upstream} }})`,
  ]) {
    const source = workflow(condition);
    const findings = auditWorkflowFile({ ...scope, source });
    assert.deepEqual(findings.map((finding) => finding.ruleCode), ["FF001"], condition);
    const result = fixWorkflowFile({ ...scope, source });
    assert.equal(result.changes.length, 1, condition);
    assert.equal(YAML.parse(result.fixedSource).jobs.build.if, condition);
    assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), [], condition);

    const stepSource = workflow("success()", "ubuntu-latest", {
      if: condition, run: "npm publish", env: { TOKEN: "${{ secrets.NPM_TOKEN }}" },
    });
    assert.deepEqual(auditWorkflowFile({ ...scope, source: stepSource })
      .map((finding) => finding.ruleCode).sort(), ["FF003", "FF004"], condition);
  }
});

test("plain and fully wrapped Boolean conditions remain recognized", () => {
  for (const condition of ["false && true", "${{ false && true }}", "${{ (false && true) }}"]) {
    const source = workflow(condition);
    assert.deepEqual(auditWorkflowFile({ ...scope, source }), [], condition);
    assert.equal(fixWorkflowFile({ ...scope, source }).fixedSource, source);
  }
});

const safeConditions = [
  upstream,
  `(${upstream})`,
  `success() && (${upstream})`,
  `${upstream} && (success() || inputs.force)`,
  `(${upstream} && success()) || (${upstream} && failure())`,
  `'ExampleOrg/example-repo' == github.repository`,
  `github.repository == 'EXAMPLEORG/EXAMPLE-REPO'`,
  `github.repository_owner == 'ExampleOrg'`,
  `!(github.repository != 'ExampleOrg/example-repo')`,
  `!(!(github.repository == 'ExampleOrg/example-repo'))`,
  `${upstream} || false`,
  `${upstream} && contains('a || b && c', 'b')`,
];

for (const condition of safeConditions) {
  test(`preserves the upstream restriction ${condition}`, () => {
    const source = workflow(`\${{ ${condition} }}`);
    assert.deepEqual(auditWorkflowFile({ ...scope, source }), []);
    assert.equal(fixWorkflowFile({ ...scope, source }).fixedSource, source);
  });
}

test("tagpr keeps its event filter and gets the right runner on fork pushes and dispatches", () => {
  const source = workflow(tagpr, "blacksmith-32vcpu-ubuntu-2404");
  const fixed = YAML.parse(fixWorkflowFile({ ...scope, source }).fixedSource).jobs.build;
  assert.equal(fixed.if, tagpr);
  for (const repository of [scope.upstreamRepo, "Contributor/fork"]) {
    for (const event_name of ["push", "workflow_dispatch", "pull_request"]) {
      const context = {
        github: { repository, event_name, head_ref: "ordinary-pr" },
        startsWith: (value, prefix) => value.startsWith(prefix),
      };
      // These trusted fixture expressions use the same operators in JS/Actions.
      assert.equal(vm.runInNewContext(fixed.if, context), event_name !== "pull_request");
      assert.equal(vm.runInNewContext(fixed["runs-on"].slice(3, -2), context),
        repository === scope.upstreamRepo ? "blacksmith-32vcpu-ubuntu-2404" : "ubuntu-latest");
    }
  }
});

test("self-hosted jobs receive an upstream guard without losing the existing OR condition", () => {
  const source = workflow(tagpr, ["self-hosted", "linux"]);
  const result = fixWorkflowFile({ ...scope, source });
  const job = YAML.parse(result.fixedSource).jobs.build;
  assert.equal(job.if, `${upstream} && (${tagpr})`);
  assert.deepEqual(job["runs-on"], ["self-hosted", "linux"]);
  assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), []);
});

test("step event filters and OR bypasses do not suppress secret and publish checks", () => {
  for (const condition of [tagpr, `${upstream} || true`]) {
    const step = { if: condition, run: "npm publish", env: { TOKEN: "${{ secrets.NPM_TOKEN }}" } };
    const source = workflow("success()", "ubuntu-latest", step);
    const result = fixWorkflowFile({ ...scope, source });
    assert.deepEqual(result.findings.map((finding) => finding.ruleCode).sort(), ["FF003", "FF004"]);
    assert.equal(YAML.parse(result.fixedSource).jobs.build.steps[0].if, `${upstream} && (${condition})`);
    assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), []);
  }
});

test("runner expressions must actually guard the private branch and return a public fallback", () => {
  const expressions = [
    `(${upstream} || true) && 'private-runner' || 'ubuntu-latest'`,
    `github.event_name == 'push' && 'private-runner' || 'ubuntu-latest'`,
    `github.repository != 'ExampleOrg/example-repo' && 'private-runner' || 'ubuntu-latest'`,
    `${upstream} && 'private-runner' || 'another-private-runner'`,
    `${upstream} && 'private-runner' || inputs.runner || 'ubuntu-latest'`,
    `contains('github.repository == ''ExampleOrg/example-repo''', 'repository') && 'private-runner' || 'ubuntu-latest'`,
  ];
  for (const expression of expressions) {
    const source = workflow("success()", `\${{ ${expression} }}`);
    const result = fixWorkflowFile({ ...scope, source });
    assert.equal(result.findings.length, 1, expression);
    assert.equal(result.findings[0].ruleCode, "FF002", expression);
    assert.equal(result.changes.length, 1, expression);
    assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), [], expression);
  }
});

test("valid guarded runner fallbacks remain unchanged", () => {
  for (const expression of [
    `${upstream} && 'private-runner' || 'ubuntu-latest'`,
    `(${upstream} && success()) && 'private-runner' || 'ubuntu-latest'`,
    `(${upstream} && 'private-runner' || 'ubuntu-latest')`,
    `${upstream} && 'private-runner' || ('ubuntu-latest')`,
    `${upstream} && 'private-runner' || fromJSON('["ubuntu-latest"]')`,
  ]) {
    const source = workflow("success()", `\${{ ${expression} }}`);
    assert.deepEqual(auditWorkflowFile({ ...scope, source }), [], expression);
    assert.equal(fixWorkflowFile({ ...scope, source }).fixedSource, source);
  }
});

test("parenthesized public array fallbacks preserve the macOS runner", () => {
  for (const fallback of [
    `fromJSON('["macos-latest"]')`,
    `(fromJSON('["macos-latest"]'))`,
    `((fromJSON('["macos-latest"]')))`,
    `(fromJSON('["macos-latest"]')) || 'private-runner'`,
  ]) {
    const source = workflow("success()", `\${{ ${upstream} && 'private-runner' || ${fallback} }}`);
    assert.deepEqual(auditWorkflowFile({ ...scope, source }), [], fallback);
    const result = fixWorkflowFile({ ...scope, source });
    assert.equal(result.changes.length, 0, fallback);
    assert.equal(result.fixedSource, source, fallback);
  }
});

test("parenthesized invalid or private array fallbacks still need a finding", () => {
  for (const value of ['["private-runner"]', '[]', 'invalid-json']) {
    const source = workflow("success()", `\${{ ${upstream} && 'private-runner' || (fromJSON('${value}')) }}`);
    assert.deepEqual(auditWorkflowFile({ ...scope, source })
      .map((finding) => finding.ruleCode), ["FF002"], value);
  }
});

test("owner-only scope does not accept another owner's repository restriction", () => {
  const options = { ...scope, upstreamRepo: "", upstreamOwner: "ExampleOrg" };
  assert.equal(auditWorkflowFile({ ...options, source: workflow("github.repository == 'Contributor/fork'") }).length, 1);
  assert.deepEqual(auditWorkflowFile({ ...options, source: workflow(upstream) }), []);
});

test("guard insertion replaces folded and literal conditions while preserving subsequent steps", () => {
  for (const style of [">-", "|"]) {
    const source = `name: Publish
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - if: ${style}
          github.event_name != 'pull_request' ||
          startsWith(github.head_ref, 'tagpr-from-')
        run: npm publish
      - run: echo complete
`;
    const result = fixWorkflowFile({ ...scope, source });
    const originalSteps = YAML.parse(source).jobs.publish.steps;
    const fixedSteps = YAML.parse(result.fixedSource).jobs.publish.steps;
    assert.equal(fixedSteps.length, 2);
    assert.equal(fixedSteps[0].if, `${upstream} && (${originalSteps[0].if.trim()})`);
    assert.equal(fixedSteps[0].run, "npm publish");
    assert.deepEqual(fixedSteps[1], originalSteps[1]);
    assert.deepEqual(auditWorkflowFile({ ...scope, source: result.fixedSource }), []);
  }
});

test("reusable workflow secret safety uses the complete scoped condition", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ffactions-guards-"));
  try {
    const workflows = path.join(cwd, ".github/workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, "caller.yml"), YAML.stringify({
      on: "push", jobs: { call: { uses: "./.github/workflows/callee.yml", secrets: "inherit" } },
    }));
    for (const condition of [tagpr, `${upstream} || true`, "github.repository == 'Contributor/fork'"]) {
      const callee = YAML.parse(workflow(condition, "ubuntu-latest", {
        run: "echo test", env: { TOKEN: "${{ secrets.API_TOKEN }}" },
      }));
      callee.on = "workflow_call";
      fs.writeFileSync(path.join(workflows, "callee.yml"), YAML.stringify(callee));
      const result = evaluateWorkflows({ cwd, upstreamRepo: scope.upstreamRepo });
      assert.ok(result.findings.some((finding) => finding.file.endsWith("caller.yml") && finding.ruleCode === "FF003"), condition);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
