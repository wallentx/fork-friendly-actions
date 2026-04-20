"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_WORKFLOWS_DIR = ".github/workflows";
const DEFAULT_RUNNER_FALLBACK = "ubuntu-latest";

const PUBLIC_RUNNER_PATTERNS = [
  /^ubuntu-(latest|\d{2}\.\d{2})(-arm)?$/,
  /^windows-(latest|\d{4})$/,
  /^macos-(latest|\d{2}|\d{2}-(large|xlarge)|\d{2}-intel|latest-large|latest-xlarge)$/,
];

const OWNER_GUARD_PATTERNS = [
  /github\.repository_owner\s*==/,
  /github\.repository_owner\s*!=/,
  /github\.repository\s*==/,
  /github\.repository\s*!=/,
];

const PUBLISH_PATTERNS = [
  /\b(npm\s+publish|twine\s+upload|docker\s+push|gh\s+release)\b/i,
  /\bpypa\/gh-action-pypi-publish\b/i,
  /\bdocker\/login-action\b/i,
  /\bsoftprops\/action-gh-release\b/i,
  /\bactions\/create-release\b/i,
  /\baws-actions\/configure-aws-credentials\b/i,
  /\bgoogle-github-actions\/auth\b/i,
  /\bazure\/login\b/i,
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

function auditWorkflows({ cwd = process.cwd(), workflows = DEFAULT_WORKFLOWS_DIR, upstreamOwner = "", allowRunners = "" } = {}) {
  return evaluateWorkflows({ cwd, workflows, upstreamOwner, allowRunners, mode: "check" });
}

function fixWorkflows({
  cwd = process.cwd(),
  workflows = DEFAULT_WORKFLOWS_DIR,
  upstreamOwner,
  allowRunners = "",
  runnerFallback = DEFAULT_RUNNER_FALLBACK,
  dryRun = false,
} = {}) {
  if (!upstreamOwner) {
    throw new Error("upstreamOwner is required when applying fixes.");
  }
  return evaluateWorkflows({ cwd, workflows, upstreamOwner, allowRunners, runnerFallback, dryRun, mode: "fix" });
}

function evaluateWorkflows({
  cwd = process.cwd(),
  workflows = DEFAULT_WORKFLOWS_DIR,
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

function auditWorkflowFile({ filePath, source, cwd, upstreamOwner = "", allowList = new Set() }) {
  return evaluateWorkflowFile({ filePath, source, cwd, upstreamOwner, allowList, mode: "check" }).findings;
}

function fixWorkflowFile({
  filePath,
  source,
  cwd,
  upstreamOwner,
  allowList = new Set(),
  runnerFallback = DEFAULT_RUNNER_FALLBACK,
}) {
  if (!upstreamOwner) {
    throw new Error("upstreamOwner is required when applying fixes.");
  }
  return evaluateWorkflowFile({ filePath, source, cwd, upstreamOwner, allowList, runnerFallback, mode: "fix" });
}

function evaluateWorkflowFile({
  filePath,
  source,
  cwd,
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
  const jobGuards = collectJobGuards(lines);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (isCommentOnly(line)) {
      continue;
    }

    const runsOn = parseRunsOn(lines, index);
    if (runsOn) {
      const guard = guardForLine(jobGuards, lineNumber);
      const runnerResult = auditRunsOn({ relativeFile, lineNumber, runsOn, guard, upstreamOwner, allowList });
      findings.push(...runnerResult.findings);
      if (mode === "fix" && runnerResult.fixable) {
        edits.push(makeRunsOnEdit({ lines, runsOn, upstreamOwner, runnerFallback }));
      }
    }

    const secretNames = extractSecretNames(line);
    if (secretNames.length > 0 && !hasNearbyOwnerGuard(lines, index, jobGuards)) {
      const stepEdit = mode === "fix" ? makeOwnerGuardEdit({ lines, index, jobGuards, upstreamOwner }) : null;
      findings.push({
        severity: "warning",
        file: relativeFile,
        line: lineNumber,
        title: "Secret usage is not owner-gated",
        message: `This line references ${secretNames.map((name) => `secrets.${name}`).join(", ")} without an obvious repository-owner guard. Fork pull requests cannot access normal repository or organization secrets.${formatOwnerHint(upstreamOwner)}`,
        fixable: stepEdit != null,
      });
      if (stepEdit) {
        edits.push(stepEdit);
      }
    }

    if (PUBLISH_PATTERNS.some((pattern) => pattern.test(line)) && !hasNearbyOwnerGuard(lines, index, jobGuards)) {
      const stepEdit = mode === "fix" ? makeOwnerGuardEdit({ lines, index, jobGuards, upstreamOwner }) : null;
      findings.push({
        severity: "warning",
        file: relativeFile,
        line: lineNumber,
        title: "Publish or deploy step is not owner-gated",
        message: `Publishing, deployment, cloud auth, or release steps should usually be skipped on forks with a repository-owner guard.${formatOwnerHint(upstreamOwner)}`,
        fixable: stepEdit != null,
      });
      if (stepEdit) {
        edits.push(stepEdit);
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

function collectJobGuards(lines) {
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
        bodyIndent: jobsIndent + 4,
        hasOwnerGuard: false,
      };
      jobs.push(currentJob);
      if (jobs.length > 1) {
        jobs[jobs.length - 2].endLine = index;
      }
      continue;
    }

    if (currentJob && indent === currentJob.bodyIndent && /^if:\s*/.test(trimmed) && OWNER_GUARD_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      currentJob.hasOwnerGuard = true;
    }
  }

  return jobs;
}

function guardForLine(jobGuards, lineNumber) {
  return jobGuards.find((job) => lineNumber >= job.startLine && lineNumber <= job.endLine) || null;
}

function hasNearbyOwnerGuard(lines, index, jobGuards) {
  const guard = guardForLine(jobGuards, index + 1);
  if (guard?.hasOwnerGuard) {
    return true;
  }

  const step = findStepForLine(lines, index);
  if (step?.hasOwnerGuard) {
    return true;
  }

  for (let offset = 0; offset <= 3; offset += 1) {
    const line = lines[index - offset] || "";
    if (/^\s*if:\s*/.test(line) && OWNER_GUARD_PATTERNS.some((pattern) => pattern.test(line))) {
      return true;
    }
  }

  return false;
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
    return {
      startIndex: index,
      endIndex: index,
      indent,
      raw: rest,
      labels: parseRunnerLabels(rest),
      isExpression: rest.includes("${{"),
      inline: true,
    };
  }

  const labels = [];
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
    const itemMatch = nextLine.trim().match(/^-\s*(.+)$/);
    if (itemMatch) {
      labels.push(cleanYamlScalar(itemMatch[1]));
    }
  }

  return {
    startIndex: index,
    endIndex,
    indent,
    raw: labels.join(", "),
    labels,
    isExpression: labels.some((label) => label.includes("${{")),
    inline: false,
  };
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

function auditRunsOn({ relativeFile, lineNumber, runsOn, guard, upstreamOwner, allowList }) {
  if (runsOn.isExpression) {
    const raw = runsOn.raw;
    const hasOwnerExpression = OWNER_GUARD_PATTERNS.some((pattern) => pattern.test(raw));
    const hasFallback = /&&/.test(raw) && /\|\|/.test(raw);
    if (!hasOwnerExpression || !hasFallback) {
      return {
        fixable: false,
        findings: [
          {
            severity: "warning",
            file: relativeFile,
            line: lineNumber,
            title: "Dynamic runner expression needs a fork fallback",
            message: `Dynamic runs-on expressions should clearly choose a public GitHub-hosted runner when the workflow runs outside the upstream repository.${formatOwnerHint(upstreamOwner)}`,
            fixable: false,
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

  return {
    fixable: Boolean(upstreamOwner),
    findings: [
      {
        severity: "error",
        file: relativeFile,
        line: lineNumber,
        title: "Private runner is not fork-friendly",
        message: `Runner label${privateLabels.length === 1 ? "" : "s"} ${privateLabels.join(", ")} ${privateLabels.length === 1 ? "is" : "are"} not known public GitHub-hosted runners. Add a repository-owner guard or a public fallback runner for forks.${formatOwnerHint(upstreamOwner)}`,
        fixable: Boolean(upstreamOwner),
      },
    ],
  };
}

function makeRunsOnEdit({ lines, runsOn, upstreamOwner, runnerFallback }) {
  const originalRunner = runnerExpressionValue(runsOn.labels);
  const fallbackRunner = runnerExpressionValue([runnerFallback || DEFAULT_RUNNER_FALLBACK], runsOn.labels.length > 1);
  const expression = `\${{ github.repository_owner == '${escapeExpressionString(upstreamOwner)}' && ${originalRunner} || ${fallbackRunner} }}`;
  return {
    start: runsOn.startIndex,
    end: runsOn.endIndex + 1,
    replacement: [`${" ".repeat(runsOn.indent)}runs-on: ${expression}`],
    title: "Add fork runner fallback",
    key: `replace:${runsOn.startIndex}:${runsOn.endIndex}:runs-on`,
  };
}

function runnerExpressionValue(labels, forceArray = false) {
  if (labels.length === 1 && !forceArray) {
    return `'${escapeExpressionString(labels[0])}'`;
  }
  return `fromJSON('${JSON.stringify(labels).replace(/'/g, "''")}')`;
}

function makeOwnerGuardEdit({ lines, index, jobGuards, upstreamOwner }) {
  if (!upstreamOwner) {
    return null;
  }

  const step = findStepForLine(lines, index);
  if (step && !step.hasOwnerGuard) {
    return {
      start: step.startIndex + 1,
      end: step.startIndex + 1,
      replacement: [`${" ".repeat(step.indent + 2)}if: github.repository_owner == '${escapeExpressionString(upstreamOwner)}'`],
      title: "Add owner guard to step",
      key: `insert:${step.startIndex}:step-owner-guard`,
    };
  }

  const job = guardForLine(jobGuards, index + 1);
  if (job && !job.hasOwnerGuard) {
    return {
      start: job.startIndex + 1,
      end: job.startIndex + 1,
      replacement: [`${" ".repeat(job.bodyIndent)}if: github.repository_owner == '${escapeExpressionString(upstreamOwner)}'`],
      title: "Add owner guard to job",
      key: `insert:${job.startIndex}:job-owner-guard`,
    };
  }

  return null;
}

function findStepForLine(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const line = lines[cursor];
    if (line.trim() === "" || isCommentOnly(line)) {
      continue;
    }
    const match = line.match(/^(\s*)-\s+(name|uses|run):/);
    if (!match) {
      if (/^\s*steps:\s*$/.test(line)) {
        return null;
      }
      continue;
    }

    const indent = match[1].length;
    const step = {
      startIndex: cursor,
      endIndex: lines.length - 1,
      indent,
      hasOwnerGuard: false,
    };
    for (let forward = cursor + 1; forward < lines.length; forward += 1) {
      const nextLine = lines[forward];
      if (nextLine.trim() === "" || isCommentOnly(nextLine)) {
        continue;
      }
      const nextIndent = countIndent(nextLine);
      if (nextIndent <= indent) {
        step.endIndex = forward - 1;
        break;
      }
      if (nextIndent === indent + 2 && /^if:\s*/.test(nextLine.trim()) && OWNER_GUARD_PATTERNS.some((pattern) => pattern.test(nextLine.trim()))) {
        step.hasOwnerGuard = true;
      }
    }

    if (index >= step.startIndex && index <= step.endIndex) {
      return step;
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
  return PUBLIC_RUNNER_PATTERNS.some((pattern) => pattern.test(label));
}

function extractSecretNames(line) {
  const names = [];
  const pattern = /secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
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

function formatOwnerHint(upstreamOwner) {
  if (!upstreamOwner) {
    return "";
  }
  return ` For this repository, that usually means checking github.repository_owner == '${upstreamOwner}'.`;
}

function escapeExpressionString(value) {
  return String(value).replace(/'/g, "''");
}

module.exports = {
  DEFAULT_RUNNER_FALLBACK,
  DEFAULT_WORKFLOWS_DIR,
  auditWorkflowFile,
  auditWorkflows,
  discoverWorkflowFiles,
  evaluateWorkflowFile,
  evaluateWorkflows,
  fixWorkflowFile,
  fixWorkflows,
  parseRunnerLabels,
  shouldFail,
  summarizeFindings,
};
