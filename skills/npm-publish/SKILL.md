---
name: npm-publish
description: Scaffold and publish a new npm package under the @psg2 scope with bun, TypeScript, biome, semantic-release, and GitHub Actions. Use when the user wants to create a new CLI tool, utility, or library and publish it to npm. Triggers on "publish a package", "create a new npm package", "bootstrap a CLI", "set up npm publishing", or any task involving new @psg2/* package creation.
---

# npm Package Publishing

End-to-end workflow for creating and publishing `@psg2/*` packages to npm.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict, ESNext, bundler resolution)
- **Linting:** Biome (tabs, double quotes, 100 char line width)
- **Versioning:** semantic-release (commit-analyzer → npm with provenance → GitHub release)
- **CI:** GitHub Actions

## 1. Scaffold the Package

```bash
mkdir -p ~/workspace/psg2/<package-name>
cd ~/workspace/psg2/<package-name>
git init
```

### package.json

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
    "@biomejs/biome": "^1.9.4",
    "@types/bun": "^1.2.4"
  }
}
```

For library packages (not CLIs), replace `bin` with `exports`:

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
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": true, "indentStyle": "tab", "lineWidth": 100 }
}
```

### .gitignore

```
node_modules/
dist/
*.tgz
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

### LICENSE

Use MIT. Set copyright year and `psg2`.

Then install and verify:

```bash
bun install
bun run lint
bun test
bun run build
```

## 2. Initial Publish (manual, one-time)

Semantic-release needs the package to exist on npm before it can take over. Publish version `0.0.0` manually as a placeholder.

```bash
npm login          # if not already logged in
npm whoami         # verify: should print "psg"
bun run build
npm publish --access public
```

## 3. Set Up npm Trusted Publisher (OIDC)

Go to https://www.npmjs.com/package/@psg2/<package-name>/access and add a Trusted Publisher:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `psg2` |
| Repository | `<package-name>` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |

This lets GitHub Actions publish via OIDC — no npm token needed as a secret.

## 4. Create GitHub Repo and Push

```bash
gh repo create psg2/<package-name> --public --source . --push
```

The `feat:` prefix on the first commit triggers semantic-release to publish `1.0.0`.

## 5. Clean Up the Placeholder

After 1.0.0 is published by CI, remove the manual placeholder:

```bash
npm unpublish @psg2/<package-name>@0.0.0
```

## Commit Convention

semantic-release uses [Conventional Commits](https://www.conventionalcommits.org/) to determine version bumps:

| Prefix | Version bump | Example |
|--------|-------------|---------|
| `fix:` | patch (1.0.x) | `fix: handle empty config` |
| `feat:` | minor (1.x.0) | `feat: add github target` |
| `feat!:` or `BREAKING CHANGE:` | major (x.0.0) | `feat!: rename config format` |
| `docs:`, `chore:`, `ci:`, `test:` | no release | `docs: update README` |

## Checklist

- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] `bun run build` produces `dist/`
- [ ] `npm publish --access public` (initial 0.0.0)
- [ ] npm Trusted Publisher configured
- [ ] `gh repo create` + push
- [ ] CI publishes 1.0.0
- [ ] `npm unpublish @psg2/<package-name>@0.0.0`
