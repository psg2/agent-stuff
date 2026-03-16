#!/usr/bin/env bash
# Release: stage tracked changes + release artifacts, commit, push.
# Does NOT publish — the agent calls publish.sh separately so it can
# orchestrate auth recovery if needed.
#
# Status codes:
#   RELEASE_DONE:<package>:<version>  — committed and pushed
#   NOTHING_TO_COMMIT                 — no staged changes
#   PUSH_FAILED                       — commit succeeded but push failed
#
# Usage: release.sh
set -euo pipefail

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
PKG_NAME=$(grep '"name"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
BRANCH=$(git branch --show-current)

# Stage tracked files + known release artifacts (NOT git add -A to avoid leaking secrets)
git add -u
[ -f CHANGELOG.md ] && git add CHANGELOG.md

STAGED=$(git diff --cached --name-only)
if [ -z "$STAGED" ]; then
  echo "NOTHING_TO_COMMIT"
  exit 0
fi

echo "Staged:"
echo "$STAGED"
git commit -m "Release v$VERSION"

echo "Pushing to $BRANCH..."
if git push origin "$BRANCH"; then
  echo "RELEASE_DONE:$PKG_NAME:$VERSION"
else
  echo "PUSH_FAILED"
  exit 1
fi
