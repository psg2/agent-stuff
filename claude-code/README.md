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

#### Getting started

```bash
# 1. Save your current session as a named profile
claude-switch save personal

# 2. Log into another account, then save it
claude /login
claude-switch save work

# 3. Launch claude with any profile
claude-switch run work
claude-switch run personal
```

#### Shell integration (recommended)

Add to `~/.zshrc` or `~/.bashrc`:

```bash
eval "$(claude-switch init)"
```

Then launch claude with any profile using `-a`:

```bash
claude -a work                # work profile
claude -a personal            # personal profile in another terminal
claude -a work -p 'fix bug'  # pass flags through
claude                        # normal launch (no profile override)
```

#### Direct launch

Without shell integration, use `run` directly:

```bash
claude-switch run work
claude-switch run work -- -p 'summarize this repo'
claude-switch run work -- --dangerously-skip-permissions
```

#### Classic switch (single-session)

The `use` command swaps the default credentials (Keychain on macOS, credentials
file on Linux). Only one profile can be active at a time.

```bash
claude-switch use work      # requires restarting claude
```

#### Managing profiles

```bash
claude-switch list            # show all profiles
claude-switch current         # show the active profile
claude-switch remove old-acct # delete a profile
```

#### Manual token provisioning

The `run` and `env` commands try to extract OAuth tokens from stored credentials
automatically. If auto-extraction doesn't work, set a token manually:

```bash
claude-switch use work                     # switch to the account
claude setup-token                         # generate a long-lived token
claude-switch token work <paste-token>     # save it
claude-switch run work                     # now it works
```

#### How it works

The `run` command (and shell integration) launches `claude` with these environment
variables set on the child process — no eval, no shell pollution:

| Variable | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Access token — takes precedence over Keychain |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | Refresh token — auto-refreshes, longer-lived |
| `CLAUDE_CODE_OAUTH_SCOPES` | Required scopes when using refresh token |
| `CLAUDE_CONFIG_DIR` | Per-profile config dir (`~/.claude-profiles/<name>`) for session isolation |

## Shell Aliases

Setup also adds these aliases to `~/.zshrc`:

- `cc` — runs `claude --dangerously-skip-permissions`
