"use strict";

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const DEFAULT_WORKFLOWS_DIR = ".github/workflows";
const DEFAULT_RUNNER_FALLBACK = "ubuntu-latest";
const DEFAULT_PUBLIC_RUNNERS_FILE = path.resolve(__dirname, "..", "data", "public-github-hosted-runners.txt");
const EMBEDDED_PUBLIC_GITHUB_HOSTED_RUNNERS = null;
const PUBLIC_GITHUB_HOSTED_RUNNERS = loadPublicGithubHostedRunners();
const RULES = Object.freeze({
  RUNNER_LABEL: {
    code: "FF001",
    slug: "runner-label",
    title: "Private runner is not fork-friendly",
    description: "Runner labels must resolve to a known free public GitHub-hosted runner on forks, or self-hosted jobs must be skipped behind an upstream-only condition.",
  },
  RUNNER_EXPRESSION: {
    code: "FF002",
    slug: "runner-expression",
    title: "Dynamic runner expression needs a fork fallback",
    description: "Dynamic runs-on expressions should clearly choose a known free public GitHub-hosted runner when the workflow runs outside the upstream repository, or skip self-hosted jobs on forks.",
  },
  SECRET_GATE: {
    code: "FF003",
    slug: "secret-gate",
    title: "Secret usage is not owner-gated",
    description: "Fork pull requests cannot access normal repository or organization secrets, so these references need an owner guard.",
  },
  PUBLISH_GATE: {
    code: "FF004",
    slug: "publish-gate",
    title: "Publish, deploy, or auth step is not upstream-gated",
    description: "Publishing, deployment, release-write, and cloud-auth steps should usually be skipped on forks with an upstream guard.",
  },
  SNAPSHOT_GATE: {
    code: "FF005",
    slug: "snapshot-gate",
    title: "Snapshot job is not upstream-gated",
    description: "Jobs that generate runner snapshots or custom images should usually be skipped on forks with an upstream guard.",
  },
  NEEDS_GATE: {
    code: "FF006",
    slug: "needs-gate",
    title: "Dependent job bypasses upstream-only skip",
    description: "Jobs with conditions like always() can run even when an upstream-only dependency is skipped, so those bypasses should be upstream-gated.",
  },
  OUTPUT_GATE: {
    code: "FF007",
    slug: "output-gate",
    title: "Output dependency is not upstream-gated",
    description: "If a step, job output, or reusable workflow output depends on an upstream-only producer, the consumer should also be upstream-gated.",
  },
});

const OWNER_GUARD_PATTERNS = [
  /github\.repository_owner\s*==/,
  /github\.repository_owner\s*!=/,
  /github\.repository\s*==/,
  /github\.repository\s*!=/,
  /github\.event_name\s*!=\s*['"]pull_request['"]/,
  /github\.event_name\s*==\s*['"]push['"]/,
  /github\.event_name\s*==\s*['"]schedule['"]/,
  /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/,
  /github\.event\.pull_request\.head\.repo\.fork\s*==\s*false/,
];

const PUBLISH_USES_PATTERNS = [
  /\bpypa\/gh-action-pypi-publish\b/i,
  /\bdocker\/login-action\b/i,
  /\bsoftprops\/action-gh-release\b/i,
  /\bactions\/create-release\b/i,
  /\baws-actions\/configure-aws-credentials\b/i,
  /\bgoogle-github-actions\/auth\b/i,
  /\bazure\/login\b/i,
];

const PUBLISH_RUN_PATTERNS = [
  /\bnpm\s+publish\b/i,
  /\btwine\s+upload\b/i,
  /\bdocker\s+push\b/i,
  /\bgh\s+release\s+(create|upload|edit|delete)\b/i,
];

const GITHUB_RELEASE_WRITE_PATTERN = /\bgh\s+release\s+(create|upload|edit|delete)\b/i;
const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);

const STEP_OUTPUT_REFERENCE_PATTERN = /\bsteps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)\b/g;
const NEEDS_OUTPUT_REFERENCE_PATTERN = /\bneeds\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)\b/g;
const JOB_OUTPUT_REFERENCE_PATTERN = /\bjobs\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z_][A-Za-z0-9_-]*)\b/g;

function discoverWorkflowFiles(workflowsPath) {
  if (!fs.existsSync(workflowsPath)) {
    return [];
  }

  const stat = fs.statSync(workflowsPath);
  if (stat.isFile()) {
    return isWorkflowFile(workflowsPath) ? [workflowsPath] : [];
  }

  const files = [];
  for (const entry of fs.readdirSync(workflowsPath, { withFileTypes: true })) {
    const entryPath = path.join(workflowsPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverWorkflowFiles(entryPath));
    } else if (entry.isFile() && isWorkflowFile(entryPath)) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function isWorkflowFile(filePath) {
  return /\.ya?ml$/i.test(filePath);
}

function parseRunnerAllowList(extraRunners) {
  return new Set(
    String(extraRunners)
      .split(",")
      .map((runner) => runner.trim())
      .filter(Boolean)
  );
}

function loadPublicGithubHostedRunners({
  filePath = DEFAULT_PUBLIC_RUNNERS_FILE,
  embeddedList = EMBEDDED_PUBLIC_GITHUB_HOSTED_RUNNERS,
} = {}) {
  if (Array.isArray(embeddedList)) {
    return new Set(embeddedList);
  }

  const source = fs.readFileSync(filePath, "utf8");
  return new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

function ownerFromRepoSlug(upstreamRepo = "") {
  const match = String(upstreamRepo).trim().match(/^([^/]+)\/[^/]+$/);
  return match ? match[1] : "";
}

function buildUpstreamGuardExpression({ upstreamRepo = "", upstreamOwner = "" } = {}) {
  if (upstreamRepo) {
    return `github.repository == '${escapeExpressionString(upstreamRepo)}'`;
  }
  if (upstreamOwner) {
    return `github.repository_owner == '${escapeExpressionString(upstreamOwner)}'`;
  }
  return "";
}

function normalizeUpstreamScope({ upstreamRepo = "", upstreamOwner = "" } = {}) {
  const normalizedRepo = String(upstreamRepo).trim();
  const normalizedOwner = String(upstreamOwner).trim() || ownerFromRepoSlug(normalizedRepo);
  return {
    upstreamRepo: normalizedRepo,
    upstreamOwner: normalizedOwner,
    guardExpression: buildUpstreamGuardExpression({ upstreamRepo: normalizedRepo, upstreamOwner: normalizedOwner }),
  };
}

function auditWorkflows({ cwd = process.cwd(), workflows = DEFAULT_WORKFLOWS_DIR, upstreamRepo = "", upstreamOwner = "", allowRunners = "" } = {}) {
  return evaluateWorkflows({ cwd, workflows, upstreamRepo, upstreamOwner, allowRunners, mode: "check" });
}

function fixWorkflows({
  cwd = process.cwd(),
  workflows = DEFAULT_WORKFLOWS_DIR,
  upstreamRepo = "",
  upstreamOwner,
  allowRunners = "",
  runnerFallback = DEFAULT_RUNNER_FALLBACK,
  dryRun = false,
} = {}) {
  const upstreamScope = normalizeUpstreamScope({ upstreamRepo, upstreamOwner });
  if (!upstreamScope.guardExpression) {
    throw new Error("upstreamRepo or upstreamOwner is required when applying fixes.");
  }
  return evaluateWorkflows({
    cwd,
    workflows,
    upstreamRepo: upstreamScope.upstreamRepo,
    upstreamOwner: upstreamScope.upstreamOwner,
    allowRunners,
    runnerFallback,
    dryRun,
    mode: "fix",
  });
}

function evaluateWorkflows({
  cwd = process.cwd(),
  workflows = DEFAULT_WORKFLOWS_DIR,
  upstreamRepo = "",
  upstreamOwner = "",
  allowRunners = "",
  runnerFallback = DEFAULT_RUNNER_FALLBACK,
  dryRun = false,
  mode = "check",
} = {}) {
  const workflowsPath = path.resolve(cwd, workflows);
  const allowList = parseRunnerAllowList(allowRunners);
  const files = discoverWorkflowFiles(workflowsPath);
  const findings = [];
  const changes = [];
  const fileChanges = [];
  const editPlans = [];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const result = evaluateWorkflowFile({
      filePath,
      source,
      cwd,
      upstreamRepo,
      upstreamOwner,
      allowList,
      runnerFallback,
      mode,
    });
    findings.push(...result.findings);
    changes.push(...result.changes);
    if (mode === "fix" && result.fixedSource !== source) {
      editPlans.push({
        file: result.relativeFile || path.relative(cwd, filePath),
        filePath,
        originalSource: source,
        fixedSource: result.fixedSource,
        lineEnding: source.includes("\r\n") ? "\r\n" : "\n",
        edits: result.edits.map((edit) => ({
          ...edit,
          file: result.relativeFile || path.relative(cwd, filePath),
        })),
      });
      fileChanges.push({
        file: result.changes[0]?.file || path.relative(cwd, filePath),
        originalSource: source,
        fixedSource: result.fixedSource,
      });
      if (!dryRun) {
        fs.writeFileSync(filePath, result.fixedSource);
      }
    }
  }

  return {
    files,
    findings,
    changes,
    fileChanges,
    editPlans,
    changedFiles: [...new Set(changes.map((change) => change.file))],
    summary: summarizeFindings(findings, changes),
  };
}

function auditWorkflowFile({ filePath, source, cwd, upstreamRepo = "", upstreamOwner = "", allowList = new Set() }) {
  return evaluateWorkflowFile({ filePath, source, cwd, upstreamRepo, upstreamOwner, allowList, mode: "check" }).findings;
}

function fixWorkflowFile({
  filePath,
  source,
  cwd,
  upstreamRepo = "",
  upstreamOwner,
  allowList = new Set(),
  runnerFallback = DEFAULT_RUNNER_FALLBACK,
}) {
  const upstreamScope = normalizeUpstreamScope({ upstreamRepo, upstreamOwner });
  if (!upstreamScope.guardExpression) {
    throw new Error("upstreamRepo or upstreamOwner is required when applying fixes.");
  }
  return evaluateWorkflowFile({
    filePath,
    source,
    cwd,
    upstreamRepo: upstreamScope.upstreamRepo,
    upstreamOwner: upstreamScope.upstreamOwner,
    allowList,
    runnerFallback,
    mode: "fix",
  });
}

function evaluateWorkflowFile({
  filePath,
  source,
  cwd,
  upstreamRepo = "",
  upstreamOwner = "",
  allowList = new Set(),
  runnerFallback = DEFAULT_RUNNER_FALLBACK,
  mode = "check",
}) {
  const relativeFile = path.relative(cwd, filePath) || filePath;
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const findings = [];
  const edits = [];
  const workflowModel = parseWorkflowModel(source);
  const jobs = buildJobsFromWorkflowModel(workflowModel, lines);
  const upstreamScope = normalizeUpstreamScope({ upstreamRepo, upstreamOwner });
  const initiallyGatedJobIds = new Set();
  const outputBlockedJobIds = new Set();
  const directlyGatedStepIdsByJob = new Map();

  for (const job of jobs) {
    job.relativeFile = relativeFile;
    job.parsed = job.parsed || workflowModel.jobs.get(job.id) || {
      id: job.id,
      line: job.startLine,
      if: "",
      ifLine: 0,
      hasOwnerGuard: false,
      needs: [],
      needsLine: 0,
      snapshot: false,
      snapshotLine: 0,
      uses: "",
      usesLine: 0,
      secrets: undefined,
      secretsLine: 0,
      secretRefs: [],
      secretNames: [],
      env: undefined,
      envLine: 0,
      outputs: [],
      outputsLine: 0,
      steps: [],
      runsOn: null,
      matrixValues: {},
      matrixExcludes: [],
    };
    job.needs = job.parsed.needs;
    job.hasOwnerGuard = job.hasOwnerGuard || Boolean(job.parsed.hasOwnerGuard);
    job.matrixValues = job.matrixValues || job.parsed.matrixValues || {};
    job.matrixExcludes = job.matrixExcludes || job.parsed.matrixExcludes || [];
    for (let index = 0; index < job.steps.length; index += 1) {
      const step = job.steps[index];
      step.parsed = step.parsed || job.parsed.steps[index] || {
        id: "",
        line: step.startLine,
        if: "",
        ifLine: 0,
        hasOwnerGuard: false,
        uses: "",
        usesLine: 0,
        run: "",
        runLine: 0,
        env: undefined,
        envLine: 0,
        with: undefined,
        withLine: 0,
        name: "",
        nameLine: 0,
        secretNames: [],
        secretRefs: [],
        stepOutputRefs: [],
        publishTriggerLine: 0,
      };
      step.hasOwnerGuard = step.hasOwnerGuard || Boolean(step.parsed.hasOwnerGuard);
    }
    if (job.hasOwnerGuard) {
      initiallyGatedJobIds.add(job.id);
    }
    directlyGatedStepIdsByJob.set(
      job.id,
      new Set(job.steps.filter((step) => step.hasOwnerGuard && step.parsed.id).map((step) => step.parsed.id))
    );
  }

  for (const job of jobs) {
    const runsOn = job.parsed.runsOn;
    if (runsOn) {
      const runnerLine = runsOn.startLine || (runsOn.startIndex + 1);
      const runnerResult = auditRunsOn({ relativeFile, lineNumber: runnerLine, runsOn, guard: job, upstreamScope, allowList });
      findings.push(...runnerResult.findings);
      if (runnerResult.fixKind === "job-guard") {
        initiallyGatedJobIds.add(job.id);
      }
      if (mode === "fix" && runnerResult.fixable) {
        edits.push(
          runnerResult.fixKind === "job-guard"
            ? makeOwnerGuardEdit({ step: null, job, upstreamScope })
            : makeRunsOnEdit({
                lines,
                runsOn,
                upstreamScope,
                runnerFallback,
                preferredFallback: runnerResult.preferredFallback,
                fallbackExpression: runnerResult.fallbackExpression,
              })
        );
      }
    }

    if (job.parsed.snapshot) {
      initiallyGatedJobIds.add(job.id);
      if (!job.hasOwnerGuard) {
        const jobEdit = makeOwnerGuardEdit({ step: null, job, upstreamScope });
        findings.push({
          severity: "warning",
          file: relativeFile,
          line: job.parsed.snapshotLine || job.startLine,
          location: makeKeyLocation(lines, job.parsed.snapshotLine || job.startLine, "snapshot:"),
          rule: RULES.SNAPSHOT_GATE.slug,
          ruleCode: RULES.SNAPSHOT_GATE.code,
          title: RULES.SNAPSHOT_GATE.title,
          message: `Jobs that define snapshot custom-image generation should usually be skipped on forks with an upstream guard.${formatScopeHint(upstreamScope)}`,
          fixable: jobEdit != null,
        });
        if (mode === "fix" && jobEdit) {
          edits.push(jobEdit);
        }
      }
    }

    if (job.parsed.uses && !job.hasOwnerGuard) {
      const inheritedSecrets = job.parsed.secrets === "inherit";
      const passedSecretNames = job.parsed.secretNames || [];
      if (inheritedSecrets || passedSecretNames.length > 0) {
        const jobEdit = makeOwnerGuardEdit({ step: null, job, upstreamScope });
        const detail = inheritedSecrets
          ? "This reusable-workflow caller inherits all caller secrets, which are not available on fork pull requests."
          : `This reusable-workflow caller passes ${passedSecretNames.map((name) => `secrets.${name}`).join(", ")}, which are not available on fork pull requests.`;
        findings.push({
          severity: "warning",
          file: relativeFile,
          line: job.parsed.secretsLine || job.parsed.usesLine || job.startLine,
          location:
            makeSecretLocation(lines, job.parsed.secretRefs || []) ||
            makeKeyLocation(lines, job.parsed.secretsLine || job.parsed.usesLine || job.startLine, job.parsed.secretsLine ? "secrets:" : "uses:"),
          rule: RULES.SECRET_GATE.slug,
          ruleCode: RULES.SECRET_GATE.code,
          title: RULES.SECRET_GATE.title,
          message: `${detail}${formatScopeHint(upstreamScope)}`,
          fixable: jobEdit != null,
        });
        initiallyGatedJobIds.add(job.id);
        if (mode === "fix" && jobEdit) {
          edits.push(jobEdit);
        }
      }
    }

    for (const step of job.steps) {
      const secretNames = step.parsed.secretNames || [];
      if (secretNames.length > 0 && !step.hasOwnerGuard && !job.hasOwnerGuard) {
        const stepEdit = makeOwnerGuardEdit({ step, job, upstreamScope });
        const firstSecretRef = step.parsed.secretRefs && step.parsed.secretRefs.length > 0 ? step.parsed.secretRefs[0] : null;
        findings.push({
          severity: "warning",
          file: relativeFile,
          line: (firstSecretRef && firstSecretRef.line) || step.startLine,
          location:
            makeSecretLocation(lines, step.parsed.secretRefs || []) ||
            makeKeyLocation(lines, (firstSecretRef && firstSecretRef.line) || step.startLine, "secrets."),
          rule: RULES.SECRET_GATE.slug,
          ruleCode: RULES.SECRET_GATE.code,
          title: RULES.SECRET_GATE.title,
          message: `This step references ${secretNames.map((name) => `secrets.${name}`).join(", ")} without an obvious upstream guard. Fork pull requests cannot access normal repository or organization secrets.${formatScopeHint(upstreamScope)}`,
          fixable: stepEdit != null,
        });
        if (step.parsed.id) {
          directlyGatedStepIdsByJob.get(job.id)?.add(step.parsed.id);
        }
        if (mode === "fix" && stepEdit) {
          edits.push(stepEdit);
        }
      }

      const publishTriggerLine = step.parsed.publishTriggerLine || 0;
      const publishTrigger = publishTriggerLine > 0 ? { line: publishTriggerLine } : null;
      if (publishTrigger && !isForkCompatibleGitHubReleaseWrite({ workflowModel, job, step }) && !step.hasOwnerGuard && !job.hasOwnerGuard) {
        const stepEdit = makeOwnerGuardEdit({ step, job, upstreamScope });
        findings.push({
          severity: "warning",
          file: relativeFile,
          line: publishTrigger.line,
          location: makePublishLocation(lines, publishTrigger.line),
          rule: RULES.PUBLISH_GATE.slug,
          ruleCode: RULES.PUBLISH_GATE.code,
          title: RULES.PUBLISH_GATE.title,
          message: `Publishing, deployment, release-write, and cloud-auth steps should usually be skipped on forks with an upstream guard.${formatScopeHint(upstreamScope)}`,
          fixable: stepEdit != null,
        });
        if (step.parsed.id) {
          directlyGatedStepIdsByJob.get(job.id)?.add(step.parsed.id);
        }
        if (mode === "fix" && stepEdit) {
          edits.push(stepEdit);
        }
      }
    }

    if (!job.hasOwnerGuard) {
      const gatedStepIds = directlyGatedStepIdsByJob.get(job.id) || new Set();

      for (const step of job.steps) {
        if (step.hasOwnerGuard || gatedStepIds.size === 0) {
          continue;
        }
        const referencedGatedSteps = (step.parsed.stepOutputRefs || [])
          .filter((reference) => gatedStepIds.has(reference.stepId))
          .map((reference) => reference.stepId);
        if (referencedGatedSteps.length === 0) {
          continue;
        }

        const stepEdit = makeOwnerGuardEdit({ step, job, upstreamScope });
        findings.push({
          severity: "warning",
          file: relativeFile,
          line: step.parsed.stepOutputRefs[0].line || step.startLine,
          location: makeOutputReferenceLocation(lines, step.parsed.stepOutputRefs[0]),
          rule: RULES.OUTPUT_GATE.slug,
          ruleCode: RULES.OUTPUT_GATE.code,
          title: RULES.OUTPUT_GATE.title,
          message: `This step reads outputs from ${[...new Set(referencedGatedSteps)].join(", ")}, which ${referencedGatedSteps.length === 1 ? "is" : "are"} upstream-only or skipped on forks. Output consumers should also be skipped on forks.${formatScopeHint(upstreamScope)}`,
          fixable: stepEdit != null,
        });
        if (mode === "fix" && stepEdit) {
          edits.push(stepEdit);
        }
      }

      for (const output of job.parsed.outputs || []) {
        const referencedGatedSteps = (output.stepOutputRefs || [])
          .filter((reference) => gatedStepIds.has(reference.stepId))
          .map((reference) => reference.stepId);
        if (referencedGatedSteps.length === 0) {
          continue;
        }

        const jobEdit = makeOwnerGuardEdit({ step: null, job, upstreamScope });
        findings.push({
          severity: "warning",
          file: relativeFile,
          line: output.line || job.parsed.outputsLine || job.startLine,
          location:
            makeOutputReferenceLocation(lines, output.stepOutputRefs[0]) ||
            makeKeyLocation(lines, output.line || job.parsed.outputsLine || job.startLine, `${output.name}:`),
          rule: RULES.OUTPUT_GATE.slug,
          ruleCode: RULES.OUTPUT_GATE.code,
          title: RULES.OUTPUT_GATE.title,
          message: `Job output ${output.name} depends on ${[...new Set(referencedGatedSteps)].join(", ")}, which ${referencedGatedSteps.length === 1 ? "is" : "are"} upstream-only or skipped on forks. Jobs exporting those outputs should also be skipped on forks.${formatScopeHint(upstreamScope)}`,
          fixable: jobEdit != null,
        });
        outputBlockedJobIds.add(job.id);
        if (mode === "fix" && jobEdit) {
          edits.push(jobEdit);
        }
      }
    }
  }

  for (const jobId of outputBlockedJobIds) {
    initiallyGatedJobIds.add(jobId);
  }

  const reverseNeeds = buildReverseNeedsGraph(jobs);
  const propagatedNeeds = collectNeedsPropagationFindings({
    jobs,
    reverseNeeds,
    initiallyGatedJobIds,
    upstreamScope,
    lines,
  });
  findings.push(...propagatedNeeds.findings);
  if (mode === "fix") {
    edits.push(...propagatedNeeds.edits);
  }

  const allGatedJobIds = propagatedNeeds.gatedJobIds || new Set(initiallyGatedJobIds);
  for (const workflowOutput of workflowModel.workflowOutputs || []) {
    const referencedGatedJobs = (workflowOutput.jobOutputRefs || [])
      .filter((reference) => allGatedJobIds.has(reference.jobId))
      .map((reference) => reference.jobId);
    if (referencedGatedJobs.length === 0) {
      continue;
    }

    findings.push({
      severity: "warning",
      file: relativeFile,
      line: workflowOutput.line || 1,
      location:
        makeJobOutputReferenceLocation(lines, workflowOutput.jobOutputRefs[0]) ||
        makeKeyLocation(lines, workflowOutput.line || 1, `${workflowOutput.name}:`),
      rule: RULES.OUTPUT_GATE.slug,
      ruleCode: RULES.OUTPUT_GATE.code,
      title: RULES.OUTPUT_GATE.title,
      message: `Reusable workflow output ${workflowOutput.name} depends on ${[...new Set(referencedGatedJobs)].join(", ")}, which ${referencedGatedJobs.length === 1 ? "is" : "are"} upstream-only or skipped on forks. Workflow outputs should not depend on producers that only run upstream.${formatScopeHint(upstreamScope)}`,
      fixable: false,
    });
  }

  const normalizedEdits = dedupeEdits(edits).filter(Boolean);
  const fixedLines = applyEdits(lines, normalizedEdits);

  return {
    relativeFile,
    findings: dedupeFindings(findings),
    edits: normalizedEdits.map((edit) => ({
      start: edit.start,
      end: edit.end,
      title: edit.title,
      replacement: edit.replacement,
      key: edit.key,
    })),
    changes: normalizedEdits.map((edit) => ({
      file: relativeFile,
      line: edit.start + 1,
      start: edit.start,
      end: edit.end,
      title: edit.title,
      replacement: edit.replacement,
    })),
    fixedSource: fixedLines.join(lineEnding),
  };
}

function buildJobsFromWorkflowModel(workflowModel, lines) {
  if (!workflowModel || !(workflowModel.jobs instanceof Map) || workflowModel.jobs.size === 0) {
    return [];
  }

  const parsedJobs = [...workflowModel.jobs.values()].sort((left, right) => left.line - right.line);
  return parsedJobs.map((parsedJob, index) => {
    const startLine = parsedJob.line || 1;
    const startIndex = Math.max(startLine - 1, 0);
    const parsedEndLine = parsedJob.endLine || startLine;
    const endIndex = Math.max(Math.min(parsedEndLine - 1, lines.length - 1), startIndex);
    const bodyIndent = countIndent(lines[startIndex] || "") + 2;
    const steps = (parsedJob.steps || []).map((parsedStep) => {
      const stepStartLine = parsedStep.line || startLine;
      const stepStartIndex = Math.max(stepStartLine - 1, 0);
      const stepEndIndex = Math.max(Math.min((parsedStep.endLine || stepStartLine) - 1, endIndex), stepStartIndex);
      return {
        startIndex: stepStartIndex,
        startLine: stepStartLine,
        endIndex: stepEndIndex,
        endLine: stepEndIndex + 1,
        indent: countIndent(lines[stepStartIndex] || ""),
        hasOwnerGuard: Boolean(parsedStep.hasOwnerGuard),
        parsed: parsedStep,
      };
    });

    return {
      id: parsedJob.id,
      startIndex,
      startLine,
      endIndex,
      endLine: endIndex + 1,
      bodyIndent,
      hasOwnerGuard: Boolean(parsedJob.hasOwnerGuard),
      matrixValues: parsedJob.matrixValues || {},
      matrixExcludes: parsedJob.matrixExcludes || [],
      steps,
      parsed: parsedJob,
    };
  });
}

function parseWorkflowModel(source) {
  const lineCounter = new YAML.LineCounter();
  let document;
  try {
    document = YAML.parseDocument(source, {
      lineCounter,
      merge: true,
      uniqueKeys: false,
    });
  } catch {
    return { env: undefined, events: new Set(), jobs: new Map(), workflowOutputs: [] };
  }

  if (document.errors && document.errors.length > 0) {
    return { env: undefined, events: new Set(), jobs: new Map(), workflowOutputs: [] };
  }

  const env = yamlNodeToJSON(document.get("env", true));
  const events = parseWorkflowEvents(document);
  const jobsNode = document.get("jobs", true);
  const jobs = new Map();
  const workflowOutputs = parseWorkflowCallOutputs(document, lineCounter);

  if (jobsNode && typeof jobsNode === "object" && Array.isArray(jobsNode.items)) {
    for (const jobPair of jobsNode.items) {
      const jobId = yamlNodeToString(jobPair.key);
      if (!jobId || !jobPair.value || !Array.isArray(jobPair.value.items)) {
        continue;
      }

      const needsPair = getYamlMapPair(jobPair.value, "needs");
      const snapshotPair = getYamlMapPair(jobPair.value, "snapshot");
      const usesPair = getYamlMapPair(jobPair.value, "uses");
      const secretsPair = getYamlMapPair(jobPair.value, "secrets");
      const ifPair = getYamlMapPair(jobPair.value, "if");
      const envPair = getYamlMapPair(jobPair.value, "env");
      const outputsPair = getYamlMapPair(jobPair.value, "outputs");
      const stepsPair = getYamlMapPair(jobPair.value, "steps");
      const runsOnPair = getYamlMapPair(jobPair.value, "runs-on");
      const strategyPair = getYamlMapPair(jobPair.value, "strategy");

      const ifValue = yamlNodeToString(ifPair && ifPair.value);
      const usesValue = yamlNodeToString(usesPair && usesPair.value);
      const envValue = yamlNodeToJSON(envPair && envPair.value);
      const secretsValue = yamlNodeToJSON(secretsPair && secretsPair.value);
      const outputs = parseJobOutputs(outputsPair && outputsPair.value, lineCounter);
      const steps = parseJobSteps(stepsPair && stepsPair.value, lineCounter);
      const runsOn = parseRunsOnNode(runsOnPair, lineCounter, source);
      const matrix = parseMatrixConfig(strategyPair && strategyPair.value);

      jobs.set(jobId, {
        id: jobId,
        line: yamlNodeLine(lineCounter, jobPair.key),
        endLine: yamlNodeEndLine(lineCounter, jobPair.value) || yamlNodeLine(lineCounter, jobPair.key),
        needs: normalizeNeedsNode(needsPair && needsPair.value),
        needsLine: yamlNodeLine(lineCounter, needsPair && needsPair.key),
        snapshot: Boolean(snapshotPair),
        snapshotLine: yamlNodeLine(lineCounter, snapshotPair && snapshotPair.key),
        if: ifValue,
        ifLine: yamlNodeLine(lineCounter, ifPair && ifPair.key),
        hasOwnerGuard: containsOwnerGuard(ifValue),
        uses: usesValue,
        usesLine: yamlNodeLine(lineCounter, usesPair && usesPair.key),
        secrets: secretsValue,
        secretsLine: yamlNodeLine(lineCounter, secretsPair && secretsPair.key),
        secretRefs: extractSecretReferencesFromValue(secretsValue, yamlNodeLine(lineCounter, secretsPair && secretsPair.key)),
        secretNames: extractSecretNamesFromValue(secretsValue),
        env: envValue,
        envLine: yamlNodeLine(lineCounter, envPair && envPair.key),
        outputs,
        outputsLine: yamlNodeLine(lineCounter, outputsPair && outputsPair.key),
        steps,
        runsOn,
        matrixValues: matrix.values,
        matrixExcludes: matrix.excludes,
      });
    }
  }

  return { env, events, jobs, workflowOutputs };
}

function parseWorkflowEvents(document) {
  const onNode = document.get("on", true);
  const events = new Set();
  const onValue = yamlNodeToJSON(onNode);

  if (typeof onValue === "string" && onValue) {
    events.add(onValue);
  } else if (Array.isArray(onValue)) {
    for (const eventName of onValue) {
      if (typeof eventName === "string" && eventName) {
        events.add(eventName);
      }
    }
  } else if (onValue && typeof onValue === "object") {
    for (const eventName of Object.keys(onValue)) {
      events.add(eventName);
    }
  }

  return events;
}

function workflowHasPullRequestEvent(events) {
  if (!events || events.size === 0) {
    return true;
  }

  for (const eventName of events) {
    if (PULL_REQUEST_EVENTS.has(eventName)) {
      return true;
    }
  }
  return false;
}

function isForkCompatibleGitHubReleaseWrite({ workflowModel, job, step }) {
  if (!step.parsed.run || !GITHUB_RELEASE_WRITE_PATTERN.test(step.parsed.run)) {
    return false;
  }
  if (workflowHasPullRequestEvent(workflowModel.events)) {
    return false;
  }

  return usesCurrentRepositoryGitHubToken({
    workflowEnv: workflowModel.env,
    jobEnv: job.parsed.env,
    stepEnv: step.parsed.env,
  });
}

function usesCurrentRepositoryGitHubToken({ workflowEnv, jobEnv, stepEnv }) {
  const env = {
    ...normalizeEnvMap(workflowEnv),
    ...normalizeEnvMap(jobEnv),
    ...normalizeEnvMap(stepEnv),
  };
  const tokenValue = Object.prototype.hasOwnProperty.call(env, "GH_TOKEN") ? env.GH_TOKEN : env.GITHUB_TOKEN;
  return /\b(secrets\.GITHUB_TOKEN|github\.token)\b/i.test(String(tokenValue || ""));
}

function normalizeEnvMap(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return {};
  }
  return env;
}

function parseWorkflowCallOutputs(document, lineCounter) {
  const outputsNode = document.getIn(["on", "workflow_call", "outputs"], true);
  if (!outputsNode || !Array.isArray(outputsNode.items)) {
    return [];
  }

  const outputs = [];
  for (const outputPair of outputsNode.items) {
    const valuePair = getYamlMapPair(outputPair.value, "value");
    const value = yamlNodeToString(valuePair && valuePair.value);
    outputs.push({
      name: yamlNodeToString(outputPair.key),
      line: yamlNodeLine(lineCounter, (valuePair && valuePair.key) || outputPair.key),
      value,
      jobOutputRefs: extractJobOutputReferencesFromValue(value, yamlNodeLine(lineCounter, (valuePair && valuePair.key) || outputPair.key)),
    });
  }

  return outputs;
}

function parseJobOutputs(outputsNode, lineCounter) {
  if (!outputsNode || !Array.isArray(outputsNode.items)) {
    return [];
  }

  return outputsNode.items.map((outputPair) => {
    const line = yamlNodeLine(lineCounter, outputPair.key);
    const value = yamlNodeToString(outputPair.value);
    return {
      name: yamlNodeToString(outputPair.key),
      line,
      value,
      stepOutputRefs: extractStepOutputReferencesFromValue(value, line),
    };
  });
}

function parseJobSteps(stepsNode, lineCounter) {
  if (!stepsNode || !Array.isArray(stepsNode.items)) {
    return [];
  }

  return stepsNode.items.map((stepNode) => {
    const idPair = getYamlMapPair(stepNode, "id");
    const ifPair = getYamlMapPair(stepNode, "if");
    const usesPair = getYamlMapPair(stepNode, "uses");
    const runPair = getYamlMapPair(stepNode, "run");
    const envPair = getYamlMapPair(stepNode, "env");
    const withPair = getYamlMapPair(stepNode, "with");
    const namePair = getYamlMapPair(stepNode, "name");

    const ifValue = yamlNodeToString(ifPair && ifPair.value);
    const runValue = yamlNodeToString(runPair && runPair.value);
    const usesValue = yamlNodeToString(usesPair && usesPair.value);
    const envValue = yamlNodeToJSON(envPair && envPair.value);
    const withValue = yamlNodeToJSON(withPair && withPair.value);
    const nameValue = yamlNodeToString(namePair && namePair.value);
    const stepLine = yamlNodeLine(lineCounter, stepNode);
    const secretRefs = [
      ...extractSecretReferencesFromValue(ifValue, yamlNodeLine(lineCounter, ifPair && ifPair.key)),
      ...extractSecretReferencesFromValue(runValue, yamlNodeLine(lineCounter, runPair && runPair.key)),
      ...extractSecretReferencesFromValue(envValue, yamlNodeLine(lineCounter, envPair && envPair.key)),
      ...extractSecretReferencesFromValue(withValue, yamlNodeLine(lineCounter, withPair && withPair.key)),
      ...extractSecretReferencesFromValue(nameValue, yamlNodeLine(lineCounter, namePair && namePair.key)),
    ];

    return {
      id: yamlNodeToString(idPair && idPair.value),
      line: stepLine,
      endLine: yamlNodeEndLine(lineCounter, stepNode) || stepLine,
      if: ifValue,
      ifLine: yamlNodeLine(lineCounter, ifPair && ifPair.key),
      hasOwnerGuard: containsOwnerGuard(ifValue),
      uses: usesValue,
      usesLine: yamlNodeLine(lineCounter, usesPair && usesPair.key),
      run: runValue,
      runLine: yamlNodeLine(lineCounter, runPair && runPair.key),
      env: envValue,
      envLine: yamlNodeLine(lineCounter, envPair && envPair.key),
      with: withValue,
      withLine: yamlNodeLine(lineCounter, withPair && withPair.key),
      name: nameValue,
      nameLine: yamlNodeLine(lineCounter, namePair && namePair.key),
      secretNames: [...new Set(secretRefs.map((ref) => ref.name))],
      secretRefs,
      stepOutputRefs: [
        ...extractStepOutputReferencesFromValue(ifValue, yamlNodeLine(lineCounter, ifPair && ifPair.key)),
        ...extractStepOutputReferencesFromValue(runValue, yamlNodeLine(lineCounter, runPair && runPair.key)),
        ...extractStepOutputReferencesFromValue(envValue, yamlNodeLine(lineCounter, envPair && envPair.key)),
        ...extractStepOutputReferencesFromValue(withValue, yamlNodeLine(lineCounter, withPair && withPair.key)),
      ],
      publishTriggerLine: detectPublishTriggerInParsedStep({
        uses: usesValue,
        usesLine: yamlNodeLine(lineCounter, usesPair && usesPair.key),
        run: runValue,
        runLine: yamlNodeLine(lineCounter, runPair && runPair.key),
      }),
    };
  });
}

function parseRunsOnNode(runsOnPair, lineCounter, source) {
  if (!runsOnPair || !runsOnPair.value) {
    return null;
  }

  const value = yamlNodeToJSON(runsOnPair.value);
  const keyPosition = yamlNodePosition(lineCounter, runsOnPair.key);
  const startLine = keyPosition.line;
  const endLine = yamlNodeEndLine(lineCounter, runsOnPair.value) || startLine;
  const location = makeLocation(startLine, keyPosition.column || 1, "runs-on".length);

  if (typeof value === "string") {
    return {
      startLine,
      endLine,
      location,
      raw: value,
      labels: parseRunnerLabels(value),
      group: "",
      usesGroup: false,
      isExpression: value.includes("${{"),
      inline: startLine === endLine,
      text: yamlNodeText(source, runsOnPair.value),
    };
  }

  if (Array.isArray(value)) {
    const labels = value.map((entry) => String(entry).trim()).filter(Boolean);
    return {
      startLine,
      endLine,
      location,
      raw: yamlNodeText(source, runsOnPair.value).trim(),
      labels,
      group: "",
      usesGroup: false,
      isExpression: labels.some((label) => label.includes("${{")),
      inline: false,
      text: yamlNodeText(source, runsOnPair.value),
    };
  }

  if (value && typeof value === "object") {
    const group = typeof value.group === "string" ? value.group.trim() : "";
    const labels = Array.isArray(value.labels)
      ? value.labels.map((entry) => String(entry).trim()).filter(Boolean)
      : typeof value.labels === "string"
        ? parseRunnerLabels(value.labels)
        : [];
    return {
      startLine,
      endLine,
      location,
      raw: yamlNodeText(source, runsOnPair.value).trim(),
      labels,
      group,
      usesGroup: Boolean(group),
      isExpression: group.includes("${{") || labels.some((label) => label.includes("${{")),
      inline: startLine === endLine,
      text: yamlNodeText(source, runsOnPair.value),
    };
  }

  return null;
}

function parseMatrixConfig(strategyNode) {
  const empty = { values: {}, excludes: [] };
  if (!strategyNode) {
    return empty;
  }

  const strategy = yamlNodeToJSON(strategyNode);
  const matrix = strategy && typeof strategy === "object" ? strategy.matrix : undefined;
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    return empty;
  }

  const values = new Map();
  for (const [key, rawValue] of Object.entries(matrix)) {
    if (key === "exclude" || key === "include") {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const entry of rawValue) {
        addMatrixValue(values, key, entry);
      }
      continue;
    }
    addMatrixValue(values, key, rawValue);
  }

  if (Array.isArray(matrix.include)) {
    for (const includeEntry of matrix.include) {
      if (!includeEntry || typeof includeEntry !== "object" || Array.isArray(includeEntry)) {
        continue;
      }
      for (const [key, rawValue] of Object.entries(includeEntry)) {
        addMatrixValue(values, key, rawValue);
      }
    }
  }

  const excludes = Array.isArray(matrix.exclude)
    ? matrix.exclude
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => normalizeMatrixObject(entry))
        .filter((entry) => Object.keys(entry).length > 0)
    : [];

  return {
    values: Object.fromEntries(values),
    excludes,
  };
}

function getYamlMapPair(node, key) {
  if (!node || !Array.isArray(node.items)) {
    return null;
  }
  return node.items.find((item) => yamlNodeToString(item.key) === key) || null;
}

function yamlNodeToString(node) {
  if (!node) {
    return "";
  }
  const value = typeof node.toJSON === "function" ? node.toJSON() : node;
  return typeof value === "string" ? value : "";
}

function yamlNodeToJSON(node) {
  if (!node || typeof node.toJSON !== "function") {
    return undefined;
  }
  return node.toJSON();
}

function yamlNodeLine(lineCounter, node) {
  if (!node || !Array.isArray(node.range) || typeof node.range[0] !== "number") {
    return 0;
  }
  const position = lineCounter.linePos(node.range[0]);
  return position && typeof position.line === "number" ? position.line : 0;
}

function yamlNodePosition(lineCounter, node) {
  if (!node || !Array.isArray(node.range) || typeof node.range[0] !== "number") {
    return { line: 0, column: 0 };
  }
  const position = lineCounter.linePos(node.range[0]);
  return {
    line: position && typeof position.line === "number" ? position.line : 0,
    column: position && typeof position.col === "number" ? position.col : 0,
  };
}

function yamlNodeEndLine(lineCounter, node) {
  if (!node || !Array.isArray(node.range) || typeof node.range[1] !== "number") {
    return 0;
  }
  const offset = Math.max(node.range[1] - 1, node.range[0]);
  const position = lineCounter.linePos(offset);
  return position && typeof position.line === "number" ? position.line : 0;
}

function yamlNodeText(source, node) {
  if (!node || !Array.isArray(node.range) || typeof node.range[0] !== "number" || typeof node.range[1] !== "number") {
    return "";
  }
  return String(source).slice(node.range[0], node.range[1]);
}

function normalizeNeedsNode(node) {
  if (!node) {
    return [];
  }

  const value = yamlNodeToJSON(node);
  if (typeof value === "string" && value) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string" && entry);
  }
  return [];
}

function containsOwnerGuard(value) {
  return OWNER_GUARD_PATTERNS.some((pattern) => pattern.test(String(value || "")));
}

function collectStringValues(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectStringValues(entry));
  }
  return [];
}

function extractReferencesFromValue(value, line, pattern, mapMatch) {
  const refs = [];
  const seen = new Set();

  for (const text of collectStringValues(value)) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      const ref = mapMatch(match, line);
      const key = JSON.stringify(ref);
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(ref);
      }
    }
  }

  return refs;
}

function extractStepOutputReferencesFromValue(value, line = 0) {
  return extractReferencesFromValue(value, line, STEP_OUTPUT_REFERENCE_PATTERN, (match, refLine) => ({
    stepId: match[1],
    outputName: match[2],
    line: refLine,
  }));
}

function extractJobOutputReferencesFromValue(value, line = 0) {
  return extractReferencesFromValue(value, line, JOB_OUTPUT_REFERENCE_PATTERN, (match, refLine) => ({
    jobId: match[1],
    outputName: match[2],
    line: refLine,
  }));
}

function extractNeedsOutputReferencesFromValue(value, line = 0) {
  return extractReferencesFromValue(value, line, NEEDS_OUTPUT_REFERENCE_PATTERN, (match, refLine) => ({
    jobId: match[1],
    outputName: match[2],
    line: refLine,
  }));
}

function extractSecretNamesFromValue(value) {
  const names = new Set();
  for (const text of collectStringValues(value)) {
    for (const name of extractSecretNames(text)) {
      names.add(name);
    }
  }
  return [...names];
}

function extractSecretReferencesFromValue(value, line = 0) {
  const refs = [];
  const seen = new Set();
  for (const text of collectStringValues(value)) {
    for (const name of extractSecretNames(text)) {
      const key = `${name}:${line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push({ name, line });
    }
  }
  return refs;
}

function detectPublishTriggerInParsedStep({ uses = "", usesLine = 0, run = "", runLine = 0 }) {
  if (uses && PUBLISH_USES_PATTERNS.some((pattern) => pattern.test(uses))) {
    return usesLine;
  }
  if (run && PUBLISH_RUN_PATTERNS.some((pattern) => pattern.test(run))) {
    return runLine;
  }
  return 0;
}

function makeLocation(line, column, length = 1) {
  return {
    line: Math.max(line || 1, 1),
    column: Math.max(column || 1, 1),
    length: Math.max(length || 1, 1),
  };
}

function findPatternLocation(lineText, line, pattern, fallbackColumn = 1, fallbackLength = 1) {
  const text = String(lineText || "");
  const regex = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags) : null;
  const match = regex ? text.match(regex) : null;
  if (match && match.index != null) {
    return makeLocation(line, match.index + 1, match[0].length);
  }
  return makeLocation(line, fallbackColumn, fallbackLength);
}

function makeKeyLocation(lines, line, keyText) {
  const lineText = lines[Math.max((line || 1) - 1, 0)] || "";
  const index = lineText.indexOf(keyText);
  return makeLocation(line, index === -1 ? firstVisibleColumn(lineText) : index + 1, keyText.replace(/:$/, "").length || 1);
}

function runsOnLocation(runsOn, line) {
  if (runsOn && runsOn.location) {
    return runsOn.location;
  }
  return makeLocation(line, 1, "runs-on".length);
}

function makeSecretLocation(lines, refs) {
  const reference = Array.isArray(refs) ? refs[0] : null;
  if (!reference) {
    return null;
  }
  return findPatternLocation(
    lines[Math.max(reference.line - 1, 0)] || "",
    reference.line,
    new RegExp(`secrets\\.${reference.name}\\b`),
    1,
    `secrets.${reference.name}`.length
  );
}

function makePublishLocation(lines, line) {
  return findPatternLocation(
    lines[Math.max(line - 1, 0)] || "",
    line,
    /\b(npm\s+publish|twine\s+upload|docker\s+push|gh\s+release\s+(create|upload|edit|delete)|uses:|run:)\b/i
  );
}

function makeOutputReferenceLocation(lines, reference) {
  if (!reference) {
    return null;
  }
  return findPatternLocation(
    lines[Math.max(reference.line - 1, 0)] || "",
    reference.line,
    new RegExp(`steps\\.${reference.stepId}\\.outputs\\.${reference.outputName}\\b`),
    1,
    `steps.${reference.stepId}.outputs.${reference.outputName}`.length
  );
}

function makeJobOutputReferenceLocation(lines, reference) {
  if (!reference) {
    return null;
  }
  return findPatternLocation(
    lines[Math.max(reference.line - 1, 0)] || "",
    reference.line,
    new RegExp(`jobs\\.${reference.jobId}\\.outputs\\.${reference.outputName}\\b`),
    1,
    `jobs.${reference.jobId}.outputs.${reference.outputName}`.length
  );
}

function buildReverseNeedsGraph(jobs) {
  const reverseNeeds = new Map();
  for (const job of jobs) {
    for (const need of job.needs || []) {
      if (!reverseNeeds.has(need)) {
        reverseNeeds.set(need, new Set());
      }
      reverseNeeds.get(need).add(job.id);
    }
  }
  return reverseNeeds;
}

function collectNeedsPropagationFindings({ jobs, reverseNeeds, initiallyGatedJobIds, upstreamScope, lines }) {
  const visited = new Set(initiallyGatedJobIds);
  const queue = [...initiallyGatedJobIds];
  const findings = [];
  const edits = [];

  while (queue.length > 0) {
    const gatedJobId = queue.shift();
    const dependents = reverseNeeds.get(gatedJobId);
    if (!dependents) {
      continue;
    }

    for (const dependentId of dependents) {
      if (visited.has(dependentId)) {
        continue;
      }
      visited.add(dependentId);
      queue.push(dependentId);

      const job = jobs.find((entry) => entry.id === dependentId);
      if (!job) {
        continue;
      }

      if (job.hasOwnerGuard || !jobBypassesSkippedNeeds(job)) {
        continue;
      }

      const gatedNeeds = (job.needs || []).filter((need) => visited.has(need));
      const jobEdit = makeOwnerGuardEdit({ step: null, job, upstreamScope });
      findings.push({
        severity: "warning",
        file: job.relativeFile,
        line: job.parsed.needsLine || job.startLine,
        location: makeKeyLocation(lines || [], job.parsed.needsLine || job.startLine, "needs:"),
        rule: RULES.NEEDS_GATE.slug,
        ruleCode: RULES.NEEDS_GATE.code,
        title: RULES.NEEDS_GATE.title,
        message: `This job depends on ${gatedNeeds.join(", ")}, which ${gatedNeeds.length === 1 ? "is" : "are"} upstream-only or skipped on forks, but its job-level condition can bypass the default needs skip behavior.${formatScopeHint(upstreamScope)}`,
        fixable: jobEdit != null,
      });
      if (jobEdit) {
        edits.push(jobEdit);
      }
    }
  }

  return { findings, edits, gatedJobIds: visited };
}

function jobBypassesSkippedNeeds(job) {
  const condition = String(job.parsed && job.parsed.if ? job.parsed.if : "").trim();
  if (!condition) {
    return false;
  }
  return /\balways\s*\(/.test(condition);
}

function addMatrixValue(values, key, value) {
  if (!values.has(key)) {
    values.set(key, []);
  }
  if (Array.isArray(value)) {
    const normalizedArray = value.map((item) => normalizeYamlValue(item)).filter((item) => item !== "");
    if (normalizedArray.length === 0) {
      return;
    }
    const signature = JSON.stringify(normalizedArray);
    if (!values.get(key).some((entry) => Array.isArray(entry) && JSON.stringify(entry) === signature)) {
      values.get(key).push(normalizedArray);
    }
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const normalizedObject = normalizeMatrixObject(value);
    if (Object.keys(normalizedObject).length === 0) {
      return;
    }
    const signature = JSON.stringify(normalizedObject);
    if (!values.get(key).some((entry) => typeof entry === "object" && JSON.stringify(entry) === signature)) {
      values.get(key).push(normalizedObject);
    }
    return;
  }

  const normalized = cleanYamlScalar(value);
  if (!normalized) {
    return;
  }
  if (!values.get(key).includes(normalized)) {
    values.get(key).push(normalized);
  }
}

function normalizeMatrixObject(value) {
  return Object.fromEntries(
    Object.entries(value)
      .map(([subKey, subValue]) => {
        if (Array.isArray(subValue)) {
          return [subKey, subValue.map((item) => normalizeYamlValue(item)).filter((item) => item !== "")];
        }
        if (subValue && typeof subValue === "object" && !Array.isArray(subValue)) {
          return [subKey, normalizeMatrixObject(subValue)];
        }
        return [subKey, normalizeYamlValue(subValue)];
      })
      .filter(([, subValue]) => {
        if (Array.isArray(subValue)) {
          return subValue.length > 0;
        }
        if (subValue && typeof subValue === "object" && !Array.isArray(subValue)) {
          return Object.keys(subValue).length > 0;
        }
        return Boolean(subValue);
      })
  );
}

function parseRunnerLabels(value) {
  const trimmed = String(value).trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map(cleanYamlScalar)
      .filter(Boolean);
  }
  return [cleanYamlScalar(trimmed)].filter(Boolean);
}

function auditRunsOn({ relativeFile, lineNumber, runsOn, guard, upstreamScope, allowList }) {
  const location = runsOnLocation(runsOn, lineNumber);
  if (runsOn.usesGroup) {
    if (guard?.hasOwnerGuard) {
      return { fixable: false, findings: [] };
    }
    return {
      fixable: Boolean(upstreamScope.guardExpression),
      fixKind: "job-guard",
      findings: [
        {
          severity: "error",
          file: relativeFile,
          line: lineNumber,
          location,
          rule: RULES.RUNNER_LABEL.slug,
          ruleCode: RULES.RUNNER_LABEL.code,
          title: "Private runner is not fork-friendly",
          message: `Runner group${runsOn.group ? ` ${runsOn.group}` : ""} requires private runner access. Forks should skip the whole job instead of depending on a private runner group.${formatScopeHint(upstreamScope)}`,
          fixable: Boolean(upstreamScope.guardExpression),
        },
      ],
    };
  }

  if (runsOn.isExpression) {
    const raw = runsOn.raw;
    const expression = stripExpressionDelimiters(raw);
    const hasOwnerExpression = OWNER_GUARD_PATTERNS.some((pattern) => pattern.test(raw));
    const hasFallback = /&&/.test(raw) && /\|\|/.test(raw);
    const matrixResolution = resolveMatrixRunnerExpression(raw, guard?.matrixValues || {}, guard?.matrixExcludes || [], allowList);
    const expressionFallback = buildMatrixFallbackExpression(expression, guard?.matrixValues || {}, guard?.matrixExcludes || [], allowList);
    if (guard?.hasOwnerGuard) {
      return { fixable: false, findings: [] };
    }
    if (matrixResolution.isKnownPublic) {
      return { fixable: false, findings: [] };
    }
    if (matrixResolution.hasSelfHosted) {
      return {
        fixable: Boolean(upstreamScope.guardExpression),
        fixKind: "job-guard",
        findings: [
          {
            severity: "warning",
            file: relativeFile,
            line: lineNumber,
            location,
            rule: RULES.RUNNER_EXPRESSION.slug,
            ruleCode: RULES.RUNNER_EXPRESSION.code,
            title: "Dynamic runner expression needs a fork fallback",
            message: `Dynamic runs-on expressions that resolve to self-hosted runners should skip the whole job on forks.${formatScopeHint(upstreamScope)}`,
            fixable: Boolean(upstreamScope.guardExpression),
          },
        ],
      };
    }
    if (!hasOwnerExpression || !hasFallback) {
      const why = matrixResolution.referencedKeys && matrixResolution.referencedKeys.length > 0
        ? `Dynamic runs-on expression ${raw} depends on matrix values that could not be fully resolved to known public runners.`
        : `Dynamic runs-on expression ${raw} cannot be locally resolved to a known public GitHub-hosted runner.`;
      return {
        fixable: Boolean(upstreamScope.guardExpression),
        fixKind: "runs-on-fallback",
        fallbackExpression: expressionFallback,
        findings: [
          {
            severity: "warning",
            file: relativeFile,
            line: lineNumber,
            location,
            rule: RULES.RUNNER_EXPRESSION.slug,
            ruleCode: RULES.RUNNER_EXPRESSION.code,
            title: "Dynamic runner expression needs a fork fallback",
            message: `${why} Dynamic expressions should clearly choose a known free public GitHub-hosted runner when the workflow runs outside the upstream repository.${formatScopeHint(upstreamScope)}`,
            fixable: Boolean(upstreamScope.guardExpression),
          },
        ],
      };
    }
    return { fixable: false, findings: [] };
  }

  const privateLabels = runsOn.labels.filter((label) => !isPublicRunner(label, allowList));
  if (privateLabels.length === 0 || guard?.hasOwnerGuard) {
    return { fixable: false, findings: [] };
  }

  const selfHosted = hasSelfHostedRunner(runsOn.labels);
  const preferredFallback = inferEquivalentPublicRunner(privateLabels);

  return {
    fixable: Boolean(upstreamScope.guardExpression),
    fixKind: selfHosted ? "job-guard" : "runs-on-fallback",
    preferredFallback,
    findings: [
      {
        severity: "error",
        file: relativeFile,
        line: lineNumber,
        location,
        rule: RULES.RUNNER_LABEL.slug,
        ruleCode: RULES.RUNNER_LABEL.code,
        title: "Private runner is not fork-friendly",
        message: selfHosted
          ? `Runner label${privateLabels.length === 1 ? "" : "s"} ${privateLabels.join(", ")} ${privateLabels.length === 1 ? "is" : "are"} self-hosted or tied to self-hosted execution. Forks should skip the whole job instead of expecting equivalent infrastructure.${formatScopeHint(upstreamScope)}`
          : `Runner label${privateLabels.length === 1 ? "" : "s"} ${privateLabels.join(", ")} ${privateLabels.length === 1 ? "is" : "are"} not known free public GitHub-hosted runners. Add an upstream guard or use an equivalent free public runner for forks.${formatScopeHint(upstreamScope)}`,
        fixable: Boolean(upstreamScope.guardExpression),
      },
    ],
  };
}

function makeRunsOnEdit({ lines, runsOn, upstreamScope, runnerFallback, preferredFallback = "", fallbackExpression = "" }) {
  const startIndex = typeof runsOn.startIndex === "number" ? runsOn.startIndex : Math.max((runsOn.startLine || 1) - 1, 0);
  const endIndexInclusive = typeof runsOn.endIndex === "number" ? runsOn.endIndex : Math.max((runsOn.endLine || runsOn.startLine || 1) - 1, startIndex);
  const indent =
    typeof runsOn.indent === "number"
      ? runsOn.indent
      : countIndent(lines[startIndex] || "");
  const originalRunner = runsOn.isExpression
    ? `(${stripExpressionDelimiters(runsOn.raw)})`
    : runnerExpressionValue(runsOn.labels);
  const fallbackRunner =
    fallbackExpression ||
    runnerExpressionValue(
      [preferredFallback || runnerFallback || DEFAULT_RUNNER_FALLBACK],
      !runsOn.isExpression && runsOn.labels.length > 1
    );
  const expression = `\${{ ${upstreamScope.guardExpression} && ${originalRunner} || ${fallbackRunner} }}`;
  return {
    start: startIndex,
    end: endIndexInclusive + 1,
    replacement: [`${" ".repeat(indent)}runs-on: ${expression}`],
    title: "Add fork runner fallback",
    key: `replace:${startIndex}:${endIndexInclusive}:runs-on`,
  };
}

function resolveMatrixRunnerExpression(raw, matrixValues, matrixExcludes, allowList) {
  const expression = stripExpressionDelimiters(raw);
  const simpleReferences = extractMatrixReferences(expression);

  if (simpleReferences.length === 0) {
    return { isKnownPublic: false };
  }

  const resolvedValues = [];
  for (const reference of simpleReferences) {
    const values = resolveMatrixReferenceValues(reference, matrixValues, matrixExcludes);
    if (values.length === 0) {
      return { isKnownPublic: false };
    }
    resolvedValues.push(...values);
  }

  return {
    isKnownPublic: resolvedValues.length > 0 && resolvedValues.every((value) => isPublicRunnerValue(value, allowList)),
    hasSelfHosted: hasSelfHostedRunner(resolvedValues),
    hasGroup: resolvedValues.some((value) => typeof value === "object" && value && value.group),
    referencedKeys: simpleReferences,
    resolvedValues,
  };
}

function hasSelfHostedRunner(labels) {
  return labels.some((label) => {
    if (Array.isArray(label)) {
      return hasSelfHostedRunner(label);
    }
    if (typeof label === "object" && label) {
      const labelValues = Array.isArray(label.labels)
        ? label.labels
        : String(label.labels || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
      return labelValues.some((item) => item.toLowerCase() === "self-hosted");
    }
    return String(label).trim().toLowerCase() === "self-hosted";
  });
}

function inferEquivalentPublicRunner(labels) {
  const normalized = labels.map((label) => String(label).trim().toLowerCase());
  if (normalized.some((label) => label.startsWith("macos-") || label.includes("macos"))) {
    return "macos-latest";
  }
  if (normalized.some((label) => label.startsWith("windows-") || label.includes("windows"))) {
    return "windows-latest";
  }
  if (normalized.some((label) => label.startsWith("ubuntu-") || label.includes("linux"))) {
    return "ubuntu-latest";
  }
  return "";
}

function buildMatrixFallbackExpression(expression, matrixValues, matrixExcludes, allowList) {
  const directKeyMatch = expression.match(/^matrix\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (directKeyMatch) {
    const key = directKeyMatch[1];
    const values = Array.isArray(matrixValues[key]) ? matrixValues[key] : [];
    return buildMatrixScalarFallbackExpression(`matrix.${key}`, values, allowList);
  }

  if (/^matrix\./.test(expression) && !/\|\|/.test(expression)) {
    const values = resolveMatrixReferenceValues(expression, matrixValues, matrixExcludes);
    return buildMatrixScalarFallbackExpression(expression, values, allowList);
  }

  const fallbackPairMatch = expression.match(/^matrix\.([A-Za-z_][A-Za-z0-9_]*)\s*\|\|\s*matrix\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (fallbackPairMatch) {
    const primaryKey = fallbackPairMatch[1];
    const secondaryKey = fallbackPairMatch[2];
    const primaryValues = Array.isArray(matrixValues[primaryKey]) ? matrixValues[primaryKey] : [];
    const secondaryValues = Array.isArray(matrixValues[secondaryKey]) ? matrixValues[secondaryKey] : [];
    const primaryHasPrivateObject = primaryValues.some((value) => typeof value === "object" && value);
    if (primaryHasPrivateObject) {
      return buildMatrixScalarFallbackExpression(`matrix.${secondaryKey}`, secondaryValues, allowList);
    }
  }

  return "";
}

function extractMatrixReferences(expression) {
  const references = new Set();
  const patterns = [
    /\bmatrix\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*(?:\[matrix\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*\])?/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(expression)) !== null) {
      references.add(match[0]);
    }
  }

  return [...references];
}

function resolveMatrixReferenceValues(reference, matrixValues, matrixExcludes = []) {
  const indexedMatch = reference.match(/^matrix\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)\[matrix\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)\]$/);
  if (indexedMatch) {
    return resolveIndexedMatrixReferenceValues(indexedMatch[1], indexedMatch[2], matrixValues, matrixExcludes);
  }

  const directMatch = reference.match(/^matrix\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)$/);
  if (!directMatch) {
    return [];
  }
  return resolveMatrixPath(directMatch[1], matrixValues);
}

function resolveIndexedMatrixReferenceValues(leftPathExpression, rightPathExpression, matrixValues, matrixExcludes) {
  const leftSegments = leftPathExpression.split(".");
  const rightSegments = rightPathExpression.split(".");
  const leftRootKey = leftSegments.shift();
  const rightRootKey = rightSegments.shift();
  const leftRootValues = Array.isArray(matrixValues[leftRootKey]) ? matrixValues[leftRootKey] : [];
  const rightRootValues = Array.isArray(matrixValues[rightRootKey]) ? matrixValues[rightRootKey] : [];
  if (leftRootValues.length === 0 || rightRootValues.length === 0) {
    return [];
  }

  const resolved = [];
  let sawIncludedCombination = false;
  for (const leftRootValue of leftRootValues) {
    const leftValue = resolvePathOnValue(leftRootValue, leftSegments);
    if (leftValue === undefined) {
      return [];
    }
    for (const rightRootValue of rightRootValues) {
      if (isExcludedMatrixCombination({ [leftRootKey]: leftRootValue, [rightRootKey]: rightRootValue }, matrixExcludes)) {
        continue;
      }
      const rightValue = resolvePathOnValue(rightRootValue, rightSegments);
      if (typeof rightValue !== "string") {
        return [];
      }
      sawIncludedCombination = true;
      if (!leftValue || typeof leftValue !== "object" || Array.isArray(leftValue)) {
        return [];
      }
      if (!(rightValue in leftValue)) {
        return [];
      }
      resolved.push(leftValue[rightValue]);
    }
  }

  return sawIncludedCombination ? flattenMatrixResolvedValues(resolved) : [];
}

function resolveMatrixPath(pathExpression, matrixValues) {
  const segments = pathExpression.split(".");
  const rootKey = segments.shift();
  const rootValues = Array.isArray(matrixValues[rootKey]) ? matrixValues[rootKey] : [];
  if (segments.length === 0) {
    return flattenMatrixResolvedValues(rootValues);
  }

  let currentValues = rootValues;
  for (const segment of segments) {
    const nextValues = [];
    for (const value of currentValues) {
      if (!value || typeof value !== "object" || Array.isArray(value) || !(segment in value)) {
        return [];
      }
      nextValues.push(value[segment]);
    }
    currentValues = nextValues;
  }
  return flattenMatrixResolvedValues(currentValues);
}

function buildMatrixScalarFallbackExpression(reference, values, allowList) {
  const flattenedValues = flattenMatrixResolvedValues(values);
  const scalarValues = flattenedValues.filter((value) => typeof value === "string");
  if (scalarValues.length === 0 || scalarValues.length !== flattenedValues.length) {
    return "";
  }

  const mappings = scalarValues.map((value) => [value, mapForkFriendlyRunner(value, allowList)]);
  if (mappings.some(([, mapped]) => !mapped)) {
    return "";
  }

  const changedMappings = [...new Map(mappings)].filter(([original, mapped]) => original !== mapped);
  if (changedMappings.length === 0) {
    return reference;
  }

  const clauses = changedMappings.map(
    ([original, mapped]) => `${reference} == '${escapeExpressionString(original)}' && '${escapeExpressionString(mapped)}'`
  );
  return `(${clauses.join(" || ")} || ${reference})`;
}

function mapForkFriendlyRunner(label, allowList) {
  const normalized = String(label).trim();
  if (isPublicRunner(normalized, allowList)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  if (lower === "windows-x64") {
    return "windows-latest";
  }
  if (lower === "windows-arm64") {
    return "windows-11-arm";
  }
  if (lower === "linux-x64") {
    return "ubuntu-latest";
  }
  if (lower === "linux-arm64") {
    return "ubuntu-24.04-arm";
  }
  return inferEquivalentPublicRunner([normalized]);
}

function flattenMatrixResolvedValues(values) {
  return values.flatMap((value) => {
    if (Array.isArray(value)) {
      return flattenMatrixResolvedValues(value);
    }
    return [value];
  });
}

function resolvePathOnValue(value, segments) {
  let currentValue = value;
  for (const segment of segments) {
    if (!currentValue || typeof currentValue !== "object" || Array.isArray(currentValue) || !(segment in currentValue)) {
      return undefined;
    }
    currentValue = currentValue[segment];
  }
  return currentValue;
}

function isExcludedMatrixCombination(rootValues, matrixExcludes) {
  return matrixExcludes.some((exclude) =>
    Object.entries(exclude).every(([rootKey, pattern]) => rootKey in rootValues && matrixValueMatchesPattern(rootValues[rootKey], pattern))
  );
}

function matrixValueMatchesPattern(value, pattern) {
  if (Array.isArray(pattern)) {
    if (!Array.isArray(value) || value.length !== pattern.length) {
      return false;
    }
    return pattern.every((patternValue, index) => matrixValueMatchesPattern(value[index], patternValue));
  }
  if (pattern && typeof pattern === "object" && !Array.isArray(pattern)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return Object.entries(pattern).every(([key, nestedPattern]) => key in value && matrixValueMatchesPattern(value[key], nestedPattern));
  }
  return normalizeYamlValue(value) === normalizeYamlValue(pattern);
}

function isPublicRunnerValue(value, allowList) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => isPublicRunnerValue(item, allowList));
  }
  return typeof value === "string" && isPublicRunner(value, allowList);
}

function stripExpressionDelimiters(value) {
  const trimmed = String(value).trim();
  const match = trimmed.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  return match ? match[1].trim() : trimmed;
}

function runnerExpressionValue(labels, forceArray = false) {
  if (labels.length === 1 && !forceArray) {
    return `'${escapeExpressionString(labels[0])}'`;
  }
  return `fromJSON('${JSON.stringify(labels).replace(/'/g, "''")}')`;
}

function makeOwnerGuardEdit({ step, job, upstreamScope }) {
  if (!upstreamScope.guardExpression) {
    return null;
  }

  if (step && !step.hasOwnerGuard) {
    const existingIfEdit = makeGuardedIfEdit({
      ifLine: step.parsed && step.parsed.ifLine,
      ifValue: step.parsed && step.parsed.if,
      indent: step.indent + 2,
      upstreamScope,
      title: "Add owner guard to step condition",
      key: `replace:${step.parsed && step.parsed.ifLine}:step-owner-guard`,
    });
    if (existingIfEdit) {
      return existingIfEdit;
    }

    return {
      start: step.startIndex + 1,
      end: step.startIndex + 1,
      replacement: [`${" ".repeat(step.indent + 2)}if: ${upstreamScope.guardExpression}`],
      title: "Add owner guard to step",
      key: `insert:${step.startIndex}:step-owner-guard`,
    };
  }

  if (job && !job.hasOwnerGuard) {
    const existingIfEdit = makeGuardedIfEdit({
      ifLine: job.parsed && job.parsed.ifLine,
      ifValue: job.parsed && job.parsed.if,
      indent: job.bodyIndent,
      upstreamScope,
      title: "Add owner guard to job condition",
      key: `replace:${job.parsed && job.parsed.ifLine}:job-owner-guard`,
    });
    if (existingIfEdit) {
      return existingIfEdit;
    }

    return {
      start: job.startIndex + 1,
      end: job.startIndex + 1,
      replacement: [`${" ".repeat(job.bodyIndent)}if: ${upstreamScope.guardExpression}`],
      title: "Add owner guard to job",
      key: `insert:${job.startIndex}:job-owner-guard`,
    };
  }

  return null;
}

function makeGuardedIfEdit({ ifLine, ifValue, indent, upstreamScope, title, key }) {
  if (!ifLine || !ifValue) {
    return null;
  }

  const existingCondition = stripExpressionDelimiters(ifValue);
  if (!existingCondition) {
    return null;
  }

  return {
    start: ifLine - 1,
    end: ifLine,
    replacement: [`${" ".repeat(indent)}if: ${upstreamScope.guardExpression} && (${existingCondition})`],
    title,
    key,
  };
}

function applyEdits(lines, edits) {
  const fixed = [...lines];
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    fixed.splice(edit.start, edit.end - edit.start, ...edit.replacement);
  }
  return fixed;
}

function isPublicRunner(label, allowList) {
  if (allowList.has(label)) {
    return true;
  }
  return PUBLIC_GITHUB_HOSTED_RUNNERS.has(label);
}

function extractSecretNames(line) {
  const names = [];
  const expressionPattern = /\$\{\{([\s\S]*?)\}\}/g;
  let expressionMatch;
  while ((expressionMatch = expressionPattern.exec(String(line))) !== null) {
    const expression = expressionMatch[1];
    const secretPattern = /(?:^|[^A-Za-z0-9_])secrets\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let secretMatch;
    while ((secretMatch = secretPattern.exec(expression)) !== null) {
      if (secretMatch[1] !== "GITHUB_TOKEN") {
        names.push(secretMatch[1]);
      }
    }
  }
  return [...new Set(names)];
}

function cleanYamlScalar(value) {
  return stripInlineComment(value)
    .trim()
    .replace(/^["']|["']$/g, "");
}

function normalizeYamlValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeYamlValue(item)).filter((item) => item !== "");
  }

  const cleaned = cleanYamlScalar(value);
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    return cleaned
      .slice(1, -1)
      .split(",")
      .map((item) => cleanYamlScalar(item))
      .filter(Boolean);
  }
  return cleaned;
}

function stripInlineComment(value) {
  const text = String(value);
  const hashIndex = text.indexOf("#");
  return hashIndex === -1 ? text : text.slice(0, hashIndex);
}

function countIndent(line) {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

function isCommentOnly(line) {
  return /^\s*#/.test(line);
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.line}:${finding.title}:${finding.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeEdits(edits) {
  const seen = new Set();
  return edits.filter((edit) => {
    if (!edit || seen.has(edit.key)) {
      return false;
    }
    seen.add(edit.key);
    return true;
  });
}

function summarizeFindings(findings, changes = []) {
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;

  if (findings.length === 0) {
    return "## Fork Friendly Actions\n\nNo fork-hostile workflow patterns were found.";
  }

  const rows = findings.map((finding) => {
    const fixed = changes.some((change) => change.file === finding.file && change.line === finding.line) ? "yes" : "";
    return `| ${finding.severity} | \`${finding.file}:${finding.line}\` | ${escapeMarkdownTable(finding.title)} | ${fixed} | ${escapeMarkdownTable(finding.message)} |`;
  });

  return [
    "## Fork Friendly Actions",
    "",
    `Found ${findings.length} issue${findings.length === 1 ? "" : "s"}: ${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}.`,
    "",
    "| Severity | Location | Rule | Fixed | Message |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function escapeMarkdownTable(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function shouldFail(findings, failOn) {
  if (failOn === "none") {
    return false;
  }
  if (failOn === "warning") {
    return findings.some((finding) => finding.severity === "warning" || finding.severity === "error");
  }
  return findings.some((finding) => finding.severity === "error");
}

function formatScopeHint(upstreamScope) {
  if (!upstreamScope.guardExpression) {
    return "";
  }
  return ` For this repository, that usually means checking ${upstreamScope.guardExpression}.`;
}

function escapeExpressionString(value) {
  return String(value).replace(/'/g, "''");
}

module.exports = {
  DEFAULT_PUBLIC_RUNNERS_FILE,
  DEFAULT_RUNNER_FALLBACK,
  DEFAULT_WORKFLOWS_DIR,
  RULES,
  auditWorkflowFile,
  auditWorkflows,
  buildUpstreamGuardExpression,
  discoverWorkflowFiles,
  evaluateWorkflowFile,
  evaluateWorkflows,
  fixWorkflowFile,
  fixWorkflows,
  loadPublicGithubHostedRunners,
  normalizeUpstreamScope,
  ownerFromRepoSlug,
  parseRunnerLabels,
  shouldFail,
  summarizeFindings,
};
