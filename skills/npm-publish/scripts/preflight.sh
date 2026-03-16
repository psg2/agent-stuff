#!/usr/bin/env bash
# Preflight: check version against npm registry, build, output commit log.
#
# For semantic-release packages (version "0.0.0"):
#   - Skips version bumping (CI handles it)
#   - Still builds and shows commit log
#
# For manual-version packages:
#   - Compares local vs registry version
#   - Bumps if local == registry (patch/minor/major)
#   - Resets if version gap detected (abandoned bumps)
#
# Usage: preflight.sh [patch|minor|major]
set -euo pipefail

BUMP_TYPE="${1:-patch}"
PKG_NAME=$(grep '"name"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
LOCAL_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')

# Check npm registry (run in parallel with build)
NPM_TMP=$(mktemp)
npm view "$PKG_NAME" version > "$NPM_TMP" 2>/dev/null &
NPM_PID=$!
bun run build &
BUILD_PID=$!

wait "$NPM_PID" 2>/dev/null && NPM_VERSION=$(cat "$NPM_TMP") || NPM_VERSION="unpublished"
rm -f "$NPM_TMP"
wait "$BUILD_PID" || { echo "BUILD_FAILED"; exit 1; }

echo "Package: $PKG_NAME"
echo "npm version: $NPM_VERSION"
echo "Local version: $LOCAL_VERSION"

# Semantic-release packages keep version at 0.0.0 — don't bump
if [ "$LOCAL_VERSION" = "0.0.0" ]; then
  echo ""
  echo "SEMANTIC_RELEASE_DETECTED"
  echo "Version is 0.0.0 — semantic-release controls versioning via CI."
  echo "Push conventional commits to main and CI will handle the rest."
  echo ""
  echo "=== COMMITS SINCE LAST TAG ==="
  git log --oneline "$(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~10)..HEAD" 2>/dev/null || git log --oneline -10
  echo "=== END COMMITS ==="
  exit 0
fi

# Helper: compute next version from a base
next_version() {
  local BASE="$1" TYPE="$2"
  IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE"
  case "$TYPE" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    *) PATCH=$((PATCH + 1)) ;;
  esac
  echo "$MAJOR.$MINOR.$PATCH"
}

set_version() {
  local OLD="$1" NEW="$2"
  sed "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" package.json > package.json.tmp && mv package.json.tmp package.json
}

if [ "$NPM_VERSION" = "unpublished" ]; then
  echo "First publish. Using local version $LOCAL_VERSION."
elif [ "$LOCAL_VERSION" = "$NPM_VERSION" ]; then
  NEW_VERSION=$(next_version "$NPM_VERSION" "$BUMP_TYPE")
  echo "Bumping: $LOCAL_VERSION → $NEW_VERSION"
  set_version "$LOCAL_VERSION" "$NEW_VERSION"
  LOCAL_VERSION="$NEW_VERSION"
  bun run build
else
  EXPECTED=$(next_version "$NPM_VERSION" "$BUMP_TYPE")
  if [ "$LOCAL_VERSION" = "$EXPECTED" ]; then
    echo "Version $LOCAL_VERSION is next after npm $NPM_VERSION. No bump needed."
  else
    echo "Version gap: npm=$NPM_VERSION, local=$LOCAL_VERSION, expected=$EXPECTED"
    echo "Resetting to $EXPECTED"
    set_version "$LOCAL_VERSION" "$EXPECTED"
    LOCAL_VERSION="$EXPECTED"
    bun run build
  fi
fi

echo ""
echo "=== COMMITS FOR CHANGELOG ==="
git log --oneline "$(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~10)..HEAD" 2>/dev/null || git log --oneline -10
echo "=== END COMMITS ==="

echo ""
echo "PREFLIGHT_READY:$PKG_NAME:$LOCAL_VERSION"
