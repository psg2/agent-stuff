#!/usr/bin/env bash
# Authenticate with npm via browser-based login.
#
# npm login opens the user's real default browser for OAuth.
# No tokens to copy, no OTP to type — just click approve in the browser.
#
# Status codes (stdout, last line):
#   LOGIN_SUCCESS:<username>  — logged in successfully
#   LOGIN_FAILED              — login failed or was cancelled
#
# Usage: login.sh
set -uo pipefail

OUTPUT=$(npm login 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  USERNAME=$(npm whoami 2>/dev/null || echo "unknown")
  echo "$OUTPUT"
  echo "LOGIN_SUCCESS:$USERNAME"
  exit 0
else
  echo "$OUTPUT"
  echo "LOGIN_FAILED"
  exit 1
fi
