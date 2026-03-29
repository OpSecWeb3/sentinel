# Secret Scanning (Free Setup)


## What is installed

- CI workflow (deploy gate): `.github/workflows/ci.yml`
- Nightly security workflow: `.github/workflows/security-checks.yml`
- Scanner config: `.gitleaks.toml`
- Local pre-commit hook source: `.githooks/pre-commit`

CI runs:

- `gitleaks` (secrets)
- `pnpm audit --prod` (dependency vulnerabilities)
- `trivy fs` (filesystem/package/IaC vulnerabilities)

Nightly workflow runs:

- full git history `gitleaks` scan
- `osv-scanner` lockfile vulnerability scan

## One-time local setup

Run this from the repository root:

```bash
pnpm run security:setup
```

That command:

1. Downloads a repo-local `gitleaks` binary to `.tools/bin/gitleaks`
2. Installs `.git/hooks/pre-commit` so commits are scanned automatically

## Daily usage

- Scan current working tree:

```bash
pnpm run security:secrets
```

- Scan full git history:

```bash
pnpm run security:secrets:history
```

## How pre-commit behaves

On every `git commit`, the hook runs secret scanning on staged changes.
If a potential secret is detected, the commit is blocked.

## CI behavior

- PRs and pushes run security checks inside `ci.yml`
- Deploys are gated on `ci.yml`, so these security checks are required for deploy
- Nightly `security-checks.yml` adds deep/history checks (`gitleaks git`, `osv-scanner`)

## Tuning false positives

Update `.gitleaks.toml` allowlists only for known safe fixtures/examples.
Avoid broad exclusions that could hide real leaks.
