#!/usr/bin/env node

"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_RUNNER_FALLBACK,
  DEFAULT_WORKFLOWS_DIR,
  RULES,
  auditWorkflows,
  fixWorkflows,
  shouldFail,
} = require("../src/index.js");

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return 0;
  }

  const cwd = path.resolve(parsed.cwd || process.cwd());
  const command = parsed.command || "check";
  const upstreamRepo = parsed.upstreamRepo || detectRepoSlugFromGit(cwd);
  const upstreamOwner = parsed.upstreamOwner || ownerFromRepoSlug(upstreamRepo);

  if (!["check", "fix"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  if (command === "fix" && !upstreamRepo && !upstreamOwner) {
    throw new Error("Could not detect the upstream repository from git remotes. Pass --upstream-repo <owner/repo> or --upstream-owner <owner>.");
  }

  const options = {
    cwd,
    workflows: parsed.workflows || DEFAULT_WORKFLOWS_DIR,
    upstreamRepo,
    upstreamOwner,
    allowRunners: parsed.allowRunners || "",
    runnerFallback: parsed.runnerFallback || DEFAULT_RUNNER_FALLBACK,
  };

  const result =
    command === "fix"
      ? fixWorkflows({ ...options, dryRun: parsed.dryRun })
      : auditWorkflows(options);

  printResult(result, { command, cwd, dryRun: parsed.dryRun });

  const failOn = parsed.failOn || (command === "check" ? "error" : "none");
  return shouldFail(result.findings, failOn) ? 1 : 0;
}

function parseArgs(argv) {
  const parsed = {};
  const args = [...argv];

  if (args[0] && !args[0].startsWith("-")) {
    parsed.command = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--fix":
        parsed.command = setCommand(parsed.command, "fix", arg);
        break;
      case "--check":
        parsed.command = setCommand(parsed.command, "check", arg);
        break;
      case "--cwd":
        parsed.cwd = requireValue(args, (index += 1), arg);
        break;
      case "--workflows":
        parsed.workflows = requireValue(args, (index += 1), arg);
        break;
      case "--upstream-owner":
        parsed.upstreamOwner = requireValue(args, (index += 1), arg);
        break;
      case "--upstream-repo":
        parsed.upstreamRepo = requireValue(args, (index += 1), arg);
        break;
      case "--allow-runners":
        parsed.allowRunners = requireValue(args, (index += 1), arg);
        break;
      case "--runner-fallback":
        parsed.runnerFallback = requireValue(args, (index += 1), arg);
        break;
      case "--fail-on":
        parsed.failOn = requireValue(args, (index += 1), arg);
        if (!["error", "warning", "none"].includes(parsed.failOn)) {
          throw new Error("--fail-on must be error, warning, or none.");
        }
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function setCommand(currentCommand, nextCommand, flag) {
  if (currentCommand && currentCommand !== nextCommand) {
    throw new Error(`${flag} cannot be combined with the ${currentCommand} command.`);
  }
  return nextCommand;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function detectRepoSlugFromGit(cwd) {
  for (const remoteName of ["upstream", "origin"]) {
    try {
      const remote = childProcess.execFileSync("git", ["remote", "get-url", remoteName], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const slug = parseRepoSlugFromRemote(remote);
      if (slug) {
        return slug;
      }
    } catch {
      continue;
    }
  }
  return "";
}

function ownerFromRepoSlug(repoSlug) {
  const match = String(repoSlug).trim().match(/^([^/]+)\/[^/]+$/);
  return match ? match[1] : "";
}

function parseRepoSlugFromRemote(remote) {
  const sshMatch = remote.match(/^[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  const urlMatch = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (urlMatch) {
    return urlMatch[1];
  }

  return "";
}

function parseOwnerFromRemote(remote) {
  return ownerFromRepoSlug(parseRepoSlugFromRemote(remote));
}

function printResult(result, { command, cwd, dryRun }) {
  if (result.files.length === 0) {
    console.log("No workflow files found.");
    return;
  }

  if (result.findings.length === 0) {
    const summary = `${command === "fix" ? "updated" : "checked"} ${result.files.length} workflow file${result.files.length === 1 ? "" : "s"}`;
    console.log(`ffactions: no issues found (${summary})`);
    return;
  }

  const fileLineCache = new Map();
  const groupedFindings = groupFindingsByRule(result.findings);

  for (const group of groupedFindings) {
    printRuleGroup(group, { cwd, fileLineCache, command });
  }

  console.log("");
  console.log(`${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} in ${result.files.length} workflow file${result.files.length === 1 ? "" : "s"}.`);
  if (command === "fix") {
    const verb = dryRun ? "Would apply" : "Applied";
    console.log(`${verb} ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} across ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}.`);
  }
}

function groupFindingsByRule(findings) {
  const groups = [];
  const byRuleCode = new Map();

  for (const finding of findings) {
    const key = finding.ruleCode || "FF000";
    let group = byRuleCode.get(key);
    if (!group) {
      group = {
        ruleCode: key,
        rule: finding.rule || "workflow-check",
        meta: lookupRuleMeta(finding),
        findings: [],
      };
      byRuleCode.set(key, group);
      groups.push(group);
    }
    group.findings.push(finding);
  }

  return groups;
}

function lookupRuleMeta(finding) {
  for (const rule of Object.values(RULES)) {
    if (rule.code === finding.ruleCode) {
      return rule;
    }
  }
  return {
    code: finding.ruleCode || "FF000",
    slug: finding.rule || "workflow-check",
    title: finding.title || "Workflow check",
    description: "",
  };
}

function printRuleGroup(group, { cwd, fileLineCache, command }) {
  const header = `${group.meta.code} ${group.meta.slug}: ${group.meta.title}`;
  console.log(paint("yellow", header));
  if (group.meta.description) {
    console.log(`${paint("gray", "  =")} ${group.meta.description}`);
  }
  const fileCount = new Set(group.findings.map((finding) => finding.file)).size;
  console.log(`${paint("gray", "  =")} ${group.findings.length} finding${group.findings.length === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`);
  console.log("");

  const fileGroups = groupFindingsByFile(group.findings);
  for (const fileGroup of fileGroups) {
    printFileGroup(fileGroup, { cwd, fileLineCache, command, rule: group.meta });
  }
}

function groupFindingsByFile(findings) {
  const files = [];
  const byFile = new Map();

  for (const finding of findings) {
    let fileGroup = byFile.get(finding.file);
    if (!fileGroup) {
      fileGroup = { file: finding.file, findings: [] };
      byFile.set(finding.file, fileGroup);
      files.push(fileGroup);
    }
    fileGroup.findings.push(finding);
  }

  return files;
}

function printFileGroup(fileGroup, { cwd, fileLineCache, command, rule }) {
  const filePath = path.resolve(cwd, fileGroup.file);
  const fileLines = readFileLines(filePath, fileLineCache);
  const entries = clusterFindings(fileGroup.findings, rule, fileLines);
  let maxLineDigits = 1;

  for (const entry of entries) {
    maxLineDigits = Math.max(maxLineDigits, String(entry.endLine + 1).length);
  }

  console.log(`${paint("cyan", fileGroup.file)} ${paint("gray", `(${fileGroup.findings.length} finding${fileGroup.findings.length === 1 ? "" : "s"})`)}`);
  for (const entry of entries) {
    printEntry(entry, { fileLines, maxLineDigits, command });
  }
  console.log("");
}

function clusterFindings(findings, rule, fileLines) {
  const sorted = [...findings].sort((left, right) => left.line - right.line);
  const threshold = clusterThreshold(rule.code);
  const entries = [];
  let current = null;

  for (const finding of sorted) {
    if (!current || finding.line - current.endLine > threshold) {
      current = createEntryFromFinding(finding);
      entries.push(current);
      continue;
    }

    current.findings.push(finding);
    current.endLine = finding.line;
  }

  for (const entry of entries) {
    entry.note = describeEntry(entry, rule, fileLines);
  }

  return entries;
}

function clusterThreshold(ruleCode) {
  if (ruleCode === RULES.SECRET_GATE.code) {
    return 1;
  }
  if (ruleCode === RULES.PUBLISH_GATE.code) {
    return 2;
  }
  return 0;
}

function createEntryFromFinding(finding) {
  return {
    file: finding.file,
    startLine: finding.line,
    endLine: finding.line,
    findings: [finding],
  };
}

function describeEntry(entry, rule, fileLines) {
  if (rule.code === RULES.RUNNER_LABEL.code) {
    const group = entry.findings[0].message.match(/Runner group(?:\s+(.+?))?\s+requires private runner access/);
    if (group) {
      return group[1] ? `runner group: ${group[1]}` : "runner group";
    }
    const line = entry.findings[0].message.match(/Runner labels? (.+?) (is|are) not known/);
    return line ? `runner label${entry.findings.length === 1 ? "" : "s"}: ${line[1]}` : "private runner label";
  }

  if (rule.code === RULES.RUNNER_EXPRESSION.code) {
    return `expression: ${extractRunnerExpression(entry.findings[0], fileLines)}`;
  }

  if (rule.code === RULES.SECRET_GATE.code) {
    const secretNames = [...new Set(entry.findings.flatMap((finding) => extractSecretNamesFromMessage(finding.message)))];
    return `secret${secretNames.length === 1 ? "" : "s"}: ${secretNames.join(", ")}`;
  }

  if (rule.code === RULES.PUBLISH_GATE.code) {
    return "publish, deploy, or auth trigger";
  }

  return entry.findings[0].title || "workflow finding";
}

function extractRunnerExpression(finding, fileLines) {
  const lineText = fileLines[finding.line - 1] || "";
  const match = lineText.match(/runs-on:\s*\$\{\{\s*(.+?)\s*\}\}/);
  return match ? match[1] : "dynamic runs-on expression";
}

function extractSecretNamesFromMessage(message) {
  const matches = message.match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g);
  return matches ? matches.map((item) => item.replace(/^secrets\./, "")) : [];
}

function printEntry(entry, { fileLines, maxLineDigits, command }) {
  const firstLineText = fileLines[entry.startLine - 1] || "";
  const firstHighlight = inferHighlight(firstLineText, entry.findings[0]);
  const location = `${entry.file}:${entry.startLine}:${firstHighlight.column}`;

  console.log(`${paint("yellow", "  -")} ${paint("yellow", location)} ${paint("gray", `(${entry.note})`)}`);
  printSnippet(fileLines, entry, maxLineDigits);
  if (entry.findings.some((finding) => finding.fixable) && command === "check") {
    console.log(`${paint("gray", "      =")} auto-fix available with ${paint("cyan", "`ffactions fix`")}`);
  }
}

function readFileLines(filePath, fileLineCache) {
  if (!fileLineCache.has(filePath)) {
    try {
      fileLineCache.set(filePath, fs.readFileSync(filePath, "utf8").split(/\r?\n/));
    } catch {
      fileLineCache.set(filePath, []);
    }
  }
  return fileLineCache.get(filePath);
}

function printSnippet(fileLines, entry, maxLineDigits) {
  if (fileLines.length === 0) {
    return;
  }

  const startLine = Math.max(1, entry.startLine - 1);
  const endLine = Math.min(fileLines.length, entry.endLine + 1);
  const gutter = " ".repeat(maxLineDigits);
  const highlightsByLine = new Map();

  for (const finding of entry.findings) {
    const lineText = fileLines[finding.line - 1] || "";
    highlightsByLine.set(finding.line, inferHighlight(lineText, finding));
  }

  console.log(`${paint("gray", `    ${gutter} |`)}`);
  for (let currentLine = startLine; currentLine <= endLine; currentLine += 1) {
    console.log(`${paint("gray", `    ${String(currentLine).padStart(maxLineDigits)} |`)} ${fileLines[currentLine - 1] || ""}`);
    if (highlightsByLine.has(currentLine)) {
      const highlight = highlightsByLine.get(currentLine);
      console.log(
        `${paint("gray", `    ${gutter} |`)} ${" ".repeat(Math.max(highlight.column - 1, 0))}${paint("cyan", "^".repeat(Math.max(highlight.length, 1)))}`
      );
    }
  }
}

function inferHighlight(lineText, finding) {
  const fallbackColumn = Math.max(firstVisibleColumn(lineText), 1);

  if (!lineText) {
    return { column: 1, length: 1 };
  }

  const markerPatterns = {
    "runner-label": /runs-on:/,
    "runner-expression": /runs-on:/,
    "secret-gate": /secrets\.[A-Za-z_][A-Za-z0-9_]*/,
    "publish-gate": /\b(npm\s+publish|twine\s+upload|docker\s+push|gh\s+release\s+(create|upload|edit|delete)|uses:)\b/i,
  };

  const pattern = markerPatterns[finding.rule];
  if (pattern) {
    const match = lineText.match(pattern);
    if (match && match.index != null) {
      return { column: match.index + 1, length: match[0].length };
    }
  }

  return { column: fallbackColumn, length: 1 };
}

function firstVisibleColumn(lineText) {
  const index = lineText.search(/\S/);
  return index === -1 ? 1 : index + 1;
}

function supportsColor() {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(process.stdout.isTTY);
}

function paint(color, text) {
  if (!supportsColor()) {
    return text;
  }

  const codes = {
    gray: "\u001b[90m",
    yellow: "\u001b[33m",
    cyan: "\u001b[36m",
  };

  return `${codes[color] || ""}${text}\u001b[0m`;
}

function printHelp() {
  console.log(`fork-friendly-actions

Evaluate GitHub Actions workflows and make them friendlier to forked PRs.

Usage:
  fork-friendly-actions [options]
  fork-friendly-actions fix [options]
  fork-friendly-actions check [options]

Default upstream scope detection:
  ffactions detects the upstream repository slug from git remotes.
  It prefers the upstream remote and falls back to origin.

Commands:
  check    Evaluate workflows without changing files. Default.
  fix      Evaluate workflows and rewrite fixable fork-hostile patterns.

Options:
  --fix                       Run fix mode. Same as the fix command.
  --check                     Run check mode. Same as the check command.
  --workflows <path>          Workflow file or directory. Default: ${DEFAULT_WORKFLOWS_DIR}
  --upstream-repo <owner/repo> Override the detected upstream repository slug for fork gating.
  --upstream-owner <owner>    Override the detected upstream owner when no repo slug is available.
  --runner-fallback <label>   Public runner label to use for fork fallbacks. Default: ${DEFAULT_RUNNER_FALLBACK}
  --allow-runners <labels>    Comma-separated extra runner labels to treat as fork-friendly.
  --fail-on <level>           Exit nonzero at error, warning, or none. Default: error for check, none for fix.
  --dry-run                   Print what would change without writing files.
  --cwd <path>                Project checkout to evaluate. Default: current directory.
  --help                      Show this help.
`);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`fork-friendly-actions: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  detectRepoSlugFromGit,
  main,
  parseArgs,
  parseOwnerFromRemote,
  parseRepoSlugFromRemote,
};
