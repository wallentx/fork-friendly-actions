#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { auditWorkflows, fixWorkflows, shouldFail, DEFAULT_WORKFLOWS_DIR } = require("./index.js");

function getInput(name, defaultValue = "") {
  const envName = `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`;
  const value = process.env[envName];
  return value == null || value === "" ? defaultValue : value;
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, `${name}<<__fork_friendly_actions__${os.EOL}${value}${os.EOL}__fork_friendly_actions__${os.EOL}`);
    return;
  }
  console.log(`::set-output name=${name}::${escapeCommandValue(String(value))}`);
}

function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${markdown}${os.EOL}`);
  }
}

function annotate(finding) {
  const properties = [
    `file=${escapeProperty(finding.file)}`,
    `line=${finding.line}`,
    `title=${escapeProperty(finding.title)}`,
  ].join(",");

  console.log(`::${finding.severity} ${properties}::${escapeCommandValue(finding.message)}`);
}

function escapeProperty(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function escapeCommandValue(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function main() {
  const workflows = getInput("workflows", DEFAULT_WORKFLOWS_DIR);
  const upstreamRepo = getInput("upstream-repo", process.env.GITHUB_REPOSITORY || "");
  const upstreamOwner = getInput("upstream-owner", process.env.GITHUB_REPOSITORY_OWNER || "");
  const mode = getInput("mode", "check").toLowerCase();
  const failOn = getInput("fail-on", mode === "fix" ? "none" : "error").toLowerCase();
  const allowRunners = getInput("allow-runners", "");
  const runnerFallback = getInput("runner-fallback", "ubuntu-latest");

  if (!["error", "warning", "none"].includes(failOn)) {
    console.log("::error title=Invalid input::fail-on must be one of error, warning, or none.");
    process.exitCode = 1;
    return;
  }

  if (!["check", "fix"].includes(mode)) {
    console.log("::error title=Invalid input::mode must be check or fix.");
    process.exitCode = 1;
    return;
  }

  const result =
    mode === "fix"
      ? fixWorkflows({ workflows, upstreamRepo, upstreamOwner, allowRunners, runnerFallback })
      : auditWorkflows({ workflows, upstreamRepo, upstreamOwner, allowRunners });

  for (const finding of result.findings) {
    annotate(finding);
  }

  const errorCount = result.findings.filter((finding) => finding.severity === "error").length;
  const warningCount = result.findings.filter((finding) => finding.severity === "warning").length;

  setOutput("findings-count", String(result.findings.length));
  setOutput("error-count", String(errorCount));
  setOutput("warning-count", String(warningCount));
  setOutput("changes-count", String(result.changes.length));
  setOutput("markdown-summary", result.summary);
  writeSummary(result.summary);

  if (result.files.length === 0) {
    console.log(`No workflow files found under ${workflows}.`);
    return;
  }

  console.log(`${mode === "fix" ? "Evaluated and updated" : "Audited"} ${result.files.length} workflow file${result.files.length === 1 ? "" : "s"}.`);
  if (mode === "fix" && result.changes.length > 0) {
    console.log(`Applied ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} across ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}.`);
  }

  if (shouldFail(result.findings, failOn)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
