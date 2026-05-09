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

const EMBEDDED_CLI_PACKAGE_VERSION = null;
const EMBEDDED_CLI_BUILD_SHA = null;

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return 0;
  }

  if (parsed.version) {
    console.log(resolveCliVersion());
    return 0;
  }

  const target = resolveCliTarget(parsed);
  const cwd = target.cwd;
  const interactiveMode = Boolean(parsed.interactive);
  const fixMode = Boolean(parsed.fix || interactiveMode);
  const upstreamRepo = parsed.upstreamRepo || detectRepoSlugFromGit(cwd);
  const upstreamOwner = parsed.upstreamOwner || ownerFromRepoSlug(upstreamRepo);

  if (fixMode && !upstreamRepo && !upstreamOwner) {
    throw new Error("Could not detect the upstream repository from git remotes. Pass --upstream-repo <owner/repo> or --upstream-owner <owner>.");
  }

  const options = {
    cwd,
    workflows: target.workflows,
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
      case "--version":
      case "-v":
        parsed.version = true;
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

function resolveCliVersion({ cwd = path.resolve(__dirname, "..") } = {}) {
  const version = process.env.FFACTIONS_VERSION || EMBEDDED_CLI_PACKAGE_VERSION || readCliPackageVersion();
  const buildSha = Object.prototype.hasOwnProperty.call(process.env, "FFACTIONS_BUILD_SHA")
    ? process.env.FFACTIONS_BUILD_SHA
    : EMBEDDED_CLI_BUILD_SHA || detectGitShortSha(cwd);
  return formatCliVersion({ version, buildSha });
}

function formatCliVersion({ version, buildSha }) {
  const normalizedVersion = String(version || "0.0.0").trim();
  const normalizedSha = String(buildSha || "").trim();
  if (!normalizedSha) {
    return normalizedVersion;
  }
  return `${normalizedVersion}+${normalizedSha.slice(0, 8)}`;
}

function readCliPackageVersion() {
  try {
    const packagePath = path.resolve(__dirname, "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function detectGitShortSha(cwd) {
  try {
    return childProcess.execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function resolveCliTarget(parsed, baseCwd = process.cwd()) {
  if (parsed.workflows) {
    return {
      cwd: path.resolve(baseCwd, parsed.cwd || "."),
      workflows: parsed.workflows,
    };
  }

  const targetPath = path.resolve(baseCwd, parsed.cwd || ".");
  if (parsed.cwd && isExistingFile(targetPath)) {
    return {
      cwd: path.dirname(targetPath),
      workflows: path.basename(targetPath),
    };
  }

  return {
    cwd: targetPath,
    workflows: DEFAULT_WORKFLOWS_DIR,
  };
}

function isExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
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

  const decisions = new Map();
  let quit = false;
  let currentIndex = findFirstPendingInteractiveIndex(interactiveChanges, decisions);
  let currentScrollTop = 0;
  let focusedKey = "";
  const resizeTracker = createResizeTracker(stdout);

  enterInteractiveScreen(stdout);
  try {
    while (currentIndex !== -1) {
      const interactiveChange = interactiveChanges[currentIndex];
      const preview = buildInteractivePreview(interactiveChange.plan, decisions, interactiveChange.edit.key);
      const visualPreview = expandInteractiveVisualLines(preview, terminalSize(stdout).columns);
      const focusChanged = interactiveChange.edit.key !== focusedKey;
      resizeTracker.consume();

      if (focusChanged) {
        currentScrollTop = initialScrollTopForInteractiveChange(visualPreview, stdout);
        focusedKey = interactiveChange.edit.key;
      } else {
        currentScrollTop = clampInteractiveScrollTop(currentScrollTop, visualPreview.lines.length, interactiveViewportHeight(stdout));
      }

      renderInteractiveScreen({
        stdout,
        interactiveChange,
        preview: visualPreview,
        index: currentIndex + 1,
        total: interactiveChanges.length,
        fileCount: result.editPlans.length,
        fileIndex: interactiveFilePosition(interactiveChanges, currentIndex).index,
        fileTotal: interactiveFilePosition(interactiveChanges, currentIndex).total,
        reviewCounts: summarizeInteractiveDecisions(interactiveChanges, decisions),
        scrollTop: currentScrollTop,
      });

      const choice = readChoice({ stdin, stdout, shouldRefresh: () => resizeTracker.isPending() });
      if (choice === "resize") {
        continue;
      }

      if (choice === "apply") {
        decisions.set(interactiveChange.edit.key, "accepted");
        currentIndex = nextPendingInteractiveIndex(interactiveChanges, decisions, currentIndex);
        focusedKey = "";
        continue;
      }

      if (choice === "skip") {
        decisions.set(interactiveChange.edit.key, "skipped");
        currentIndex = nextPendingInteractiveIndex(interactiveChanges, decisions, currentIndex);
        focusedKey = "";
        continue;
      }

      if (choice === "next-diff") {
        currentIndex = nextPendingInteractiveIndex(interactiveChanges, decisions, currentIndex);
        focusedKey = "";
        continue;
      }

      if (choice === "prev-diff") {
        currentIndex = previousPendingInteractiveIndex(interactiveChanges, decisions, currentIndex);
        focusedKey = "";
        continue;
      }

      if (choice === "next-file") {
        currentIndex = nextPendingInteractiveFileIndex(interactiveChanges, decisions, currentIndex, 1);
        focusedKey = "";
        continue;
      }

      if (choice === "prev-file") {
        currentIndex = nextPendingInteractiveFileIndex(interactiveChanges, decisions, currentIndex, -1);
        focusedKey = "";
        continue;
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
      break;
    }
  } finally {
    resizeTracker.cleanup();
    leaveInteractiveScreen(stdout);
  }

  const acceptedEditsByFile = collectAcceptedInteractiveEdits(interactiveChanges, decisions);
  const applied = applyAcceptedInteractiveChanges(result.editPlans || [], acceptedEditsByFile);
  const reviewCounts = summarizeInteractiveDecisions(interactiveChanges, decisions);
  if (applied.appliedChanges === 0) {
    console.log("No changes applied.");
  } else {
    console.log(
      `Applied ${applied.appliedChanges} accepted change${applied.appliedChanges === 1 ? "" : "s"} across ${applied.changedFiles} file${applied.changedFiles === 1 ? "" : "s"}.`
    );
  }
  if (quit && reviewCounts.pendingCount > 0) {
    const remainingChanges = reviewCounts.pendingCount;
    console.log(`Stopped with ${remainingChanges} change${remainingChanges === 1 ? "" : "s"} left unreviewed.`);
  } else if (reviewCounts.skippedCount > 0) {
    console.log(`Skipped ${reviewCounts.skippedCount} change${reviewCounts.skippedCount === 1 ? "" : "s"}.`);
  }

  return {
    appliedChanges: applied.appliedChanges,
    changedFiles: applied.changedFiles,
    skippedChanges: reviewCounts.skippedCount,
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

function summarizeInteractiveDecisions(interactiveChanges, decisions) {
  let acceptedCount = 0;
  let skippedCount = 0;
  let pendingCount = 0;

  for (const change of interactiveChanges) {
    const decision = decisions.get(change.edit.key) || "pending";
    if (decision === "accepted") {
      acceptedCount += 1;
    } else if (decision === "skipped") {
      skippedCount += 1;
    } else {
      pendingCount += 1;
    }
  }

  return { acceptedCount, skippedCount, pendingCount };
}

function collectAcceptedInteractiveEdits(interactiveChanges, decisions) {
  const acceptedEditsByFile = new Map();

  for (const change of interactiveChanges) {
    if (decisions.get(change.edit.key) !== "accepted") {
      continue;
    }
    const accepted = acceptedEditsByFile.get(change.plan.file) || [];
    accepted.push(change.edit);
    acceptedEditsByFile.set(change.plan.file, accepted);
  }

  return acceptedEditsByFile;
}

function findFirstPendingInteractiveIndex(interactiveChanges, decisions) {
  return interactiveChanges.findIndex((change) => !decisions.has(change.edit.key));
}

function nextPendingInteractiveIndex(interactiveChanges, decisions, currentIndex) {
  for (let index = currentIndex + 1; index < interactiveChanges.length; index += 1) {
    if (!decisions.has(interactiveChanges[index].edit.key)) {
      return index;
    }
  }
  for (let index = 0; index < currentIndex; index += 1) {
    if (!decisions.has(interactiveChanges[index].edit.key)) {
      return index;
    }
  }
  return -1;
}

function previousPendingInteractiveIndex(interactiveChanges, decisions, currentIndex) {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (!decisions.has(interactiveChanges[index].edit.key)) {
      return index;
    }
  }
  for (let index = interactiveChanges.length - 1; index > currentIndex; index -= 1) {
    if (!decisions.has(interactiveChanges[index].edit.key)) {
      return index;
    }
  }
  return currentIndex;
}

function nextPendingInteractiveFileIndex(interactiveChanges, decisions, currentIndex, direction) {
  const currentFile = interactiveChanges[currentIndex].plan.file;
  let sawDifferentFile = false;

  for (let offset = 1; offset <= interactiveChanges.length; offset += 1) {
    const index = (currentIndex + offset * direction + interactiveChanges.length) % interactiveChanges.length;
    const change = interactiveChanges[index];
    if (decisions.has(change.edit.key)) {
      continue;
    }
    if (change.plan.file !== currentFile) {
      sawDifferentFile = true;
      return index;
    }
    if (sawDifferentFile) {
      return index;
    }
  }

  return currentIndex;
}

function interactiveFilePosition(interactiveChanges, currentIndex) {
  const files = [...new Set(interactiveChanges.map((change) => change.plan.file))];
  const currentFile = interactiveChanges[currentIndex].plan.file;
  return {
    index: files.indexOf(currentFile) + 1,
    total: files.length,
  };
}

function buildInteractivePreview(plan, decisions, focusedKey) {
  return buildInteractiveReviewBuffer(String(plan.originalSource).split(/\r?\n/), plan.edits || [], decisions, focusedKey);
}

function buildInteractiveBuffer(lines, edit) {
  const syntheticEdit = { ...edit, key: edit.key || "__focused__" };
  return buildInteractiveReviewBuffer(lines, [syntheticEdit], new Map(), syntheticEdit.key);
}

function buildInteractiveReviewBuffer(lines, edits, decisions, focusedKey) {
  const width = String(lines.length || 1).length;
  const bufferLines = [];
  const sortedEdits = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let selectedStart = 0;
  let selectedEnd = 0;
  let cursor = 0;
  let foundSelection = false;

  for (const edit of sortedEdits) {
    const start = Math.max(edit.start, 0);
    const end = Math.max(edit.end, start);
    for (let index = cursor; index < Math.min(start, lines.length); index += 1) {
      bufferLines.push(makeInteractiveBufferLine("context", width, index + 1, lines[index] || ""));
    }

    const decision = decisions.get(edit.key) || "pending";
    const isFocused = decision === "pending" && edit.key === focusedKey;
    if (decision === "skipped") {
      for (let index = start; index < Math.min(end, lines.length); index += 1) {
        bufferLines.push(makeInteractiveBufferLine("context", width, index + 1, lines[index] || ""));
      }
      cursor = end;
      continue;
    }

    const selectionStart = bufferLines.length;
    if (decision === "pending") {
      for (let index = start; index < Math.min(end, lines.length); index += 1) {
        bufferLines.push(makeInteractiveBufferLine(isFocused ? "focused-delete" : "pending-delete", width, index + 1, lines[index] || ""));
      }
    }

    for (const replacementLine of edit.replacement) {
      const type = decision === "accepted" ? "accepted-add" : isFocused ? "focused-add" : "pending-add";
      bufferLines.push(makeInteractiveBufferLine(type, width, "", replacementLine));
    }

    const selectionEnd = Math.max(bufferLines.length - 1, selectionStart);
    if (isFocused && !foundSelection) {
      selectedStart = selectionStart;
      selectedEnd = selectionEnd;
      foundSelection = true;
    }
    cursor = end;
  }

  for (let index = cursor; index < lines.length; index += 1) {
    bufferLines.push(makeInteractiveBufferLine("context", width, index + 1, lines[index] || ""));
  }

  if (bufferLines.length === 0) {
    bufferLines.push(makeInteractiveBufferLine("context", width, "", ""));
  }

  return {
    width,
    lines: bufferLines,
    selectedStart,
    selectedEnd,
  };
}

function makeInteractiveBufferLine(type, width, lineNumber, text) {
  return {
    type,
    selected: type.startsWith("focused-"),
    marker: type.includes("add") ? "+" : type.includes("delete") ? "-" : " ",
    lineNumber: lineNumber === "" ? " ".repeat(width) : String(lineNumber).padStart(width),
    text,
  };
}

function expandInteractiveVisualLines(preview, columns) {
  const visualLines = [];
  let selectedStart = 0;
  let selectedEnd = 0;

  for (const line of preview.lines) {
    const wrappedLines = wrapInteractiveBufferLine(line, columns);
    const startIndex = visualLines.length;
    visualLines.push(...wrappedLines);
    if (line.selected) {
      if (selectedStart === 0 && selectedEnd === 0) {
        selectedStart = startIndex;
      }
      selectedEnd = visualLines.length - 1;
    }
  }

  return {
    lines: visualLines,
    selectedStart,
    selectedEnd,
  };
}

function wrapInteractiveBufferLine(line, columns) {
  const selectionMarker = line.selected ? ">" : " ";
  const prefix = `${selectionMarker}${line.marker} ${line.lineNumber} | `;
  const continuationPrefix = `   ${" ".repeat(line.lineNumber.length)} | `;
  const contentWidth = Math.max(columns - prefix.length, 8);
  const chunks = wrapPlainText(line.text || "", contentWidth);
  const wrapped = [];

  for (let index = 0; index < chunks.length; index += 1) {
    wrapped.push({
      type: line.type,
      text: `${index === 0 ? prefix : continuationPrefix}${chunks[index]}`,
    });
  }

  return wrapped;
}

function wrapPlainText(text, width) {
  if (!text) {
    return [""];
  }
  const chunks = [];
  let remaining = text;

  while (remaining.length > width) {
    const slice = remaining.slice(0, width);
    const breakIndex = findWrapBoundary(slice);
    chunks.push(remaining.slice(0, breakIndex));
    remaining = remaining.slice(breakIndex);
    if (!remaining) {
      break;
    }
    remaining = remaining.replace(/^[ ]+/, "");
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.length > 0 ? chunks : [""];
}

function findWrapBoundary(slice) {
  const preferredBreaks = [" || ", " && ", " == ", " != ", ", ", " ", ")", "}", "]", "/"];
  for (const token of preferredBreaks) {
    const index = slice.lastIndexOf(token);
    if (index > 0) {
      return index + token.length;
    }
  }
  return slice.length;
}

function initialScrollTopForInteractiveChange(preview, stdout) {
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

function renderInteractiveScreen({ stdout, interactiveChange, preview, index, total, fileCount, fileIndex, fileTotal, reviewCounts, scrollTop }) {
  const { columns, rows } = terminalSize(stdout);
  const headerLines = [
    `Interactive fix mode: ${total} proposed change${total === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
    `[${index}/${total}] ${interactiveChange.edit.title}`,
    `${interactiveChange.plan.file}:${interactiveChange.edit.start + 1}  file ${fileIndex}/${fileTotal}  accepted ${reviewCounts.acceptedCount}  skipped ${reviewCounts.skippedCount}  pending ${reviewCounts.pendingCount}`,
  ];
  const footerLines = [];
  footerLines.push(...buildInteractiveLegendLines(columns, [
    ["y", "apply"],
    ["n", "skip"],
    ["q", "quit"],
    ["← →", "prev/next diff"],
    ["↑ ↓", "scroll"],
    ["PgUp PgDn", "page"],
  ]));
  if (fileTotal > 1) {
    footerLines.push(...buildInteractiveLegendLines(columns, [["{ }", "prev/next file"]]));
  }
  footerLines.push(paint("yellow", `Lines ${Math.min(scrollTop + 1, preview.lines.length)}-${Math.min(scrollTop + interactiveViewportHeight(stdout), preview.lines.length)} of ${preview.lines.length}`));
  const bodyHeight = Math.max(rows - headerLines.length - footerLines.length - 2, 5);
  const visibleLines = preview.lines.slice(scrollTop, scrollTop + bodyHeight);

  const output = [];
  output.push("\u001b[H\u001b[2J");
  output.push(paint("yellow", truncateLine(headerLines[0], columns)));
  output.push(paint("yellow", truncateLine(headerLines[1], columns)));
  output.push(paint("cyan", truncateLine(headerLines[2], columns)));
  output.push(paint("gray", truncateLine("─".repeat(Math.max(columns, 1)), columns)));

  for (const line of visibleLines) {
    output.push(renderInteractiveBufferLine(line, columns));
  }
  for (let index = visibleLines.length; index < bodyHeight; index += 1) {
    output.push("");
  }

  output.push(paint("gray", truncateLine("─".repeat(Math.max(columns, 1)), columns)));
  for (const footerLine of footerLines) {
    output.push(footerLine);
  }

  stdout.write(output.join("\n"));
}

function buildInteractiveLegendLines(columns, items) {
  const lines = [];
  let currentLine = "";

  for (const item of items) {
    const renderedItem = formatInteractiveLegendItem(item);
    const separator = currentLine ? paint("gray", "  ") : "";
    const candidate = currentLine ? `${currentLine}${separator}${renderedItem}` : renderedItem;

    if (currentLine && visibleTextWidth(candidate) > columns) {
      lines.push(currentLine);
      currentLine = renderedItem;
      continue;
    }

    currentLine = candidate;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function formatInteractiveLegendItem([key, label]) {
  return `${paintStyle("legendKey", key)} ${paint("cyan", label)}`;
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function visibleTextWidth(text) {
  return stripAnsi(text).length;
}

function renderInteractiveBufferLine(line, columns) {
  const truncated = truncateLine(line.text, columns);

  if (line.type === "focused-add") {
    return paintStyle("selectedAdd", truncated);
  }
  if (line.type === "focused-delete") {
    return paintStyle("selectedDelete", truncated);
  }
  if (line.type === "pending-add") {
    return paint("dimGreen", truncated);
  }
  if (line.type === "pending-delete") {
    return paint("dimRed", truncated);
  }
  if (line.type === "accepted-add") {
    return paint("green", truncated);
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

function createResizeTracker(stdout) {
  let pending = false;
  const listeners = [];
  const onResize = () => {
    pending = true;
  };

  for (const target of [stdout, process.stdout]) {
    if (!target || typeof target.on !== "function") {
      continue;
    }
    target.on("resize", onResize);
    listeners.push(() => {
      if (typeof target.off === "function") {
        target.off("resize", onResize);
      } else if (typeof target.removeListener === "function") {
        target.removeListener("resize", onResize);
      }
    });
  }

  if (typeof process.on === "function") {
    process.on("SIGWINCH", onResize);
    listeners.push(() => {
      if (typeof process.off === "function") {
        process.off("SIGWINCH", onResize);
      } else if (typeof process.removeListener === "function") {
        process.removeListener("SIGWINCH", onResize);
      }
    });
  }

  return {
    isPending() {
      return pending;
    },
    consume() {
      const value = pending;
      pending = false;
      return value;
    },
    cleanup() {
      for (const remove of listeners) {
        remove();
      }
    },
  };
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

function readInteractiveChoice({ stdin = process.stdin, stdout = process.stdout, readSync = fs.readSync, sleep = sleepMs, shouldRefresh = () => false } = {}) {
  const buffer = Buffer.alloc(16);
  const wasRaw = Boolean(stdin.isRaw);

  try {
    stdin.setRawMode(true);
    stdin.resume();

    while (true) {
      if (shouldRefresh()) {
        return "resize";
      }
      let bytesRead = 0;
      try {
        bytesRead = readSync(stdin.fd, buffer, 0, buffer.length, null);
      } catch (error) {
        if (isRetryableReadError(error)) {
          if (shouldRefresh()) {
            return "resize";
          }
          sleep(10);
          continue;
        }
        throw error;
      }
      if (bytesRead <= 0) {
        if (shouldRefresh()) {
          return "resize";
        }
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
  if (first === "q" || text === "\u001b" || text === "\u0003") {
    return "quit";
  }
  return "";
}

function parseInteractiveAction(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  const mouseScroll = parseMouseScrollAction(text);
  if (mouseScroll) {
    return mouseScroll;
  }
  if (text === "\u001b[B") {
    return "scroll-down";
  }
  if (text === "\u001b[A") {
    return "scroll-up";
  }
  if (text === "\u001b[6~") {
    return "page-down";
  }
  if (text === "\u001b[5~") {
    return "page-up";
  }
  if (text === "\u001b[C") {
    return "next-diff";
  }
  if (text === "\u001b[D") {
    return "prev-diff";
  }
  if (text === "]") {
    return "next-diff";
  }
  if (text === "[") {
    return "prev-diff";
  }
  if (text === "}") {
    return "next-file";
  }
  if (text === "{") {
    return "prev-file";
  }
  return parseInteractiveChoice(text);
}

function parseMouseScrollAction(text) {
  const sgrMouse = text.match(/\u001b\[<(\d+);\d+;\d+[mM]/);
  if (sgrMouse) {
    const button = Number(sgrMouse[1]);
    if (button === 64) {
      return "scroll-up";
    }
    if (button === 65) {
      return "scroll-down";
    }
    return "";
  }

  const legacyMouse = text.match(/\u001b\[M([\s\S])/);
  if (legacyMouse) {
    const button = legacyMouse[1].charCodeAt(0) - 32;
    if (button === 64) {
      return "scroll-up";
    }
    if (button === 65) {
      return "scroll-down";
    }
  }

  return "";
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
    dimRed: "\u001b[2;31m",
    green: "\u001b[32m",
    dimGreen: "\u001b[2;32m",
    yellow: "\u001b[93m",
    blue: "\u001b[34m",
    magenta: "\u001b[95m",
    cyan: "\u001b[96m",
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
    legendKey: "\u001b[1;4;95m",
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
  -v, --version               Show the ffactions version.
  -h, --help                  Show this help.

Arguments:
  [path]                      Project checkout, workflow directory, or workflow file. Default: current directory.
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
  buildInteractiveLegendLines,
  detectRepoSlugFromGit,
  formatCliVersion,
  main,
  parseInteractiveAction,
  parseInteractiveChoice,
  readInteractiveChoice,
  parseArgs,
  parseOwnerFromRemote,
  parseRepoSlugFromRemote,
  resolveCliVersion,
  resolveCliTarget,
  runInteractiveFix,
  wrapInteractiveBufferLine,
};
