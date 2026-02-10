#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$(uname)" in
  Darwin) GHOSTTY_DIR="$HOME/Library/Application Support/com.mitchellh.ghostty" ;;
  *)      GHOSTTY_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ghostty" ;;
esac

mkdir -p "$GHOSTTY_DIR"

ln -sf "$SCRIPT_DIR/config" "$GHOSTTY_DIR/config"
echo "✓ Linked config → $GHOSTTY_DIR/config"
echo ""
echo "Reload Ghostty with Cmd+Shift+, or restart it."
