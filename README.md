# Agent Configs

Portable configurations for AI coding agents. Clone this repo and symlink into the right places to set up any machine quickly.

## Structure

- **`ghostty/`** — Ghostty terminal configuration
- **`pi/`** — Pi agent global config (extensions, settings, interactive setup script)

## Setup

### Pi

Pi's global config lives at `~/.pi/agent/`. The setup script symlinks the tracked files from this repo into that location.

#### Quick setup

```bash
git clone https://github.com/psg2/agent-stuff.git
cd agent-stuff
./pi/setup.sh
```

The setup script shows an interactive picker to select which extensions to install. Use arrow keys to navigate, space to toggle, and enter to confirm.

#### Manual setup

```bash
# Create the global config directory if it doesn't exist
mkdir -p ~/.pi/agent/extensions

# Symlink each extension individually
for ext in pi/extensions/*.ts; do
  ln -sf "$(pwd)/$ext" ~/.pi/agent/extensions/"$(basename "$ext")"
done

# Symlink settings
ln -sf "$(pwd)/pi/settings.json" ~/.pi/agent/settings.json
```

#### What's included

| File | Description |
|------|-------------|
| `pi/settings.json` | Default provider, model, and thinking level |
| `pi/extensions/ask.ts` | Interactive clarifying questions tool for the LLM |
| `pi/extensions/dirty-repo-guard.ts` | Warns before session switch with uncommitted changes |
| `pi/extensions/git-status.ts` | Custom footer with git dirty/clean indicators |
| `pi/extensions/notify.ts` | Terminal bell when agent finishes (triggers Ghostty notification) |

#### What's NOT tracked (machine-specific)

- `~/.pi/agent/auth.json` — API keys and auth tokens
- `~/.pi/agent/sessions/` — Session history
- `~/.pi/agent/bin/` — Platform-specific binaries (e.g., `fd`)
- `~/.pi/agent/skills/` — Installed via `pi` skill manager

#### macOS notification sound

For the `notify.ts` extension to play a sound, enable it in macOS:

**System Settings → Notifications → Ghostty → Play sound for notification → On**

> Note: macOS only plays notification sounds when the terminal is **not** in the foreground.

### Ghostty

Ghostty config lives at `~/Library/Application Support/com.mitchellh.ghostty/config` on macOS.

#### Setup

```bash
ln -sf "$(pwd)/ghostty/config" ~/Library/Application\ Support/com.mitchellh.ghostty/config
```

Then reload with **Cmd+Shift+,** or restart Ghostty.

#### What's configured

| Setting | Value | Description |
|---------|-------|-------------|
| `auto-update-channel` | `tip` | Use latest builds |
| `bell-features` | `system,attention,title` | Play sound + bounce dock icon + 🔔 in title on BEL |
