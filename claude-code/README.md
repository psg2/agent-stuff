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

#### Save & switch (classic)

```bash
# Save your current session as a named profile
claude-switch save personal

# Log into another account, then save it too
claude /login
claude-switch save work

# List all profiles (arrow marks the active one)
claude-switch list

# Switch to a different profile (exclusive — requires restart)
claude-switch use work

# Show which profile is currently active
claude-switch current

# Remove a profile
claude-switch remove old-account
```

#### Concurrent sessions with env vars

The `env` command prints shell `export` statements that set OAuth environment
variables (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, etc.)
and `CLAUDE_CONFIG_DIR`. This lets you run **multiple Claude sessions
simultaneously**, each using a different profile — no Keychain conflicts.

```bash
# Terminal 1 — work profile
eval $(claude-switch env work)
claude

# Terminal 2 — personal profile
eval $(claude-switch env personal)
claude
```

**Shell aliases** make this even easier:

```bash
alias claude-work='eval $(claude-switch env work) && claude'
alias claude-personal='eval $(claude-switch env personal) && claude'
```

The `env` command tries to extract tokens automatically from stored credentials.
If auto-extraction doesn't find tokens (field names vary by Claude Code version),
set one manually:

```bash
# 1. Switch to the account you want to provision
claude-switch use work

# 2. Generate a long-lived token
claude setup-token

# 3. Save the token for env usage
claude-switch token work <paste-token>

# 4. Now env works for this profile
eval $(claude-switch env work)
```

#### Environment variables set by `env`

| Variable | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Access token — takes precedence over Keychain |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | Refresh token — auto-refreshes, longer-lived |
| `CLAUDE_CODE_OAUTH_SCOPES` | Required scopes when using refresh token |
| `CLAUDE_CONFIG_DIR` | Per-profile config dir (`~/.claude-profiles/<name>`) for session isolation |

## Shell Aliases

Setup also adds these aliases to `~/.zshrc`:

- `cc` — runs `claude --dangerously-skip-permissions`
