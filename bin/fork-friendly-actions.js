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
  const interactiveMode = Boolean(parsed.interactive);
  const fixMode = Boolean(parsed.fix || interactiveMode);
  const upstreamRepo = parsed.upstreamRepo || detectRepoSlugFromGit(cwd);
  const upstreamOwner = parsed.upstreamOwner || ownerFromRepoSlug(upstreamRepo);

  if (fixMode && !upstreamRepo && !upstreamOwner) {
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

  const result = fixMode
    ? fixWorkflows({ ...options, dryRun: parsed.dryRun || interactiveMode })
    : auditWorkflows(options);

  if (interactiveMode) {
    runInteractiveFix(result, { cwd });
  } else {
    printResult(result, { fixMode, cwd, dryRun: parsed.dryRun });
  }

  const failOn = parsed.failOn || (fixMode ? "none" : "error");
  return shouldFail(result.findings, failOn) ? 1 : 0;
}

function parseArgs(argv) {
  const parsed = {};
  const args = [...argv];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--dry-run":
      case "-d":
        parsed.dryRun = true;
        parsed.fix = true;
        break;
      case "--fix":
      case "-f":
        parsed.fix = true;
        break;
      case "--interactive":
      case "-i":
        parsed.interactive = true;
        parsed.fix = true;
        break;
      case "--workflows":
      case "-w":
        parsed.workflows = requireValue(args, (index += 1), arg);
        break;
      case "--upstream-owner":
      case "-o":
        parsed.upstreamOwner = requireValue(args, (index += 1), arg);
        break;
      case "--upstream-repo":
      case "-r":
        parsed.upstreamRepo = requireValue(args, (index += 1), arg);
        break;
      case "--allow-runners":
      case "-a":
        parsed.allowRunners = requireValue(args, (index += 1), arg);
        break;
      case "--runner-fallback":
      case "-R":
        parsed.runnerFallback = requireValue(args, (index += 1), arg);
        break;
      case "--fail-on":
      case "-l":
        parsed.failOn = requireValue(args, (index += 1), arg);
        if (!["error", "warning", "none"].includes(parsed.failOn)) {
          throw new Error("--fail-on must be error, warning, or none.");
        }
        break;
      default:
        if (!arg.startsWith("-") && !parsed.cwd) {
          parsed.cwd = arg;
        } else {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  if (parsed.interactive && parsed.dryRun) {
    throw new Error("--interactive cannot be combined with --dry-run.");
  }

  return parsed;
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

function runInteractiveFix(result, { cwd, stdin = process.stdin, stdout = process.stdout, readChoice = readInteractiveChoice } = {}) {
  if (result.files.length === 0) {
    console.log("No workflow files found.");
    return { appliedChanges: 0, changedFiles: 0, skippedChanges: 0, quit: false };
  }

  if (result.findings.length === 0) {
    console.log(`ffactions: no issues found (checked ${result.files.length} workflow file${result.files.length === 1 ? "" : "s"})`);
    return { appliedChanges: 0, changedFiles: 0, skippedChanges: 0, quit: false };
  }

  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Interactive mode requires a TTY.");
  }

  const interactiveChanges = flattenInteractiveChanges(result.editPlans || []);
  if (interactiveChanges.length === 0) {
    printResult(result, { fixMode: true, cwd, dryRun: false });
    console.log("No fixable changes are available for interactive mode.");
    return { appliedChanges: 0, changedFiles: 0, skippedChanges: 0, quit: false };
  }

  const acceptedEditsByFile = new Map();
  let skippedChanges = 0;
  let quit = false;
  let reviewedChanges = 0;
  let currentScrollTop = 0;

  enterInteractiveScreen(stdout);
  try {
    for (let index = 0; index < interactiveChanges.length; index += 1) {
      const interactiveChange = interactiveChanges[index];
      const priorAcceptedEdits = acceptedEditsByFile.get(interactiveChange.plan.file) || [];
      currentScrollTop = initialScrollTopForInteractiveChange(interactiveChange, priorAcceptedEdits, stdout);

      while (true) {
        const preview = buildInteractivePreview(interactiveChange, priorAcceptedEdits);
        currentScrollTop = clampInteractiveScrollTop(currentScrollTop, preview.lines.length, interactiveViewportHeight(stdout));
        renderInteractiveScreen({
          stdout,
          interactiveChange,
          preview,
          index: index + 1,
          total: interactiveChanges.length,
          fileCount: result.editPlans.length,
          acceptedCount: reviewedChanges - skippedChanges,
          skippedCount: skippedChanges,
          scrollTop: currentScrollTop,
        });

        const choice = readChoice({ stdin, stdout });
        if (choice === "apply") {
          const accepted = acceptedEditsByFile.get(interactiveChange.plan.file) || [];
          accepted.push(interactiveChange.edit);
          acceptedEditsByFile.set(interactiveChange.plan.file, accepted);
          reviewedChanges += 1;
          break;
        }

        if (choice === "skip") {
          reviewedChanges += 1;
          skippedChanges += 1;
          break;
        }

        if (choice === "scroll-down") {
          currentScrollTop += 1;
          continue;
        }

        if (choice === "scroll-up") {
          currentScrollTop -= 1;
          continue;
        }

        if (choice === "page-down") {
          currentScrollTop += Math.max(interactiveViewportHeight(stdout) - 2, 1);
          continue;
        }

        if (choice === "page-up") {
          currentScrollTop -= Math.max(interactiveViewportHeight(stdout) - 2, 1);
          continue;
        }

        quit = true;
        skippedChanges += interactiveChanges.length - index;
        break;
      }

      if (quit) {
        break;
      }
    }
  } finally {
    leaveInteractiveScreen(stdout);
  }

  const applied = applyAcceptedInteractiveChanges(result.editPlans || [], acceptedEditsByFile);
  if (applied.appliedChanges === 0) {
    console.log("No changes applied.");
  } else {
    console.log(
      `Applied ${applied.appliedChanges} accepted change${applied.appliedChanges === 1 ? "" : "s"} across ${applied.changedFiles} file${applied.changedFiles === 1 ? "" : "s"}.`
    );
  }
  if (quit && interactiveChanges.length - reviewedChanges > 0) {
    const remainingChanges = interactiveChanges.length - reviewedChanges;
    console.log(`Stopped with ${remainingChanges} change${remainingChanges === 1 ? "" : "s"} left unreviewed.`);
  } else if (skippedChanges > 0) {
    console.log(`Skipped ${skippedChanges} change${skippedChanges === 1 ? "" : "s"}.`);
  }

  return {
    appliedChanges: applied.appliedChanges,
    changedFiles: applied.changedFiles,
    skippedChanges,
    quit,
  };
}

function flattenInteractiveChanges(editPlans) {
  const changes = [];
  for (const plan of editPlans) {
    for (const edit of plan.edits || []) {
      changes.push({ plan, edit });
    }
  }
  return changes;
}

function buildInteractivePreview(interactiveChange, acceptedEdits) {
  const sourceLines = String(interactiveChange.plan.originalSource).split(/\r?\n/);
  const appliedLines = acceptedEdits.length > 0 ? applyEdits(sourceLines, acceptedEdits) : sourceLines;
  const translatedEdit = translateInteractiveEdit(interactiveChange.edit, acceptedEdits);
  return {
    ...buildInteractiveBuffer(appliedLines, translatedEdit),
    edit: translatedEdit,
  };
}

function translateInteractiveEdit(edit, acceptedEdits) {
  let start = edit.start;
  let end = edit.end;

  for (const acceptedEdit of [...acceptedEdits].sort((left, right) => left.start - right.start)) {
    const delta = acceptedEdit.replacement.length - (acceptedEdit.end - acceptedEdit.start);
    if (acceptedEdit.start <= start) {
      start += delta;
    }
    if (acceptedEdit.start < end || (acceptedEdit.start === end && acceptedEdit.end === acceptedEdit.start)) {
      end += delta;
    }
  }

  return {
    ...edit,
    start,
    end,
  };
}

function buildInteractiveBuffer(lines, edit) {
  const start = Math.max(edit.start, 0);
  const end = Math.max(edit.end, start);
  const width = String(lines.length || 1).length;
  const bufferLines = [];
  let selectedStart = 0;
  let selectedEnd = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (index === start) {
      selectedStart = bufferLines.length;
      for (let removeIndex = start; removeIndex < end; removeIndex += 1) {
        bufferLines.push({
          type: "delete",
          selected: true,
          marker: "-",
          lineNumber: removeIndex + 1,
          text: lines[removeIndex] || "",
        });
      }
      for (const replacementLine of edit.replacement) {
        bufferLines.push({
          type: "add",
          selected: true,
          marker: "+",
          lineNumber: "",
          text: replacementLine,
        });
      }
      selectedEnd = Math.max(bufferLines.length - 1, selectedStart);
      index = Math.max(end - 1, index);
      if (end > start) {
        continue;
      }
    }

    bufferLines.push({
      type: "context",
      selected: false,
      marker: " ",
      lineNumber: index + 1,
      text: lines[index] || "",
    });
  }

  if (start === lines.length) {
    selectedStart = bufferLines.length;
    for (const replacementLine of edit.replacement) {
      bufferLines.push({
        type: "add",
        selected: true,
        marker: "+",
        lineNumber: "",
        text: replacementLine,
      });
    }
    selectedEnd = Math.max(bufferLines.length - 1, selectedStart);
  }

  if (bufferLines.length === 0) {
    bufferLines.push({
      type: "context",
      selected: false,
      marker: " ",
      lineNumber: "",
      text: "",
    });
  }

  return {
    width,
    lines: bufferLines,
    selectedStart,
    selectedEnd,
  };
}

function initialScrollTopForInteractiveChange(interactiveChange, acceptedEdits, stdout) {
  const preview = buildInteractivePreview(interactiveChange, acceptedEdits);
  const viewportHeight = interactiveViewportHeight(stdout);
  const center = Math.max(Math.floor((preview.selectedStart + preview.selectedEnd) / 2), 0);
  return clampInteractiveScrollTop(center - Math.floor(viewportHeight / 3), preview.lines.length, viewportHeight);
}

function clampInteractiveScrollTop(scrollTop, totalLines, viewportHeight) {
  const maxScrollTop = Math.max(totalLines - viewportHeight, 0);
  return Math.max(0, Math.min(scrollTop, maxScrollTop));
}

function interactiveViewportHeight(stdout) {
  const { rows } = terminalSize(stdout);
  return Math.max(rows - 6, 5);
}

function renderInteractiveScreen({ stdout, interactiveChange, preview, index, total, fileCount, acceptedCount, skippedCount, scrollTop }) {
  const { columns, rows } = terminalSize(stdout);
  const headerLines = [
    `Interactive fix mode: ${total} proposed change${total === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
    `[${index}/${total}] ${interactiveChange.edit.title}`,
    `${interactiveChange.plan.file}:${preview.edit.start + 1}  accepted ${acceptedCount}  skipped ${skippedCount}`,
  ];
  const footerLines = [
    "y apply  n skip  q quit  j/k or arrows scroll  PgUp/PgDn page",
    `Lines ${Math.min(scrollTop + 1, preview.lines.length)}-${Math.min(scrollTop + interactiveViewportHeight(stdout), preview.lines.length)} of ${preview.lines.length}`,
  ];
  const bodyHeight = Math.max(rows - headerLines.length - footerLines.length - 1, 5);
  const visibleLines = preview.lines.slice(scrollTop, scrollTop + bodyHeight);

  const output = [];
  output.push("\u001b[H\u001b[2J");
  output.push(paint("yellow", truncateLine(headerLines[0], columns)));
  output.push(paint("yellow", truncateLine(headerLines[1], columns)));
  output.push(paint("cyan", truncateLine(headerLines[2], columns)));
  output.push(paint("gray", truncateLine("─".repeat(Math.max(columns, 1)), columns)));

  for (const line of visibleLines) {
    output.push(renderInteractiveBufferLine(line, preview.width, columns));
  }
  for (let index = visibleLines.length; index < bodyHeight; index += 1) {
    output.push("");
  }

  output.push(paint("gray", truncateLine("─".repeat(Math.max(columns, 1)), columns)));
  output.push(paint("gray", truncateLine(footerLines[0], columns)));
  output.push(paint("gray", truncateLine(footerLines[1], columns)));

  stdout.write(output.join("\n"));
}

function renderInteractiveBufferLine(line, width, columns) {
  const selectionMarker = line.selected ? ">" : " ";
  const lineNumber = line.lineNumber === "" ? " ".repeat(width) : String(line.lineNumber).padStart(width);
  const rendered = `${selectionMarker}${line.marker} ${lineNumber} | ${line.text}`;
  const truncated = truncateLine(rendered, columns);

  if (line.selected && line.type === "add") {
    return paintStyle("selectedAdd", truncated);
  }
  if (line.selected && line.type === "delete") {
    return paintStyle("selectedDelete", truncated);
  }
  if (line.selected) {
    return paintStyle("selected", truncated);
  }
  if (line.type === "add") {
    return paint("green", truncated);
  }
  if (line.type === "delete") {
    return paint("red", truncated);
  }
  return truncated;
}

function truncateLine(text, columns) {
  const width = Math.max(columns || 80, 20);
  if (text.length <= width) {
    return text;
  }
  return `${text.slice(0, Math.max(width - 1, 1))}…`;
}

function terminalSize(stdout) {
  return {
    columns: Math.max(Number(stdout.columns) || 100, 40),
    rows: Math.max(Number(stdout.rows) || 30, 12),
  };
}

function enterInteractiveScreen(stdout) {
  stdout.write("\u001b[?1049h\u001b[?25l");
}

function leaveInteractiveScreen(stdout) {
  stdout.write("\u001b[?25h\u001b[?1049l");
}

function applyAcceptedInteractiveChanges(editPlans, acceptedEditsByFile) {
  let appliedChanges = 0;
  let changedFiles = 0;

  for (const plan of editPlans) {
    const acceptedEdits = acceptedEditsByFile.get(plan.file) || [];
    if (acceptedEdits.length === 0) {
      continue;
    }

    const lines = String(plan.originalSource).split(/\r?\n/);
    const fixedLines = applyEdits(lines, acceptedEdits);
    fs.writeFileSync(plan.filePath, fixedLines.join(plan.lineEnding));
    appliedChanges += acceptedEdits.length;
    changedFiles += 1;
  }

  return {
    appliedChanges,
    changedFiles,
  };
}

function applyEdits(lines, edits) {
  const fixed = [...lines];
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    fixed.splice(edit.start, edit.end - edit.start, ...edit.replacement);
  }
  return fixed;
}

function readInteractiveChoice({ stdin = process.stdin, stdout = process.stdout, readSync = fs.readSync, sleep = sleepMs } = {}) {
  const buffer = Buffer.alloc(16);
  const wasRaw = Boolean(stdin.isRaw);

  try {
    stdin.setRawMode(true);
    stdin.resume();

    while (true) {
      let bytesRead = 0;
      try {
        bytesRead = readSync(stdin.fd, buffer, 0, buffer.length, null);
      } catch (error) {
        if (isRetryableReadError(error)) {
          sleep(10);
          continue;
        }
        throw error;
      }
      if (bytesRead <= 0) {
        sleep(10);
        continue;
      }

      const choice = parseInteractiveAction(buffer.subarray(0, bytesRead));
      if (!choice) {
        continue;
      }
      return choice;
    }
  } finally {
    stdin.setRawMode(wasRaw);
    if (!wasRaw) {
      stdin.pause();
    }
  }
}

function isRetryableReadError(error) {
  return Boolean(error && ["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(error.code));
}

function sleepMs(durationMs) {
  const timeout = Math.max(0, Number(durationMs) || 0);
  if (timeout === 0) {
    return;
  }

  const shared = new SharedArrayBuffer(4);
  const state = new Int32Array(shared);
  Atomics.wait(state, 0, 0, timeout);
}

function parseInteractiveChoice(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  const first = text[0] ? text[0].toLowerCase() : "";

  if (first === "y") {
    return "apply";
  }
  if (first === "n") {
    return "skip";
  }
  if (first === "q" || first === "\u001b" || first === "\u0003") {
    return "quit";
  }
  return "";
}

function parseInteractiveAction(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  if (text === "j" || text === "\u001b[B") {
    return "scroll-down";
  }
  if (text === "k" || text === "\u001b[A") {
    return "scroll-up";
  }
  if (text === "\u001b[6~") {
    return "page-down";
  }
  if (text === "\u001b[5~") {
    return "page-up";
  }
  return parseInteractiveChoice(text);
}

function printResult(result, { fixMode, cwd, dryRun }) {
  if (result.files.length === 0) {
    console.log("No workflow files found.");
    return;
  }

  if (result.findings.length === 0) {
    const summary = `${fixMode ? "updated" : "checked"} ${result.files.length} workflow file${result.files.length === 1 ? "" : "s"}`;
    console.log(`ffactions: no issues found (${summary})`);
    return;
  }

  const fileLineCache = new Map();

  if (dryRun) {
    if (result.fileChanges && result.fileChanges.length > 0) {
      console.log(paint("cyan", "Dry Run Diff:"));
      console.log("");
      for (const { file, originalSource, fixedSource } of result.fileChanges) {
        const tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ffactions-diff-"));
        const originalPath = path.join(tmpDir, "a.yml");
        const fixedPath = path.join(tmpDir, "b.yml");
        fs.writeFileSync(originalPath, originalSource);
        fs.writeFileSync(fixedPath, fixedSource);

        try {
          const diffArgs = ["diff", "--no-index", "--unified=3"];
          if (supportsColor()) {
            diffArgs.push("--color=always");
          }
          diffArgs.push(originalPath, fixedPath);
          const diffResult = childProcess.spawnSync("git", diffArgs, { encoding: "utf8" });
          
          let diffOutput = diffResult.stdout || "";
          diffOutput = diffOutput.replace(new RegExp(escapeRegExp(originalPath), "g"), `a/${file}`);
          diffOutput = diffOutput.replace(new RegExp(escapeRegExp(fixedPath), "g"), `b/${file}`);
          console.log(diffOutput.trimEnd());
          console.log("");
        } catch (e) {
          // If git is missing, fallback gracefully
          console.log(paint("yellow", `--- a/${file}`));
          console.log(paint("yellow", `+++ b/${file}`));
          console.log(paint("gray", "(install git for full diff output)"));
          console.log("");
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    } else {
      console.log("No fixable changes found.");
    }
    console.log(`Would apply ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} across ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}.`);
    return;
  }

  const groupedFindings = groupFindingsByRule(result.findings);

  for (const group of groupedFindings) {
    printRuleGroup(group, { cwd, fileLineCache, fixMode });
  }

  console.log("");
  console.log(`${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} in ${result.files.length} workflow file${result.files.length === 1 ? "" : "s"}.`);
  if (fixMode) {
    console.log(`Applied ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} across ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}.`);
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

function printRuleGroup(group, { cwd, fileLineCache, fixMode }) {
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
    printFileGroup(fileGroup, { cwd, fileLineCache, fixMode, rule: group.meta });
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

function printFileGroup(fileGroup, { cwd, fileLineCache, fixMode, rule }) {
  const filePath = path.resolve(cwd, fileGroup.file);
  const fileLines = readFileLines(filePath, fileLineCache);
  const entries = clusterFindings(fileGroup.findings, rule, fileLines);
  let maxLineDigits = 1;

  for (const entry of entries) {
    maxLineDigits = Math.max(maxLineDigits, String(entry.endLine + 1).length);
  }

  console.log(`${paint("cyan", fileGroup.file)} ${paint("gray", `(${fileGroup.findings.length} finding${fileGroup.findings.length === 1 ? "" : "s"})`)}`);
  for (const entry of entries) {
    printEntry(entry, { fileLines, maxLineDigits, fixMode });
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
    if (entry.findings.some((finding) => /inherits all caller secrets/.test(finding.message))) {
      return "secrets: inherit";
    }
    const secretNames = [...new Set(entry.findings.flatMap((finding) => extractSecretNamesFromMessage(finding.message)))];
    return `secret${secretNames.length === 1 ? "" : "s"}: ${secretNames.join(", ")}`;
  }

  if (rule.code === RULES.PUBLISH_GATE.code) {
    return "publish, deploy, or auth trigger";
  }

  if (rule.code === RULES.SNAPSHOT_GATE.code) {
    return "snapshot custom-image job";
  }

  if (rule.code === RULES.NEEDS_GATE.code) {
    return "depends on upstream-only job";
  }

  if (rule.code === RULES.OUTPUT_GATE.code) {
    return "depends on gated output producer";
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

function printEntry(entry, { fileLines, maxLineDigits, fixMode }) {
  const firstHighlight = resolveHighlight(fileLines, entry.findings[0]);
  const location = `${entry.file}:${entry.startLine}:${firstHighlight.column}`;
  const isFixable = entry.findings.some((finding) => finding.fixable);
  const fixIcon = isFixable ? "✅" : "⚠️";

  console.log(`${paint("yellow", "  -")} ${fixIcon} ${paint("yellow", location)} ${paint("gray", `(${entry.note})`)}`);
  printSnippet(fileLines, entry, maxLineDigits);
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
    const highlight = resolveHighlight(fileLines, finding);
    if (!highlightsByLine.has(highlight.line)) {
      highlightsByLine.set(highlight.line, []);
    }
    highlightsByLine.get(highlight.line).push(highlight);
  }

  console.log(`${paint("gray", `    ${gutter} |`)}`);
  for (let currentLine = startLine; currentLine <= endLine; currentLine += 1) {
    console.log(`${paint("gray", `    ${String(currentLine).padStart(maxLineDigits)} |`)} ${fileLines[currentLine - 1] || ""}`);
    if (highlightsByLine.has(currentLine)) {
      for (const highlight of highlightsByLine.get(currentLine)) {
        console.log(
          `${paint("gray", `    ${gutter} |`)} ${" ".repeat(Math.max(highlight.column - 1, 0))}${paint("cyan", "^".repeat(Math.max(highlight.length, 1)))}`
        );
      }
    }
  }
}

function resolveHighlight(fileLines, finding) {
  if (finding.location && typeof finding.location.line === "number") {
    return {
      line: finding.location.line,
      column: Math.max(finding.location.column || 1, 1),
      length: Math.max(finding.location.length || 1, 1),
    };
  }

  const lineText = fileLines[finding.line - 1] || "";
  const highlight = inferHighlight(lineText, finding);
  return {
    line: finding.line,
    column: highlight.column,
    length: highlight.length,
  };
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
    "snapshot-gate": /snapshot:/,
    "needs-gate": /needs:/,
    "output-gate": /(?:outputs:|steps\.[A-Za-z_][A-Za-z0-9_-]*\.outputs|jobs\.[A-Za-z_][A-Za-z0-9_-]*\.outputs)/,
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

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    red: "\u001b[31m",
    green: "\u001b[32m",
    yellow: "\u001b[33m",
    cyan: "\u001b[36m",
  };

  return `${codes[color] || ""}${text}\u001b[0m`;
}

function paintStyle(style, text) {
  if (!supportsColor()) {
    return text;
  }

  const codes = {
    selected: "\u001b[7m",
    selectedAdd: "\u001b[1;30;102m",
    selectedDelete: "\u001b[1;37;41m",
  };

  return `${codes[style] || ""}${text}\u001b[0m`;
}

function printHelp() {
  console.log(`fork-friendly-actions

Evaluate GitHub Actions workflows and make them friendlier to forked PRs.

Usage:
  fork-friendly-actions [options] [path]

Default upstream scope detection:
  ffactions detects the upstream repository slug from git remotes.
  It prefers the upstream remote and falls back to origin.

Options:
  -f, --fix                   Evaluate workflows and rewrite fixable fork-hostile patterns.
  -i, --interactive           Review each proposed fix interactively and apply accepted changes.
  -w, --workflows <path>      Workflow file or directory. Default: ${DEFAULT_WORKFLOWS_DIR}
  -r, --upstream-repo <slug>  Override the detected upstream repository slug for fork gating.
  -o, --upstream-owner <name> Override the detected upstream owner when no repo slug is available.
  -R, --runner-fallback <lbl> Public runner label to use for fork fallbacks. Default: ${DEFAULT_RUNNER_FALLBACK}
  -a, --allow-runners <lbls>  Comma-separated extra runner labels to treat as fork-friendly.
  -l, --fail-on <level>       Exit nonzero at error, warning, or none. Default: error (none when --fix is used).
  -d, --dry-run               Print what would change without writing files.
  -h, --help                  Show this help.

Arguments:
  [path]                      Project checkout to evaluate. Default: current directory.
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
  applyAcceptedInteractiveChanges,
  buildInteractiveBuffer,
  detectRepoSlugFromGit,
  main,
  parseInteractiveAction,
  parseInteractiveChoice,
  readInteractiveChoice,
  parseArgs,
  parseOwnerFromRemote,
  parseRepoSlugFromRemote,
  runInteractiveFix,
};
