---
name: npm-publish
description: Scaffold and publish npm packages under the @psg2 scope with bun, TypeScript, biome, semantic-release, and GitHub Actions. Use when the user wants to create a new package, publish to npm, bump a version, or release. Triggers on "publish a package", "create a new npm package", "npm publish", "bun publish", "version bump", "release to npm", or any @psg2/* package task. Do not trigger for unrelated uses of "release" (e.g. GitHub releases, press releases).
---

# npm Package Publishing

End-to-end workflow for creating and publishing `@psg2/*` packages to npm.

## MANDATORY RULES

- **NEVER ask the user for an OTP code.** `bun publish` opens the user's real browser for OTP automatically. `npm login` does the same for auth. The user just clicks approve — zero manual token/OTP handling.
- **NEVER run raw npm/bun publish commands directly.** Always use the scripts below — they output status codes that you interpret and communicate to the user.
- **Scripts output status codes. You interpret them and talk to the user.** Script output is inside collapsed bash blocks the user won't read. All user-facing communication must be direct messages OUTSIDE of bash calls.

---

## Workflow A: Scaffold a New Package

Use this when creating a brand-new `@psg2/*` package.

### Step 1: Scaffold

```bash
mkdir -p ~/workspace/psg2/<package-name>
cd ~/workspace/psg2/<package-name>
git init
```

Create these files using the templates in the [Scaffold Templates](#scaffold-templates) section below.

Then install and verify:

```bash
bun install
bun run lint
bun test
bun run build
```

Make the initial commit with a `feat:` prefix (triggers semantic-release 1.0.0 later):

```bash
git add -A
git commit -m "feat: initial package scaffold"
```

### Step 2: Initial Publish (0.0.0 placeholder)

Semantic-release needs the package to exist on npm before it takes over:

```bash
bash ${SKILL_DIR}/scripts/publish.sh --access public
```

- If `PUBLISH_SUCCESS` → tell the user: "The 0.0.0 placeholder is published. Setting up Trusted Publisher next."
- If `AUTH_FAILED` → run the [Auth Recovery](#auth-recovery) flow, then retry.
- If `PUBLISH_ERROR` → show the error output to the user.

### Step 3: Set Up Trusted Publisher (OIDC)

Open the access settings page for the user:

```bash
open "https://www.npmjs.com/package/@psg2/<package-name>/access"
```

Then tell the user:

> I've opened the package access page on npmjs.com. Please add a **Trusted Publisher** with these values:
>
> | Field | Value |
> |---|---|
> | Publisher | GitHub Actions |
> | Organization or user | `psg2` |
> | Repository | `<package-name>` |
> | Workflow filename | `release.yml` |
> | Environment name | `npm` |

Wait for the user to confirm they've done it.

### Step 4: Create GitHub Repo and Push

```bash
gh repo create psg2/<package-name> --public --source . --push
```

The `feat:` commit triggers semantic-release to publish 1.0.0.

### Step 5: Verify and Clean Up

Wait ~30 seconds for CI, then:

```bash
bash ${SKILL_DIR}/scripts/verify.sh "@psg2/<package-name>" "1.0.0"
```

Then remove the placeholder:

```bash
npm unpublish @psg2/<package-name>@0.0.0
```

---

## Workflow B: Publish a Release (Manual Version)

Use this for packages that don't use semantic-release, or when a direct publish is needed.

### Step 1: Preflight

```bash
bash ${SKILL_DIR}/scripts/preflight.sh [patch|minor|major]
```

- If `PREFLIGHT_READY:<name>:<version>` → proceed to Step 2.
- If `SEMANTIC_RELEASE_DETECTED` → tell the user this package uses semantic-release. Push to main with conventional commits and CI handles it. Stop here.
- If `BUILD_FAILED` → fix the build error before proceeding.

### Step 2: Write Changelog

Read the commit log from the preflight output. If CHANGELOG.md exists, add an entry at the top matching the existing format. If not, create one. Use the version from preflight. Categorize: Breaking Changes, Added, Changed, Fixed, Security, Deprecated.

### Step 3: Release (Commit + Push)

```bash
bash ${SKILL_DIR}/scripts/release.sh
```

- If `RELEASE_DONE:<name>:<version>` → proceed to Step 4.
- If `NOTHING_TO_COMMIT` → skip to Step 4.
- If `PUSH_FAILED` → tell the user about the push failure.

### Step 4: Publish

```bash
bash ${SKILL_DIR}/scripts/publish.sh --access public
```

- If `PUBLISH_SUCCESS` → proceed to Step 5.
- If `AUTH_FAILED` → run the [Auth Recovery](#auth-recovery) flow, then retry.
- If `PUBLISH_ERROR` → show the error to the user.

Tell user: "`bun publish` may open your browser for a quick OTP check — just click approve."

### Step 5: Verify

```bash
bash ${SKILL_DIR}/scripts/verify.sh "<package-name>" "<version>"
```

Run this in the background if possible. Tell the user the publish is done.

---

## Workflow C: Semantic-Release Publish (CI)

For packages with `.releaserc.json` and version `0.0.0` — the normal flow:

1. Write code with [conventional commits](#commit-convention).
2. Push to `main`.
3. CI runs tests, builds, and semantic-release handles versioning + npm publish.

The agent's role is just to help write good commits and push.

---

## Auth Recovery

When `publish.sh` outputs `AUTH_FAILED`, the user needs to log in.

```bash
bash ${SKILL_DIR}/scripts/login.sh
```

This runs `npm login` which opens the user's real default browser for OAuth. No tokens, no OTP codes — just click approve.

- If `LOGIN_SUCCESS:<username>` → tell user: "Logged in as \<username\>. Retrying publish." Then retry `publish.sh`.
- If `LOGIN_FAILED` → tell user: "npm login failed. Check your browser — the login page may still be open."

---

## Commit Convention

semantic-release uses [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Version bump | Example |
|--------|-------------|---------|
| `fix:` | patch (1.0.x) | `fix: handle empty config` |
| `feat:` | minor (1.x.0) | `feat: add github target` |
| `feat!:` or `BREAKING CHANGE:` | major (x.0.0) | `feat!: rename config format` |
| `docs:`, `chore:`, `ci:`, `test:` | no release | `docs: update README` |

---

## Scaffold Templates

### package.json (CLI)

```json
{
  "name": "@psg2/<package-name>",
  "version": "0.0.0",
  "description": "<one-line description>",
  "type": "module",
  "bin": {
    "<package-name>": "./dist/cli.js"
  },
  "scripts": {
    "build": "bun build src/cli.ts --outdir dist --target bun",
    "dev": "bun src/cli.ts",
    "lint": "bunx --bun biome check src/",
    "lint:fix": "bunx --bun biome check --write src/",
    "test": "bun test",
    "prepublishOnly": "bun run build"
  },
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/psg2/<package-name>.git"
  },
  "homepage": "https://github.com/psg2/<package-name>#readme",
  "files": ["dist", "README.md", "LICENSE"],
  "license": "MIT",
  "devDependencies": {
    "@biomejs/biome": "^2.4.7",
    "@types/bun": "^1.2.4"
  }
}
```

### package.json (Library)

Replace `bin` with `exports`:

```json
{
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun"]
  },
  "include": ["src"]
}
```

### biome.json

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.7/schema.json",
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "javascript": {
    "formatter": { "quoteStyle": "double" }
  },
  "assist": {
    "enabled": true,
    "actions": {
      "source": { "organizeImports": "on" }
    }
  }
}
```

### .releaserc.json

```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { "provenance": true }],
    ["@semantic-release/github", { "successComment": false, "failTitle": false }]
  ]
}
```

### .github/workflows/release.yml

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun test
      - run: bun run build

  release:
    needs: test
    runs-on: ubuntu-latest
    environment: npm
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - uses: actions/setup-node@v6
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org

      - run: bun install --frozen-lockfile
      - run: bun run build

      - name: Semantic Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx semantic-release
```

### .gitignore

```
node_modules/
dist/
*.tgz
```

### LICENSE

Use MIT. Set copyright year and `psg2`.
