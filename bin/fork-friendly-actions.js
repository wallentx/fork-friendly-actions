#!/usr/bin/env node

"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");
const {
  DEFAULT_RUNNER_FALLBACK,
  DEFAULT_WORKFLOWS_DIR,
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
  const command = parsed.command || "fix";
  const upstreamOwner = parsed.upstreamOwner || detectOwnerFromGit(cwd);

  if (!["check", "fix"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  if (command === "fix" && !upstreamOwner) {
    throw new Error("Could not detect the upstream owner from git remote origin. Pass --upstream-owner <owner>.");
  }

  const options = {
    cwd,
    workflows: parsed.workflows || DEFAULT_WORKFLOWS_DIR,
    upstreamOwner,
    allowRunners: parsed.allowRunners || "",
    runnerFallback: parsed.runnerFallback || DEFAULT_RUNNER_FALLBACK,
  };

  const result =
    command === "fix"
      ? fixWorkflows({ ...options, dryRun: parsed.dryRun })
      : auditWorkflows(options);

  printResult(result, { command, dryRun: parsed.dryRun });

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

function detectOwnerFromGit(cwd) {
  try {
    const remote = childProcess.execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseOwnerFromRemote(remote);
  } catch {
    return "";
  }
}

function parseOwnerFromRemote(remote) {
  const sshMatch = remote.match(/^[^@]+@[^:]+:([^/]+)\/[^/]+?(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  const urlMatch = remote.match(/github\.com[/:]([^/]+)\/[^/]+?(?:\.git)?$/);
  if (urlMatch) {
    return urlMatch[1];
  }

  return "";
}

function printResult(result, { command, dryRun }) {
  if (result.files.length === 0) {
    console.log("No workflow files found.");
    return;
  }

  console.log(`Evaluated ${result.files.length} workflow file${result.files.length === 1 ? "" : "s"}.`);

  if (result.findings.length === 0) {
    console.log("No fork-hostile workflow patterns were found.");
    return;
  }

  for (const finding of result.findings) {
    const status = finding.fixable ? "fixable" : "manual";
    console.log(`${finding.severity.toUpperCase()} ${finding.file}:${finding.line} ${finding.title} (${status})`);
    console.log(`  ${finding.message}`);
  }

  if (command === "fix") {
    const verb = dryRun ? "Would apply" : "Applied";
    console.log(`${verb} ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} across ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}.`);
  }
}

function printHelp() {
  console.log(`fork-friendly-actions

Evaluate GitHub Actions workflows and make them friendlier to forked PRs.

Usage:
  fork-friendly-actions [fix] [options]
  fork-friendly-actions check [options]

Commands:
  fix      Evaluate workflows and rewrite fixable fork-hostile patterns. Default.
  check    Evaluate workflows without changing files.

Options:
  --fix                       Run fix mode. Same as the fix command.
  --check                     Run check mode. Same as the check command.
  --workflows <path>          Workflow file or directory. Default: ${DEFAULT_WORKFLOWS_DIR}
  --upstream-owner <owner>    Owner allowed to use private runners, secrets, and publish steps.
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
  main,
  parseArgs,
  parseOwnerFromRemote,
};
