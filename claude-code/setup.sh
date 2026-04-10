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
MARKER_START="# claude-code/setup.sh"
MARKER_END="# claude-code/setup.sh:end"

SHELL_BLOCK="$MARKER_START
alias cc-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'
alias cc-personal='CLAUDE_CONFIG_DIR=~/.claude-personal claude'
alias cc-work-yolo='CLAUDE_CONFIG_DIR=~/.claude-work claude --dangerously-skip-permissions'
alias cc-personal-yolo='CLAUDE_CONFIG_DIR=~/.claude-personal claude --dangerously-skip-permissions'
eval \"\$(claude-switch init)\"
$MARKER_END"

if grep -qF "$MARKER_START" "$SHELL_RC" 2>/dev/null; then
  # Remove old block (everything from marker start to marker end, or just the old lines)
  # Use sed to delete from MARKER_START to MARKER_END (or to next blank line if no end marker)
  if grep -qF "$MARKER_END" "$SHELL_RC" 2>/dev/null; then
    sed -i '' "\|$MARKER_START|,\|$MARKER_END|d" "$SHELL_RC"
  else
    # Old format: remove marker line and the lines right after it up to blank line
    sed -i '' "\|$MARKER_START|,/^$/d" "$SHELL_RC"
  fi
  printf "  ${DIM}Removed old shell config from %s${RESET}\n" "$SHELL_RC"
fi

# Append new block
printf '\n%s\n' "$SHELL_BLOCK" >> "$SHELL_RC"
printf "  ${GREEN}✓${RESET} Added to %s:\n" "$SHELL_RC"
printf "       ${BOLD}cc-work${RESET}            — claude with work profile\n"
printf "       ${BOLD}cc-personal${RESET}        — claude with personal profile\n"
printf "       ${BOLD}cc-work-yolo${RESET}       — work + skip permissions\n"
printf "       ${BOLD}cc-personal-yolo${RESET}   — personal + skip permissions\n"
printf "       ${BOLD}claude -a <name>${RESET}   — claude-switch shell integration\n"

# Symlink global skills to profile config dirs
SKILLS_SRC="${HOME}/.claude/skills"
if [[ -d "$SKILLS_SRC" ]]; then
  for profile in work personal; do
    profile_dir="${HOME}/.claude-${profile}"
    mkdir -p "$profile_dir"
    if [[ -L "$profile_dir/skills" ]]; then
      # Already a symlink — update it
      ln -sf "$SKILLS_SRC" "$profile_dir/skills"
    elif [[ ! -e "$profile_dir/skills" ]]; then
      ln -s "$SKILLS_SRC" "$profile_dir/skills"
    else
      printf "  ${YELLOW}!${RESET} %s/skills exists and is not a symlink — skipped\n" "$profile_dir"
      continue
    fi
    printf "  ${GREEN}✓${RESET} Linked skills → ${BOLD}~/.claude-%s/skills${RESET}\n" "$profile"
  done
else
  printf "  ${DIM}No global skills found at %s — skipping symlinks${RESET}\n" "$SKILLS_SRC"
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
