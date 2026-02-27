#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="$HOME/.pi/agent"

# Colors
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

# Gather available extensions
extensions=()
descriptions=()
for ext in "$SCRIPT_DIR"/extensions/*.ts; do
  [ -f "$ext" ] || continue
  name="$(basename "$ext" .ts)"
  extensions+=("$name")
  # Extract first line of JSDoc description (second line of file, after "/**")
  desc=$(sed -n '2s/^ *\* *//p' "$ext" 2>/dev/null || echo "")
  descriptions+=("$desc")
done

if [ ${#extensions[@]} -eq 0 ]; then
  echo "No extensions found in $SCRIPT_DIR/extensions/"
  exit 1
fi

# All selected by default
selected=()
for _ in "${extensions[@]}"; do
  selected+=(1)
done

# Interactive selection
cursor=0
total=${#extensions[@]}

# Save terminal state and hide cursor
tput smcup 2>/dev/null || true
tput civis 2>/dev/null || true
stty -echo -icanon min 1 time 0 2>/dev/null || true

cleanup() {
  tput cnorm 2>/dev/null || true
  tput rmcup 2>/dev/null || true
  stty echo icanon 2>/dev/null || true
}
trap cleanup EXIT

draw() {
  tput clear 2>/dev/null || printf '\033[2J\033[H'
  echo ""
  printf "  ${BOLD}Pi Agent Setup${RESET}\n"
  printf "  ${DIM}Select extensions to install${RESET}\n"
  echo ""

  for i in "${!extensions[@]}"; do
    local name="${extensions[$i]}"
    local desc="${descriptions[$i]}"

    if [ "$i" -eq "$cursor" ]; then
      pointer="${CYAN}❯${RESET}"
    else
      pointer=" "
    fi

    if [ "${selected[$i]}" -eq 1 ]; then
      check="${GREEN}◼${RESET}"
    else
      check="${DIM}◻${RESET}"
    fi

    if [ "$i" -eq "$cursor" ]; then
      printf "  %b %b ${BOLD}%s${RESET}\n" "$pointer" "$check" "$name"
    else
      printf "  %b %b %s\n" "$pointer" "$check" "$name"
    fi

    if [ -n "$desc" ]; then
      printf "      ${DIM}%s${RESET}\n" "$desc"
    fi
  done

  echo ""
  printf "  ${DIM}↑/↓ navigate • space toggle • a all • n none • enter confirm • q quit${RESET}\n"

  # Show count
  local count=0
  for s in "${selected[@]}"; do
    [ "$s" -eq 1 ] && ((count++)) || true
  done
  printf "  ${DIM}%d of %d selected${RESET}\n" "$count" "$total"
}

draw

while true; do
  # Read a single byte
  char=$(dd bs=1 count=1 2>/dev/null)

  # Handle escape sequences (arrow keys)
  if [ "$char" = $'\033' ]; then
    char2=$(dd bs=1 count=1 2>/dev/null)
    if [ "$char2" = "[" ]; then
      char3=$(dd bs=1 count=1 2>/dev/null)
      case "$char3" in
        A) # Up
          cursor=$(( (cursor - 1 + total) % total ))
          draw
          ;;
        B) # Down
          cursor=$(( (cursor + 1) % total ))
          draw
          ;;
      esac
    fi
    continue
  fi

  case "$char" in
    " ") # Space: toggle
      if [ "${selected[$cursor]}" -eq 1 ]; then
        selected[$cursor]=0
      else
        selected[$cursor]=1
      fi
      draw
      ;;
    "a") # Select all
      for i in "${!selected[@]}"; do selected[$i]=1; done
      draw
      ;;
    "n") # Select none
      for i in "${!selected[@]}"; do selected[$i]=0; done
      draw
      ;;
    "j") # Vim down
      cursor=$(( (cursor + 1) % total ))
      draw
      ;;
    "k") # Vim up
      cursor=$(( (cursor - 1 + total) % total ))
      draw
      ;;
    "q") # Quit
      echo ""
      echo "  Cancelled."
      exit 0
      ;;
    "") # Enter: confirm
      break
      ;;
  esac
done

# Restore terminal before output
cleanup
trap - EXIT

echo ""
echo "Setting up Pi agent config..."
echo ""

mkdir -p "$PI_DIR/extensions"

linked=0
for i in "${!extensions[@]}"; do
  name="${extensions[$i]}"
  if [ "${selected[$i]}" -eq 1 ]; then
    ln -sf "$SCRIPT_DIR/extensions/$name.ts" "$PI_DIR/extensions/$name.ts"
    printf "  ${GREEN}✓${RESET} Linked ${BOLD}%s${RESET}\n" "$name"
    ((linked++)) || true
  fi
done

# Copy settings (not a symlink — pi writes to this file at runtime, symlinks break locking)
cp "$SCRIPT_DIR/settings.json" "$PI_DIR/settings.json"
printf "  ${GREEN}✓${RESET} Copied ${BOLD}settings.json${RESET}\n"

echo ""
if [ "$linked" -eq 0 ]; then
  printf "  ${YELLOW}No extensions selected.${RESET} Only settings.json was linked.\n"
else
  printf "  ${GREEN}Done!${RESET} $linked extension(s) linked. Restart pi or run /reload.\n"
fi
echo ""
