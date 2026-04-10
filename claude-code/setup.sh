#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

# Colors
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

echo ""
printf "  ${BOLD}Claude Code Setup${RESET}\n"
printf "  ${DIM}Installing tools${RESET}\n"
echo ""

# Check Go
if ! command -v go &>/dev/null; then
  printf "  ${RED}✗${RESET} Go is not installed. Install with: brew install go\n"
  exit 1
fi

# Build claude-switch
printf "  ${DIM}Building claude-switch...${RESET}\n"
(cd "$SCRIPT_DIR/claude-switch" && go build -o claude-switch .)
printf "  ${GREEN}✓${RESET} Built ${BOLD}claude-switch${RESET}\n"

# Install to PATH
mkdir -p "$BIN_DIR"
ln -sf "$SCRIPT_DIR/claude-switch/claude-switch" "$BIN_DIR/claude-switch"
printf "  ${GREEN}✓${RESET} Linked to ${BOLD}%s/claude-switch${RESET}\n" "$BIN_DIR"

# Install shell config
SHELL_RC="${HOME}/.zshrc"
ALIAS_MARKER="# claude-code/setup.sh"

if grep -qF "$ALIAS_MARKER" "$SHELL_RC" 2>/dev/null; then
  printf "  ${DIM}Shell config already in %s${RESET}\n" "$SHELL_RC"
else
  cat >> "$SHELL_RC" <<'SHELL'

# claude-code/setup.sh
alias cc="claude --dangerously-skip-permissions"
alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'
alias claude-personal='CLAUDE_CONFIG_DIR=~/.claude-personal claude'
eval "$(claude-switch init)"
SHELL
  printf "  ${GREEN}✓${RESET} Added to %s:\n" "$SHELL_RC"
  printf "       ${BOLD}cc${RESET}               — claude --dangerously-skip-permissions\n"
  printf "       ${BOLD}claude-work${RESET}      — claude with work profile\n"
  printf "       ${BOLD}claude-personal${RESET}  — claude with personal profile\n"
  printf "       ${BOLD}claude -a <name>${RESET} — claude-switch shell integration\n"
fi

echo ""

# Check PATH
if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
  printf "  ${YELLOW}Warning:${RESET} %s is not in your PATH.\n" "$BIN_DIR"
  printf "  Add this to your shell profile (~/.zshrc):\n"
  echo ""
  printf "    export PATH=\"\${HOME}/.local/bin:\${PATH}\"\n"
  echo ""
fi

printf "  ${GREEN}Done!${RESET} Run ${BOLD}claude-switch --help${RESET} to get started.\n"
echo ""
