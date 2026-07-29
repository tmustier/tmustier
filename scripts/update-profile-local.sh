#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

git fetch origin
if ! git rebase origin/main; then
  echo "Rebase failed; resolve conflicts and retry." >&2
  exit 1
fi

node .github/scripts/update-token-usage.js
node .github/scripts/update-gh-activity.js

if git diff --quiet; then
  exit 0
fi

git add README.md

last_message=$(git log -1 --pretty=%s)
if [ "$last_message" = "Update GH activity" ]; then
  git commit --amend --no-edit
else
  git commit -m "Update GH activity"
fi

if ! git pull --rebase; then
  echo "Rebase failed after commit; resolve conflicts and retry." >&2
  exit 1
fi

git push --force-with-lease
