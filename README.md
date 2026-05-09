# Fork Friendly Actions

[![CI](https://github.com/wallentx/fork-friendly-actions/actions/workflows/ci.yml/badge.svg)](https://github.com/wallentx/fork-friendly-actions/actions/workflows/ci.yml)
[![Fork Friendly Audit](https://github.com/wallentx/fork-friendly-actions/actions/workflows/fork-friendly-audit.yml/badge.svg)](https://github.com/wallentx/fork-friendly-actions/actions/workflows/fork-friendly-audit.yml)
[![GitHub release](https://img.shields.io/github/v/release/wallentx/fork-friendly-actions?display_name=tag&sort=semver)](https://github.com/wallentx/fork-friendly-actions/releases)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Fork%20Friendly%20Actions-blue?logo=github)](https://github.com/marketplace/actions/fork-friendly-actions)

Evaluate GitHub Actions workflows for CI patterns that break on forks, then
rewrite the fixable ones.

## About

Open source contributors should be able to fork a repository, enable Actions on
their fork, and get useful feedback before asking maintainers to run upstream CI.
This action checks workflow files for common blockers:

- private or self-hosted runner labels without a public fallback
- runner groups that require private runner access
- dynamic `runs-on` expressions that do not clearly fall back on forks
- repository or organization secrets used without an owner gate
- publish, release, deployment, or cloud-auth steps used without an owner gate

The CLI is intentionally conservative. It rewrites mechanical cases and leaves
ambiguous workflow logic as manual findings.

The set of public GitHub-hosted runner labels is committed in
`data/public-github-hosted-runners.txt`. Runtime checks use that file instead of
regex heuristics so the behavior is deterministic and reviewable.

---

- [Usage](#usage)
- [CLI Usage](#cli-usage)
- [What It Changes](#what-it-changes)
- [Fix Patterns](#fix-patterns)
- [Customizing](#customizing)
- [Publishing To GitHub Marketplace](#publishing-to-github-marketplace)
- [Maintaining The Public Runner List](#maintaining-the-public-runner-list)

## Usage

Add this action to a workflow that runs when workflow files change:

```yaml
name: Fork friendly workflow audit

on:
  pull_request:
    paths:
      - ".github/workflows/**"
  push:
    branches:
      - main
    paths:
      - ".github/workflows/**"

jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: wallentx/fork-friendly-actions@v1
```

The action checks by default. Use `fail-on: warning` when you want every finding
to block the PR:

```yaml
- uses: wallentx/fork-friendly-actions@v1
  with:
    fail-on: warning
```

To let the action rewrite workflow files in the checkout:

```yaml
- uses: wallentx/fork-friendly-actions@v1
  with:
    mode: fix
```

Allow repository-specific runner labels when they are available to forks:

```yaml
- uses: wallentx/fork-friendly-actions@v1
  with:
    allow-runners: larger-ubuntu-4core,public-arm-runner
```

## CLI Usage

Build the standalone executable from this repo:

```sh
npm i
npm run build
mkdir -p ~/.local/bin
ln -sf "$(pwd)/dist/ffactions" ~/.local/bin/ffactions
```

After that, run `ffactions` from any project checkout. By default, it evaluates
`.github/workflows` and reports findings without changing files. For fork
workflows, it prefers the `upstream` git remote and falls back to `origin` to
determine the upstream repository scope. That repo slug is the default source
of truth for gating and fixes.

Check workflows:

```sh
ffactions
```

Apply fixable changes:

```sh
ffactions --fix
```

Preview changes without writing files:

```sh
ffactions --fix --dry-run
```

Review each proposed fix interactively and accept or skip it with `y`/`n`:

```sh
ffactions --interactive
```

Pass the full upstream repository explicitly when the checkout has no usable git
remotes or when you want to override detection:

```sh
ffactions --fix --upstream-repo ExampleOrg/example-repo
```

Pass only the owner when no repo slug is available:

```sh
ffactions --fix --upstream-owner ExampleOrg
```

Use a different public fallback runner:

```sh
ffactions --fix --runner-fallback ubuntu-22.04-arm
```

Run against a specific directory (defaults to current directory):

```sh
ffactions path/to/project
```

Refresh the committed public-runner list from GitHub Docs:

```sh
npm run update:public-runners
```

## What It Changes

Private scalar runners get a public fork fallback:

```yaml
runs-on: benchmark
```

becomes:

```yaml
runs-on: ${{ github.repository == 'ExampleOrg/example-repo' && 'benchmark' || 'ubuntu-latest' }}
```

Self-hosted runner arrays are treated as upstream-only and get a job guard
instead of a fork fallback:

```yaml
runs-on:
  - self-hosted
  - Linux
  - ARM64
```

becomes:

```yaml
if: github.repository == 'ExampleOrg/example-repo'
runs-on:
  - self-hosted
  - Linux
  - ARM64
```

Runner groups are treated as upstream-only and get a job guard instead of a
fork fallback:

```yaml
runs-on:
  group: ubuntu-runners
  labels: ubuntu-24.04-16core
```

becomes:

```yaml
if: github.repository == 'ExampleOrg/example-repo'
runs-on:
  group: ubuntu-runners
  labels: ubuntu-24.04-16core
```

Publish, deploy, cloud-auth, release, and secret-backed steps get a step-level
owner guard:

```yaml
- run: twine upload dist/*
  env:
    TWINE_PASSWORD: ${{ secrets.PYPI_TOKEN }}
```

becomes:

```yaml
- run: twine upload dist/*
  if: github.repository == 'ExampleOrg/example-repo'
  env:
    TWINE_PASSWORD: ${{ secrets.PYPI_TOKEN }}
```

## Fix Patterns

Use a public fallback for private runners:

```yaml
runs-on: ${{ github.repository_owner == 'ExampleOrg' && 'benchmark' || 'ubuntu-latest' }}
```

Skip upstream-only jobs on forks:

```yaml
jobs:
  publish:
    if: github.repository_owner == 'ExampleOrg'
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
```

Avoid requiring repository or organization secrets from fork pull requests:

```yaml
steps:
  - name: Publish package
    if: github.repository_owner == 'ExampleOrg'
    run: twine upload dist/*
    env:
      TWINE_PASSWORD: ${{ secrets.PYPI_TOKEN }}
```

## Customizing

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `workflows` | `.github/workflows` | Directory or workflow file to audit. |
| `mode` | `check` | Use `check` to report findings or `fix` to rewrite files. |
| `fail-on` | dynamic | Minimum severity that fails the action. Defaults to `error` in `check` mode and `none` in `fix` mode. |
| `allow-runners` | empty | Comma-separated runner labels to treat as fork-friendly. |
| `upstream-repo` | detected from `git remote get-url upstream`, then `origin` | Repository slug used for strict fork gating and fix suggestions. |
| `upstream-owner` | derived from `upstream-repo` when possible | Owner name used as a fallback when `upstream-repo` is not set. |
| `runner-fallback` | `ubuntu-latest` | Public runner used when adding fork fallbacks. |

### Outputs

| Output | Description |
| --- | --- |
| `findings-count` | Total number of findings. |
| `error-count` | Number of error findings. |
| `warning-count` | Number of warning findings. |
| `changes-count` | Number of changes applied in `fix` mode. |
| `markdown-summary` | Markdown table of findings. |

## Publishing To GitHub Marketplace

Publish by creating a release and selecting "Publish this Action to the GitHub
Marketplace". The repository must be public, and the Marketplace listing is
driven by the root `action.yml` metadata file. See
[Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).

The action runtime is the committed bundle at `dist/action/index.js`. Rebuild it
with `npm run build` before cutting a release so consumers can run
`wallentx/fork-friendly-actions@v1` without installing dependencies.

This repository uses its own `.github/workflows` for CI, fork-friendliness
checks, dependency updates, release candidates, full releases, and release
checkpoint PRs.

## Maintaining The Public Runner List

`data/public-github-hosted-runners.txt` is generated from GitHub Docs and used
at runtime by the CLI and action wrapper.

The updater script lives at:

- `scripts/update-public-github-hosted-runners.sh`

The ready-to-use GitHub Actions workflow template lives at:

- `contrib/update-public-github-hosted-runners.workflow.yml`

Copy that template into `.github/workflows/` when you want scheduled runner-list
refresh PRs. Set `TARGET_REPOSITORY` in the workflow template to the repository
you want to update, and provide an `UPDATER_TOKEN` secret that can push branches
and open pull requests there.
