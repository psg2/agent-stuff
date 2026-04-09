# claude-code

Extensions and tools for Claude Code.

## Setup

```bash
./setup.sh
```

This builds all tools and symlinks them to `~/.local/bin/`.

## Tools

### claude-switch

Switch between multiple Claude Code subscriptions (e.g. personal vs work accounts).

Credentials are stored securely in the platform credential store:
- **macOS**: each profile gets its own Keychain entry (`Claude Code-credentials.<name>`)
- **Linux/Windows**: per-profile files under `~/.config/claude-switch/credentials/` with `0600` permissions

Profile metadata (name, email, org - no secrets) is saved to `~/.config/claude-switch/profiles/`.

**Usage:**

```bash
# Save your current session as a named profile
claude-switch save personal

# Log into another account, then save it too
claude /login
claude-switch save work

# List all profiles (arrow marks the active one)
claude-switch list

# Switch to a different profile
claude-switch use work

# Show which profile is currently active
claude-switch current

# Remove a profile
claude-switch remove old-account
```

After switching, restart Claude Code for changes to take effect.

## Shell Aliases

Setup also adds these aliases to `~/.zshrc`:

- `cc` — runs `claude --dangerously-skip-permissions`
