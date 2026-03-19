# Multi-Profile Extension

Store multiple credentials per provider (e.g. personal and work Anthropic subscriptions) and switch between them via `/model` without re-authenticating.

Each profile registers separate providers (e.g. `anthropic:work`, `openai-codex:personal`) with their own credentials. Switching accounts is just switching models.

## Supported Providers

| Provider | Auth | Env Var Pattern |
|----------|------|-----------------|
| anthropic | OAuth + API key | `ANTHROPIC_<PROFILE>_API_KEY` |
| openai-codex | OAuth (ChatGPT Plus/Pro) | `OPENAI_CODEX_<PROFILE>_API_KEY` |
| openai | API key | `OPENAI_<PROFILE>_API_KEY` |
| google | API key | `GEMINI_<PROFILE>_API_KEY` |
| xai | API key | `XAI_<PROFILE>_API_KEY` |
| groq | API key | `GROQ_<PROFILE>_API_KEY` |
| openrouter | API key | `OPENROUTER_<PROFILE>_API_KEY` |
| mistral | API key | `MISTRAL_<PROFILE>_API_KEY` |
| cerebras | API key | `CEREBRAS_<PROFILE>_API_KEY` |

## Setup

```bash
cd path/to/multi-profile
npm install
```

Then either:

- **Flag:** `pi -e ./path/to/multi-profile`
- **Symlink:** `ln -s ./path/to/multi-profile ~/.pi/agent/extensions/multi-profile`

If you use the [setup.sh](../../setup.sh) script, directory extensions are handled automatically.

## Usage

### Add a profile

```
/profile add work
```

You'll be prompted to select which providers to include (or "All providers"). The extension reloads automatically after adding.

### Authenticate

**OAuth providers** (Anthropic, OpenAI Codex):

```
/login
```

Select `Anthropic (work)` or `ChatGPT Plus/Pro (work)` from the list.

**API key providers** (OpenAI, Google, xAI, etc.):

Set the environment variable with the profile name:

```bash
export OPENAI_WORK_API_KEY=sk-...
export GEMINI_WORK_API_KEY=AI...
```

### Switch accounts

```
/model
```

Pick from `anthropic:work/claude-sonnet-4-5`, `openai-codex:personal/gpt-5.1`, etc. You can also cycle with `Ctrl+P`.

### Manage profiles

```
/profile list              # show configured profiles
/profile remove work       # remove a profile
/profile color work        # set a custom color for the profile indicator
```

## Profile Color Indicators

Each profile gets a **colored indicator** so you can instantly see which profile is active:

- **Widget above the editor** — shows `● Profile: WORK` or `● Profile: PERSONAL` in the profile's color
- **Footer status** — shows a colored dot and profile name in the status bar
- **Session start notification** — profile names are color-coded in the startup message

### Default colors

| Profile Name | Color |
|-------------|-------|
| personal | Blue |
| work | Orange |
| team | Green |
| dev | Purple |
| staging | Gold |
| prod | Red |
| test | Cyan |

Other profile names get auto-assigned from a fallback palette.

### Custom colors

Use `/profile color <name>` to pick from preset colors or enter a custom value:

- **ANSI 256 color number** — e.g. `208` (orange), `39` (blue)
- **Hex color** — e.g. `#ff6600`, `#00aaff`

Custom colors are saved in `profiles.json`.

## Config

Profiles are stored in `profiles.json` next to the extension:

```json
[
  { "name": "work", "providers": ["anthropic", "openai-codex", "openai"], "color": "208" },
  { "name": "personal", "providers": ["anthropic"] }
]
```

The `color` field is optional. If omitted, the default color for that profile name is used.

## How It Works

Each profile registers a separate provider per selected base provider. For example, adding a "work" profile with anthropic and openai creates:

- `anthropic:work` — all Anthropic models, own OAuth credentials
- `openai:work` — all OpenAI models, own API key via `OPENAI_WORK_API_KEY`

Credentials are stored independently in pi's `auth.json` (for OAuth) or read from environment variables (for API keys). The built-in providers remain untouched.
