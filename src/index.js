"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
});

const OWNER_GUARD_PATTERNS = [
  /github\.repository_owner\s*==/,
  /github\.repository_owner\s*!=/,
  /github\.repository\s*==/,
  /github\.repository\s*!=/,
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
    if (mode === "fix" && result.fixedSource !== source && !dryRun) {
      fs.writeFileSync(filePath, result.fixedSource);
    }
  }

  return {
    files,
    findings,
    changes,
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
  const jobs = collectJobs(lines);
  const upstreamScope = normalizeUpstreamScope({ upstreamRepo, upstreamOwner });

  for (const job of jobs) {
    const runsOn = findRunsOnForJob(lines, job);
    if (runsOn) {
      const runnerResult = auditRunsOn({ relativeFile, lineNumber: runsOn.startIndex + 1, runsOn, guard: job, upstreamScope, allowList });
      findings.push(...runnerResult.findings);
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

    for (const step of job.steps) {
      const secretNames = extractSecretNamesInRange(lines, step.startIndex, step.endIndex);
      if (secretNames.length > 0 && !step.hasOwnerGuard && !job.hasOwnerGuard) {
        const stepEdit = makeOwnerGuardEdit({ step, job, upstreamScope });
        findings.push({
          severity: "warning",
          file: relativeFile,
          line: firstSecretReferenceLine(lines, step.startIndex, step.endIndex),
          rule: RULES.SECRET_GATE.slug,
          ruleCode: RULES.SECRET_GATE.code,
          title: "Secret usage is not owner-gated",
          message: `This step references ${secretNames.map((name) => `secrets.${name}`).join(", ")} without an obvious upstream guard. Fork pull requests cannot access normal repository or organization secrets.${formatScopeHint(upstreamScope)}`,
          fixable: stepEdit != null,
        });
        if (mode === "fix" && stepEdit) {
          edits.push(stepEdit);
        }
      }

      const publishTrigger = detectPublishTriggerInStep(lines, step);
      if (publishTrigger && !step.hasOwnerGuard && !job.hasOwnerGuard) {
        const stepEdit = makeOwnerGuardEdit({ step, job, upstreamScope });
        findings.push({
          severity: "warning",
          file: relativeFile,
          line: publishTrigger.line,
          rule: RULES.PUBLISH_GATE.slug,
          ruleCode: RULES.PUBLISH_GATE.code,
          title: RULES.PUBLISH_GATE.title,
          message: `Publishing, deployment, release-write, and cloud-auth steps should usually be skipped on forks with an upstream guard.${formatScopeHint(upstreamScope)}`,
          fixable: stepEdit != null,
        });
        if (mode === "fix" && stepEdit) {
          edits.push(stepEdit);
        }
      }
    }
  }

  const normalizedEdits = dedupeEdits(edits).filter(Boolean);
  const fixedLines = applyEdits(lines, normalizedEdits);

  return {
    findings: dedupeFindings(findings),
    changes: normalizedEdits.map((edit) => ({
      file: relativeFile,
      line: edit.start + 1,
      title: edit.title,
    })),
    fixedSource: fixedLines.join(lineEnding),
  };
}

function collectJobs(lines) {
  const jobs = [];
  let inJobs = false;
  let jobsIndent = 0;
  let currentJob = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isCommentOnly(line) || line.trim() === "") {
      continue;
    }

    const indent = countIndent(line);
    const trimmed = line.trim();

    if (/^jobs:\s*$/.test(trimmed)) {
      inJobs = true;
      jobsIndent = indent;
      continue;
    }

    if (!inJobs) {
      continue;
    }

    if (indent <= jobsIndent && /^[A-Za-z0-9_-]+:\s*/.test(trimmed)) {
      currentJob = null;
      inJobs = false;
      continue;
    }

    if (indent === jobsIndent + 2 && /^[A-Za-z0-9_-]+:\s*(#.*)?$/.test(trimmed)) {
      currentJob = {
        startIndex: index,
        startLine: index + 1,
        endLine: lines.length,
        endIndex: lines.length - 1,
        bodyIndent: jobsIndent + 4,
        hasOwnerGuard: false,
        matrixValues: {},
        matrixExcludes: [],
        steps: [],
      };
      jobs.push(currentJob);
      if (jobs.length > 1) {
        jobs[jobs.length - 2].endLine = index;
        jobs[jobs.length - 2].endIndex = index - 1;
      }
      continue;
    }

    if (currentJob && indent === currentJob.bodyIndent && /^if:\s*/.test(trimmed) && OWNER_GUARD_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      currentJob.hasOwnerGuard = true;
    }
  }

  for (const job of jobs) {
    job.matrixValues = collectMatrixValues(lines, job);
    job.matrixExcludes = collectMatrixExcludes(lines, job);
    job.steps = collectSteps(lines, job);
  }

  return jobs;
}

function collectSteps(lines, job) {
  const steps = [];
  let inSteps = false;
  let stepsIndent = -1;
  let currentStep = null;

  for (let index = job.startIndex + 1; index <= job.endIndex; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || isCommentOnly(line)) {
      continue;
    }

    const indent = countIndent(line);
    const trimmed = line.trim();

    if (!inSteps) {
      if (indent === job.bodyIndent && /^steps:\s*$/.test(trimmed)) {
        inSteps = true;
        stepsIndent = indent;
      }
      continue;
    }

    if (indent <= stepsIndent) {
      if (currentStep) {
        currentStep.endIndex = index - 1;
        currentStep.endLine = index;
      }
      break;
    }

    const stepMatch = line.match(/^(\s*)-\s+(name|uses|run):/);
    if (stepMatch) {
      if (currentStep) {
        currentStep.endIndex = index - 1;
        currentStep.endLine = index;
      }
      currentStep = {
        startIndex: index,
        startLine: index + 1,
        endIndex: job.endIndex,
        endLine: job.endLine,
        indent: stepMatch[1].length,
        hasOwnerGuard: false,
      };
      steps.push(currentStep);
      continue;
    }

    if (currentStep && indent === currentStep.indent + 2 && /^if:\s*/.test(trimmed) && OWNER_GUARD_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      currentStep.hasOwnerGuard = true;
    }
  }

  if (currentStep) {
    currentStep.endIndex = Math.min(currentStep.endIndex, job.endIndex);
    currentStep.endLine = currentStep.endIndex + 1;
  }

  return steps;
}

function findRunsOnForJob(lines, job) {
  for (let index = job.startIndex + 1; index <= job.endIndex; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || isCommentOnly(line)) {
      continue;
    }
    if (countIndent(line) !== job.bodyIndent) {
      continue;
    }
    const runsOn = parseRunsOn(lines, index);
    if (runsOn) {
      return runsOn;
    }
  }
  return null;
}

function parseRunsOn(lines, index) {
  const line = lines[index];
  const match = line.match(/^(\s*)runs-on:\s*(.*)$/);
  if (!match) {
    return null;
  }

  const indent = match[1].length;
  const rest = stripInlineComment(match[2]).trim();
  if (rest !== "") {
    const inlineMap = parseInlineRunsOnMap(rest);
    if (inlineMap) {
      return {
        startIndex: index,
        endIndex: index,
        indent,
        raw: rest,
        labels: inlineMap.labels,
        group: inlineMap.group,
        usesGroup: Boolean(inlineMap.group),
        isExpression: inlineMap.isExpression,
        inline: true,
      };
    }
    return {
      startIndex: index,
      endIndex: index,
      indent,
      raw: rest,
      labels: parseRunnerLabels(rest),
      group: "",
      usesGroup: false,
      isExpression: rest.includes("${{"),
      inline: true,
    };
  }

  const labels = [];
  let group = "";
  let usesGroup = false;
  let labelsIndent = -1;
  let endIndex = index;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const nextLine = lines[cursor];
    if (nextLine.trim() === "" || isCommentOnly(nextLine)) {
      continue;
    }
    if (countIndent(nextLine) <= indent) {
      break;
    }
    endIndex = cursor;

    const childIndent = countIndent(nextLine);
    const trimmed = nextLine.trim();
    if (labelsIndent !== -1 && childIndent > labelsIndent) {
      const labelItemMatch = trimmed.match(/^-\s*(.+)$/);
      if (labelItemMatch) {
        labels.push(cleanYamlScalar(labelItemMatch[1]));
        continue;
      }
    } else if (labelsIndent !== -1 && childIndent <= labelsIndent) {
      labelsIndent = -1;
    }

    const itemMatch = trimmed.match(/^-\s*(.+)$/);
    if (itemMatch) {
      labels.push(cleanYamlScalar(itemMatch[1]));
      continue;
    }

    const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!keyMatch) {
      continue;
    }

    const key = keyMatch[1];
    const value = stripInlineComment(keyMatch[2]).trim();
    if (key === "group") {
      usesGroup = true;
      group = cleanYamlScalar(value);
      continue;
    }
    if (key === "labels") {
      if (value) {
        labels.push(...parseRunnerLabels(value));
      } else {
        labelsIndent = childIndent;
      }
    }
  }

  return {
    startIndex: index,
    endIndex,
    indent,
    raw: group ? `group: ${group}${labels.length > 0 ? `, labels: ${labels.join(", ")}` : ""}` : labels.join(", "),
    labels,
    group,
    usesGroup,
    isExpression: labels.some((label) => label.includes("${{")),
    inline: false,
  };
}

function parseInlineRunsOnMap(value) {
  const trimmed = String(value).trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const content = trimmed.slice(1, -1).trim();
  const fields = content
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  let group = "";
  const labels = [];
  for (const field of fields) {
    const match = field.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)$/);
    if (!match) {
      return null;
    }
    const key = match[1];
    const fieldValue = match[2];
    if (key === "group") {
      group = cleanYamlScalar(fieldValue);
      continue;
    }
    if (key === "labels") {
      labels.push(...parseRunnerLabels(fieldValue));
      continue;
    }
    return null;
  }

  return {
    group,
    labels,
    isExpression: labels.some((label) => label.includes("${{")) || group.includes("${{"),
  };
}

function collectMatrixValues(lines, job) {
  const values = new Map();
  let strategyIndent = -1;
  let matrixIndent = -1;
  let includeIndent = -1;
  let activeKey = "";
  let pendingObjectKey = "";
  let pendingObjectIndent = -1;
  let pendingObject = null;
  let activeListObjectKey = "";
  let activeListObjectIndent = -1;
  let activeListObject = null;
  let activeListNestedKey = "";
  let activeListNestedIndent = -1;
  let activeListNestedObject = null;

  function flushPendingObject() {
    if (pendingObject) {
      addMatrixValue(values, pendingObjectKey, pendingObject);
      pendingObjectKey = "";
      pendingObjectIndent = -1;
      pendingObject = null;
    }
  }

  function flushActiveListObject() {
    if (activeListObject) {
      if (activeListNestedObject) {
        activeListObject[activeListNestedKey] = activeListNestedObject;
      }
      addMatrixValue(values, activeListObjectKey, activeListObject);
      activeListObjectKey = "";
      activeListObjectIndent = -1;
      activeListObject = null;
      activeListNestedKey = "";
      activeListNestedIndent = -1;
      activeListNestedObject = null;
    }
  }

  for (let index = job.startIndex + 1; index <= job.endIndex; index += 1) {
    const line = lines[index];
    if (!line || line.trim() === "" || isCommentOnly(line)) {
      continue;
    }

    const indent = countIndent(line);
    const trimmed = line.trim();

    if (pendingObject && indent <= pendingObjectIndent) {
      flushPendingObject();
    }
    if (activeListObject && indent <= activeListObjectIndent) {
      flushActiveListObject();
    }

    if (indent === job.bodyIndent && /^strategy:\s*$/.test(trimmed)) {
      strategyIndent = indent;
      matrixIndent = -1;
      includeIndent = -1;
      activeKey = "";
      continue;
    }

    if (strategyIndent !== -1 && indent <= strategyIndent) {
      flushPendingObject();
      flushActiveListObject();
      strategyIndent = -1;
      matrixIndent = -1;
      includeIndent = -1;
      activeKey = "";
    }

    if (strategyIndent === -1) {
      continue;
    }

    if (indent === strategyIndent + 2 && /^matrix:\s*$/.test(trimmed)) {
      matrixIndent = indent;
      includeIndent = -1;
      activeKey = "";
      continue;
    }

    if (matrixIndent !== -1 && indent <= matrixIndent) {
      flushPendingObject();
      flushActiveListObject();
      matrixIndent = -1;
      includeIndent = -1;
      activeKey = "";
    }

    if (matrixIndent === -1) {
      continue;
    }

    if (indent === matrixIndent + 2) {
      activeKey = "";
      const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!keyMatch) {
        continue;
      }

      const key = keyMatch[1];
      const remainder = stripInlineComment(keyMatch[2]).trim();
      if (key === "include") {
        includeIndent = indent;
        continue;
      }

      includeIndent = -1;
      activeKey = key;
      if (remainder) {
        for (const value of parseMatrixValuesInline(remainder)) {
          addMatrixValue(values, key, value);
        }
      } else if (includeIndent !== -1 || key === "runs_on") {
        pendingObjectKey = key;
        pendingObjectIndent = indent;
        pendingObject = {};
      }
      continue;
    }

    if (pendingObject && indent > pendingObjectIndent) {
      const nestedMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)$/);
      if (nestedMatch) {
        pendingObject[nestedMatch[1]] = parseYamlValue(nestedMatch[2]);
        continue;
      }
    }

    if (activeKey && indent > matrixIndent + 2) {
      if (activeListObject) {
        if (activeListNestedObject && indent <= activeListNestedIndent) {
          activeListObject[activeListNestedKey] = activeListNestedObject;
          activeListNestedKey = "";
          activeListNestedIndent = -1;
          activeListNestedObject = null;
        }

        if (activeListNestedObject && indent > activeListNestedIndent) {
          const nestedMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)$/);
          if (nestedMatch) {
            activeListNestedObject[nestedMatch[1]] = parseYamlValue(nestedMatch[2]);
            continue;
          }
        }

        if (indent > activeListObjectIndent) {
          const propertyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
          if (propertyMatch) {
            const propertyKey = propertyMatch[1];
            const propertyValue = stripInlineComment(propertyMatch[2]).trim();
            if (propertyValue) {
              activeListObject[propertyKey] = parseYamlValue(propertyValue);
            } else {
              activeListNestedKey = propertyKey;
              activeListNestedIndent = indent;
              activeListNestedObject = {};
            }
            continue;
          }
        }
      }

      const listItemMatch = trimmed.match(/^-\s+(.+)$/);
      if (listItemMatch) {
        const objectItemMatch = trimmed.match(/^- ([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (objectItemMatch) {
          flushActiveListObject();
          activeListObjectKey = activeKey;
          activeListObjectIndent = indent;
          activeListObject = {};
          const propertyKey = objectItemMatch[1];
          const propertyValue = stripInlineComment(objectItemMatch[2]).trim();
          if (propertyValue) {
            activeListObject[propertyKey] = parseYamlValue(propertyValue);
          } else {
            activeListNestedKey = propertyKey;
            activeListNestedIndent = indent;
            activeListNestedObject = {};
          }
        } else {
          flushActiveListObject();
          addMatrixValue(values, activeKey, parseYamlValue(listItemMatch[1]));
        }
        continue;
      }
    }

    if (includeIndent !== -1 && indent > includeIndent) {
      const includeValueMatch = trimmed.match(/^(?:-\s+)?([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (includeValueMatch) {
        const includeValue = stripInlineComment(includeValueMatch[2]).trim();
        if (includeValue) {
          for (const value of parseMatrixValuesInline(includeValue)) {
            addMatrixValue(values, includeValueMatch[1], value);
          }
        } else {
          flushPendingObject();
          pendingObjectKey = includeValueMatch[1];
          pendingObjectIndent = indent;
          pendingObject = {};
        }
      }
    }
  }

  flushPendingObject();
  flushActiveListObject();

  return Object.fromEntries(values);
}

function collectMatrixExcludes(lines, job) {
  const excludes = [];
  let strategyIndent = -1;
  let matrixIndent = -1;
  let excludeIndent = -1;
  let currentExclude = null;
  let stack = [];

  function flushCurrentExclude() {
    if (currentExclude && Object.keys(currentExclude).length > 0) {
      excludes.push(normalizeMatrixObject(currentExclude));
    }
    currentExclude = null;
    stack = [];
  }

  for (let index = job.startIndex + 1; index <= job.endIndex; index += 1) {
    const line = lines[index];
    if (!line || line.trim() === "" || isCommentOnly(line)) {
      continue;
    }

    const indent = countIndent(line);
    const trimmed = line.trim();

    if (indent === job.bodyIndent && /^strategy:\s*$/.test(trimmed)) {
      strategyIndent = indent;
      matrixIndent = -1;
      excludeIndent = -1;
      flushCurrentExclude();
      continue;
    }

    if (strategyIndent !== -1 && indent <= strategyIndent) {
      flushCurrentExclude();
      strategyIndent = -1;
      matrixIndent = -1;
      excludeIndent = -1;
    }

    if (strategyIndent === -1) {
      continue;
    }

    if (indent === strategyIndent + 2 && /^matrix:\s*$/.test(trimmed)) {
      matrixIndent = indent;
      excludeIndent = -1;
      flushCurrentExclude();
      continue;
    }

    if (matrixIndent !== -1 && indent <= matrixIndent) {
      flushCurrentExclude();
      matrixIndent = -1;
      excludeIndent = -1;
    }

    if (matrixIndent === -1) {
      continue;
    }

    if (indent === matrixIndent + 2 && /^exclude:\s*$/.test(trimmed)) {
      excludeIndent = indent;
      flushCurrentExclude();
      continue;
    }

    if (excludeIndent !== -1 && indent <= excludeIndent) {
      flushCurrentExclude();
      excludeIndent = -1;
    }

    if (excludeIndent === -1) {
      continue;
    }

    const listItemMatch = trimmed.match(/^- ([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (listItemMatch) {
      flushCurrentExclude();
      currentExclude = {};
      stack = [{ indent, container: currentExclude }];

      const propertyKey = listItemMatch[1];
      const propertyValue = stripInlineComment(listItemMatch[2]).trim();
      if (propertyValue) {
        currentExclude[propertyKey] = parseYamlValue(propertyValue);
      } else {
        currentExclude[propertyKey] = {};
        stack.push({ indent: indent + 2, container: currentExclude[propertyKey] });
      }
      continue;
    }

    if (!currentExclude) {
      continue;
    }

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const target = stack.length > 0 ? stack[stack.length - 1].container : currentExclude;
    const propertyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!propertyMatch) {
      continue;
    }

    const propertyKey = propertyMatch[1];
    const propertyValue = stripInlineComment(propertyMatch[2]).trim();
    if (propertyValue) {
      target[propertyKey] = parseYamlValue(propertyValue);
    } else {
      target[propertyKey] = {};
      stack.push({ indent, container: target[propertyKey] });
    }
  }

  flushCurrentExclude();
  return excludes;
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

function parseMatrixValuesInline(value) {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => cleanYamlScalar(item))
      .filter(Boolean);
  }
  return [cleanYamlScalar(trimmed)].filter(Boolean);
}

function parseRunnerLabels(value) {
  const trimmed = value.trim();
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
      return {
        fixable: Boolean(upstreamScope.guardExpression),
        fixKind: "runs-on-fallback",
        fallbackExpression: expressionFallback,
        findings: [
          {
            severity: "warning",
            file: relativeFile,
            line: lineNumber,
            rule: RULES.RUNNER_EXPRESSION.slug,
            ruleCode: RULES.RUNNER_EXPRESSION.code,
            title: "Dynamic runner expression needs a fork fallback",
            message: `Dynamic runs-on expressions should clearly choose a known free public GitHub-hosted runner when the workflow runs outside the upstream repository.${formatScopeHint(upstreamScope)}`,
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
    start: runsOn.startIndex,
    end: runsOn.endIndex + 1,
    replacement: [`${" ".repeat(runsOn.indent)}runs-on: ${expression}`],
    title: "Add fork runner fallback",
    key: `replace:${runsOn.startIndex}:${runsOn.endIndex}:runs-on`,
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
    return {
      start: step.startIndex + 1,
      end: step.startIndex + 1,
      replacement: [`${" ".repeat(step.indent + 2)}if: ${upstreamScope.guardExpression}`],
      title: "Add owner guard to step",
      key: `insert:${step.startIndex}:step-owner-guard`,
    };
  }

  if (job && !job.hasOwnerGuard) {
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

function detectPublishTriggerInStep(lines, step) {
  for (let index = step.startIndex; index <= step.endIndex; index += 1) {
    const line = lines[index];
    if (!line || line.trim() === "" || isCommentOnly(line)) {
      continue;
    }

    const trimmed = line.trim();
    const usesMatch = trimmed.match(/^(?:-\s+)?uses:\s*(.+)$/);
    if (usesMatch && PUBLISH_USES_PATTERNS.some((pattern) => pattern.test(usesMatch[1]))) {
      return { index, line: index + 1 };
    }

    const runMatch = trimmed.match(/^(?:-\s+)?run:\s*(.*)$/);
    if (!runMatch) {
      continue;
    }

    const remainder = runMatch[1].trim();
    if (remainder && remainder !== "|" && remainder !== ">") {
      if (PUBLISH_RUN_PATTERNS.some((pattern) => pattern.test(remainder))) {
        return { index, line: index + 1 };
      }
      continue;
    }

    const runIndent = countIndent(line);
    for (let cursor = index + 1; cursor <= step.endIndex; cursor += 1) {
      const scriptLine = lines[cursor];
      if (!scriptLine || scriptLine.trim() === "" || isCommentOnly(scriptLine)) {
        continue;
      }
      if (countIndent(scriptLine) <= runIndent) {
        break;
      }
      if (PUBLISH_RUN_PATTERNS.some((pattern) => pattern.test(scriptLine.trim()))) {
        return { index: cursor, line: cursor + 1 };
      }
    }
  }

  return null;
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

function extractSecretNamesInRange(lines, startIndex, endIndex) {
  const names = new Set();
  for (let index = startIndex; index <= endIndex; index += 1) {
    for (const name of extractSecretNames(lines[index] || "")) {
      names.add(name);
    }
  }
  return [...names];
}

function firstSecretReferenceLine(lines, startIndex, endIndex) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (extractSecretNames(lines[index] || "").length > 0) {
      return index + 1;
    }
  }
  return startIndex + 1;
}

function extractSecretNames(line) {
  const names = [];
  const pattern = /\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    if (match[1] !== "GITHUB_TOKEN") {
      names.push(match[1]);
    }
  }
  return [...new Set(names)];
}

function cleanYamlScalar(value) {
  return stripInlineComment(value)
    .trim()
    .replace(/^["']|["']$/g, "");
}

function parseYamlValue(value) {
  const normalized = normalizeYamlValue(value);
  if (Array.isArray(normalized)) {
    return normalized;
  }
  return String(normalized);
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
  const hashIndex = value.indexOf("#");
  return hashIndex === -1 ? value : value.slice(0, hashIndex);
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
