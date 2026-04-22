# Fork Friendly Actions

Evaluate GitHub Actions workflows for CI patterns that break on forks, then
rewrite the fixable ones.

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

## CLI Usage

Run this from a project checkout:

```sh
npx fork-friendly-actions
```

By default, the CLI runs `check`, evaluates `.github/workflows`, and reports
findings without changing files. For fork workflows, it prefers the `upstream`
git remote and falls back to `origin` to determine the upstream repository
scope. That repo slug is the default source of truth for gating and fixes.

To apply fixable changes, run `fix` explicitly:

```sh
npx fork-friendly-actions fix
```

To create one standalone file that can live anywhere on your `PATH`:

```sh
npm run build:standalone
cp dist/ffactions ~/.local/bin/ffactions
```

After that, run it from any project checkout:

```sh
ffactions
```

Preview changes without writing files:

```sh
npx fork-friendly-actions fix --dry-run
```

Only evaluate workflows:

```sh
npx fork-friendly-actions check
```

Pass the full upstream repository explicitly when the checkout has no usable git
remotes or when you want to override detection:

```sh
npx fork-friendly-actions fix --upstream-repo ExampleOrg/example-repo
```

Pass only the owner when no repo slug is available:

```sh
npx fork-friendly-actions fix --upstream-owner ExampleOrg
```

Use a different public fallback runner:

```sh
npx fork-friendly-actions fix --runner-fallback ubuntu-22.04-arm
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

## Action Usage

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
      - uses: actions/checkout@v4
      - uses: wallentx/fork-friendly-actions@v1
```

The action checks by default. To let it rewrite workflow files in the checkout:

```yaml
- uses: wallentx/fork-friendly-actions@v1
  with:
    mode: fix
```

Use `fail-on: warning` when you want every finding to block the PR:

```yaml
- uses: wallentx/fork-friendly-actions@v1
  with:
    fail-on: warning
```

Allow repository-specific runner labels when they are available to forks:

```yaml
- uses: wallentx/fork-friendly-actions@v1
  with:
    allow-runners: larger-ubuntu-4core,public-arm-runner
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

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `workflows` | `.github/workflows` | Directory or workflow file to audit. |
| `mode` | `check` | Use `check` to report findings or `fix` to rewrite files. |
| `fail-on` | dynamic | Minimum severity that fails the action. Defaults to `error` in `check` mode and `none` in `fix` mode. |
| `allow-runners` | empty | Comma-separated runner labels to treat as fork-friendly. |
| `upstream-repo` | detected from `git remote get-url upstream`, then `origin` | Repository slug used for strict fork gating and fix suggestions. |
| `upstream-owner` | derived from `upstream-repo` when possible | Owner name used as a fallback when `upstream-repo` is not set. |
| `runner-fallback` | `ubuntu-latest` | Public runner used when adding fork fallbacks. |

## Outputs

| Output | Description |
| --- | --- |
| `findings-count` | Total number of findings. |
| `error-count` | Number of error findings. |
| `warning-count` | Number of warning findings. |
| `changes-count` | Number of changes applied in `fix` mode. |
| `markdown-summary` | Markdown table of findings. |

## Publishing To GitHub Marketplace

GitHub Marketplace requires this repository to be public, contain a single root
`action.yml` or `action.yaml`, and contain no workflow files. Publish by creating
a release and selecting "Publish this Action to the GitHub Marketplace". See
[Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/how-tos/creating-and-publishing-actions/publishing-actions-in-github-marketplace).

This repository intentionally does not include `.github/workflows` so it remains
eligible for Marketplace listing.

## Maintaining The Public Runner List

`data/public-github-hosted-runners.txt` is generated from GitHub Docs and used
at runtime by the CLI and action wrapper.

The updater script lives at:

- `scripts/update-public-github-hosted-runners.sh`

The ready-to-use GitHub Actions workflow template lives at:

- `contrib/update-public-github-hosted-runners.workflow.yml`

That workflow template is intentionally not active in this repository because
GitHub Marketplace action repositories must not contain workflow files. Run it
from a companion automation repository or another repository that can open pull
requests against this one. Set `TARGET_REPOSITORY` in the workflow template to
the repository you want to update, and provide an `UPDATER_TOKEN` secret that
can push branches and open pull requests there.
