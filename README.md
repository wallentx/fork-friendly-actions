# Fork Friendly Actions

Evaluate GitHub Actions workflows for CI patterns that break on forks, then
rewrite the fixable ones.

Open source contributors should be able to fork a repository, enable Actions on
their fork, and get useful feedback before asking maintainers to run upstream CI.
This action checks workflow files for common blockers:

- private or self-hosted runner labels without a public fallback
- dynamic `runs-on` expressions that do not clearly fall back on forks
- repository or organization secrets used without an owner gate
- publish, release, deployment, or cloud-auth steps used without an owner gate

The CLI is intentionally conservative. It rewrites mechanical cases and leaves
ambiguous workflow logic as manual findings.

## CLI Usage

Run this from a project checkout:

```sh
npx fork-friendly-actions
```

By default, the CLI runs `fix`, evaluates `.github/workflows`, detects the
upstream owner from `remote.origin.url`, and writes changes for fixable issues.

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

Pass the owner explicitly when the checkout has no GitHub `origin` remote:

```sh
npx fork-friendly-actions fix --upstream-owner ExampleOrg
```

Use a different public fallback runner:

```sh
npx fork-friendly-actions fix --runner-fallback ubuntu-22.04-arm
```

## What It Changes

Private scalar runners get a public fork fallback:

```yaml
runs-on: benchmark
```

becomes:

```yaml
runs-on: ${{ github.repository_owner == 'ExampleOrg' && 'benchmark' || 'ubuntu-latest' }}
```

Private runner arrays are preserved for upstream and get an array fallback for
forks:

```yaml
runs-on:
  - self-hosted
  - Linux
  - ARM64
```

becomes:

```yaml
runs-on: ${{ github.repository_owner == 'ExampleOrg' && fromJSON('["self-hosted","Linux","ARM64"]') || fromJSON('["ubuntu-latest"]') }}
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
  if: github.repository_owner == 'ExampleOrg'
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
| `upstream-owner` | current repository owner | Owner name used in guard suggestions. |
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
