#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT_PATH="$REPO_ROOT/data/public-github-hosted-runners.txt"
TMP_PATH=$(mktemp)

cleanup() {
  rm -f "$TMP_PATH"
}

trap cleanup EXIT INT TERM

curl -fsSL 'https://docs.github.com/en/enterprise-cloud@latest/actions/reference/runners/github-hosted-runners.md' \
| awk '/^### Standard GitHub-hosted runners for public repositories$/,/^### Standard GitHub-hosted runners for internal and private repositories$/' \
| grep -oE '<a[^>]*>[^<]+' \
| sed 's/<a[^>]*>//' \
| tr ',' '\n' \
| sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
| sed '/^$/d' \
| LC_ALL=C sort -u > "$TMP_PATH"

mv "$TMP_PATH" "$OUTPUT_PATH"

printf 'Updated %s with %s public GitHub-hosted runner labels.\n' \
  "$(basename "$OUTPUT_PATH")" \
  "$(wc -l < "$OUTPUT_PATH" | tr -d ' ')"
