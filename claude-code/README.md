# claude-code

Extensions and tools for Claude Code.

## Setup

```bash
./setup.sh
```

This builds all tools and symlinks them to `~/.local/bin/`.

## Tools

### claude-switch

Manage multiple Claude Code profiles (e.g. personal vs work accounts).

Each profile gets its own `CLAUDE_CONFIG_DIR` (`~/.claude-<name>`).
Claude Code automatically creates a distinct Keychain entry per config dir,
so profiles are fully isolated — no credential conflicts, concurrent sessions
just work.

#### Getting started

```bash
# 1. Save your current session as a profile
claude-switch save personal

# 2. Log in as personal in the profile's own config dir
claude-switch run personal
# inside claude: /login (first time only)

# 3. Log into another account normally, then repeat
claude /login
claude-switch save work
claude-switch run work
# inside claude: /login (first time only)
```

#### Shell integration (recommended)

Add to `~/.zshrc` or `~/.bashrc`:

```bash
eval "$(claude-switch init)"
```

Then use the `-a` flag:

```bash
claude -a work                # terminal 1
claude -a personal            # terminal 2 (concurrent)
claude -a work -p 'fix bug'  # pass flags through
claude                        # normal launch (default config)
```

#### Direct launch

Without shell integration, use `run`:

```bash
claude-switch run work
claude-switch run work -- -p 'summarize this repo'
claude-switch run work -- --dangerously-skip-permissions
```

#### Managing profiles

```bash
claude-switch list            # show all profiles with account info
claude-switch current         # show the active profile
claude-switch remove old-acct # delete a profile
```

#### How it works

`run` (and the `claude -a` shell integration) just sets one environment variable
on the child process:

```
CLAUDE_CONFIG_DIR=~/.claude-<name>
```

Claude Code reads settings, credentials, session history, and plugins from this
path, and on macOS uses a distinct Keychain entry keyed to the config dir path.
No OAuth token extraction, no credential swapping, no shell env pollution.

#### Skills with multiple profiles

Project-level skills (`npx skills add <skill>`) install to `.claude/skills/`
in the project directory — shared across all profiles automatically.

Global skills (`npx skills add -g <skill>`) install to `~/.claude/skills/`
(the default config dir). To share them across profiles, symlink:

```bash
ln -s ~/.claude/skills ~/.claude-work/skills
ln -s ~/.claude/skills ~/.claude-personal/skills
```

#### Legacy: swap default credentials

The `use` command swaps the default Keychain/credentials file directly.
Only one profile can be active at a time. Prefer `run` for concurrent use.

```bash
claude-switch use work      # requires restarting claude
```

## Shell Aliases

Setup adds these to `~/.zshrc`:

- `cc-work` / `cc-personal` — launch claude with work/personal profile
- `cc-work-yolo` / `cc-personal-yolo` — same + `--dangerously-skip-permissions`
- `claude -a <name>` — launch with any saved profile (via `claude-switch init`)
- `claude --yolo` — alias for `--dangerously-skip-permissions`
