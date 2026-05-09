#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${SOURCE_BRANCH:?SOURCE_BRANCH is required}"
: "${SOURCE_SHA:?SOURCE_SHA is required}"
: "${DESTINATION_BRANCH:?DESTINATION_BRANCH is required}"

short_sha="${SOURCE_SHA:0:8}"
safe_source_branch="${SOURCE_BRANCH//\//-}"
checkpoint_branch="checkpoint/${safe_source_branch}-${short_sha}"
conflicted="false"
conflict_summary=""

git checkout -B "$checkpoint_branch" "origin/${DESTINATION_BRANCH}"

if ! git merge --no-ff --no-edit "$SOURCE_SHA"; then
  conflicted="true"
  conflict_summary="$(git diff --name-only --diff-filter=U | sed 's/^/- /' || true)"
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    git merge --abort
  fi
  git checkout -B "$checkpoint_branch" "$SOURCE_SHA"
fi

if git diff --quiet "origin/${DESTINATION_BRANCH}" HEAD; then
  echo "No checkpoint changes to propose."
  exit 0
fi

git push origin "HEAD:refs/heads/${checkpoint_branch}" --force

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

{
  echo "Checkpoint release branch \`${SOURCE_BRANCH}\` back to \`${DESTINATION_BRANCH}\`."
  echo
  echo "- Source branch: \`${SOURCE_BRANCH}\`"
  echo "- Source commit: \`${SOURCE_SHA}\`"
  echo "- Destination branch: \`${DESTINATION_BRANCH}\`"
  echo
  if [ "$conflicted" = "true" ]; then
    echo "## Merge conflicts"
    echo
    echo "Automatic checkpoint merge conflicted, so this PR was created from the release commit directly."
    echo "GitHub will show the remaining conflicts against \`${DESTINATION_BRANCH}\`."
    echo
    if [ -n "$conflict_summary" ]; then
      echo "$conflict_summary"
      echo
    fi
  fi
  echo "Created by the release checkpoint workflow."
} > "$body_file"

existing_pr="$(
  gh pr list \
    --repo "$GH_REPO" \
    --head "$checkpoint_branch" \
    --base "$DESTINATION_BRANCH" \
    --state open \
    --json number \
    --jq '.[0].number // empty'
)"

title="Checkpoint ${SOURCE_BRANCH} into ${DESTINATION_BRANCH}"
if [ -n "$existing_pr" ]; then
  gh pr edit "$existing_pr" --repo "$GH_REPO" --title "$title" --body-file "$body_file"
else
  gh pr create \
    --repo "$GH_REPO" \
    --base "$DESTINATION_BRANCH" \
    --head "$checkpoint_branch" \
    --title "$title" \
    --body-file "$body_file"
fi
