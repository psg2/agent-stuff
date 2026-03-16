#!/usr/bin/env bash
# Publish to npm via bun publish.
#
# bun publish uses --auth-type=web by default — it opens the user's real
# browser for OTP verification. After one browser auth, npm grants a
# ~5-minute window where subsequent publishes skip auth entirely.
#
# Status codes (stdout, last line):
#   PUBLISH_SUCCESS  — published successfully
#   AUTH_FAILED      — no valid token / not logged in
#   PUBLISH_ERROR    — other error (output included)
#
# Usage: publish.sh [--access public] [--dry-run]
set -uo pipefail

EXTRA_FLAGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --access) EXTRA_FLAGS="$EXTRA_FLAGS --access $2"; shift 2 ;;
    --dry-run) EXTRA_FLAGS="$EXTRA_FLAGS --dry-run"; shift ;;
    *) shift ;;
  esac
done

OUTPUT=$(echo "" | bun publish $EXTRA_FLAGS 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "$OUTPUT"
  echo "PUBLISH_SUCCESS"
  exit 0
fi

if echo "$OUTPUT" | grep -qi "404\|401\|403\|unauthorized\|ENEEDAUTH\|authentication"; then
  echo "AUTH_FAILED"
  exit 1
else
  echo "$OUTPUT"
  echo "PUBLISH_ERROR"
  exit 1
fi
