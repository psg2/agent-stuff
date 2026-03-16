#!/usr/bin/env bash
# Verify npm publish propagation with exponential backoff.
#
# Status codes:
#   VERIFIED:<package>@<version>  — confirmed on registry
#   VERIFY_TIMEOUT                — not confirmed after all attempts (may still propagate)
#
# Usage: verify.sh <package-name> <expected-version> [max-attempts]
set -euo pipefail

PKG="${1:?Usage: verify.sh <package-name> <expected-version> [max-attempts]}"
EXPECTED="${2:?Usage: verify.sh <package-name> <expected-version> [max-attempts]}"
MAX_ATTEMPTS="${3:-5}"

# Backoff: 5s, 10s, 20s, 40s, 60s (~2.25 min total)
DELAYS=(5 10 20 40 60)

for i in $(seq 0 $((MAX_ATTEMPTS - 1))); do
  DELAY=${DELAYS[$i]:-60}
  sleep "$DELAY"

  PUBLISHED=$(npm view "$PKG" version 2>/dev/null || echo "unknown")
  if [ "$PUBLISHED" = "$EXPECTED" ]; then
    echo "VERIFIED:$PKG@$EXPECTED"
    echo "Confirmed after $((i + 1)) attempt(s)."
    exit 0
  fi
  echo "Attempt $((i + 1))/$MAX_ATTEMPTS: registry=$PUBLISHED, expected=$EXPECTED"
done

echo "VERIFY_TIMEOUT"
echo "Registry shows $(npm view "$PKG" version 2>/dev/null || echo 'unknown') after $MAX_ATTEMPTS attempts."
echo "Propagation can take up to 5 minutes."
exit 1
