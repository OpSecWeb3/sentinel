# Security scanning

Sentinel runs automated security scanning in Continuous Integration (CI) and on a nightly schedule. This document explains what each scanner does, how to use the tools locally, and how to interpret and fix findings.

---

## Overview

Three types of scanning protect the codebase:

| Scanner | What it finds | Where it runs |
|---------|--------------|---------------|
| Gitleaks | Secrets (API keys, tokens, passwords) committed to source code or Git history | CI (every PR), nightly (full history), local pre-commit hook |
| pnpm audit | Known vulnerabilities in production dependencies | CI (every PR) |
| Trivy | Filesystem-level vulnerabilities in packages, dependencies, and Infrastructure as Code (IaC) | CI (every PR) |
| OSV-Scanner | Lockfile-based vulnerability scanning using the Open Source Vulnerabilities database | Nightly scheduled workflow |

---

## CI pipeline (`ci.yml`)

The CI workflow (`.github/workflows/ci.yml`) runs three security jobs on every pull request to `main`. All three must pass before a PR can merge. Deploys are gated on CI, so these checks are required for production deployment.

### Gitleaks

Gitleaks scans the repository working tree for committed secrets.

**CI configuration:**

- Gitleaks version: 8.24.3
- Configuration file: `.gitleaks.toml`
- Mode: directory scan (`gitleaks dir .`) -- scans the current checkout, not full Git history
- Redaction: enabled (`--redact` flag) -- findings in CI logs show redacted values

**What it catches:**

- Hardcoded API keys, tokens, and passwords
- AWS access keys, GitHub tokens, Slack webhook URLs
- Private keys and certificates
- High-entropy strings that match secret patterns

### Dependency audit (pnpm audit)

Runs `pnpm audit --prod --audit-level=high` to check production dependencies against the npm advisory database.

**Key flags:**

- `--prod`: Scans only production dependencies, not `devDependencies`. This avoids false positives from development-only tools.
- `--audit-level=high`: Fails only on HIGH or CRITICAL severity advisories. MEDIUM and LOW findings are reported but do not block the build.

### Trivy filesystem scan

Trivy scans the repository filesystem for vulnerabilities in packages, lockfiles, and IaC configurations.

**CI configuration:**

- Mode: filesystem scan (`trivy fs .`)
- Severity filter: `HIGH,CRITICAL`
- `--ignore-unfixed`: Skips vulnerabilities without available fixes (reduces noise)
- `--exit-code 1`: Fails the CI job when findings exist

---

## Nightly security workflow (`security-checks.yml`)

The nightly workflow (`.github/workflows/security-checks.yml`) runs at 03:21 UTC daily and can also be triggered manually via `workflow_dispatch`.

### Full Git history scan (Gitleaks)

Unlike the CI scan, the nightly scan runs `gitleaks git .` which scans the entire Git history, not just the current working tree. This catches secrets that were committed and later removed but still exist in the repository history.

### OSV-Scanner

The nightly workflow runs the Open Source Vulnerabilities (OSV) Scanner against `pnpm-lock.yaml`. OSV-Scanner checks the lockfile against the OSV database, which aggregates advisories from multiple sources (GitHub Advisories, npm advisories, NVD, and others).

**Configuration:**

- Version: v2.1.0
- Command: `osv-scanner scan --lockfile=pnpm-lock.yaml`

---

## Local usage

### One-time setup

Run this from the repository root to install Gitleaks and the pre-commit hook:

```bash
pnpm run security:setup
```

This command:

1. Downloads a repository-local Gitleaks binary to `.tools/bin/gitleaks`.
2. Installs `.git/hooks/pre-commit` so commits are scanned automatically.

> **Note:** The local install script (`scripts/install-gitleaks.sh`) downloads the macOS ARM64 binary by default. If you are on a different platform, modify the `url` variable in the script or install Gitleaks through your system package manager.

### Scan the current working tree

```bash
pnpm run security:secrets
```

Scans all files in the repository directory against the rules in `.gitleaks.toml`. This is the same scan that CI runs on every pull request.

### Scan the full Git history

```bash
pnpm run security:secrets:history
```

Scans every commit in the repository's Git history. Use this to verify that no secrets exist in historical commits. This is the same scan that the nightly workflow runs.

### Pre-commit hook behavior

After running `pnpm run security:setup`, every `git commit` triggers the pre-commit hook. The hook scans staged changes for secrets. If a potential secret is detected, the commit is blocked and the finding is printed to the terminal.

To bypass the hook in an emergency (not recommended):

```bash
git commit --no-verify
```

Document any bypass in the PR description and verify the finding is a false positive before merging.

---

## Gitleaks configuration (`.gitleaks.toml`)

The configuration file at the repository root customizes Gitleaks behavior.

### Allowlist

The allowlist prevents false positives from test fixtures and documentation examples.

**Path allowlist:** Files in these directories are not scanned:

| Path pattern | Reason |
|-------------|--------|
| `^docs/` | Documentation examples may contain placeholder credentials |
| `^test/` | Test fixtures use synthetic secrets |
| `^.*__tests__/.*$` | Unit test files use synthetic secrets |
| `^.*\.test\.ts$` | Test files use synthetic secrets |

**Regex allowlist:** These specific patterns are always ignored:

| Pattern | Reason |
|---------|--------|
| `AKIA[0-9A-Z]{16}EXAMPLE` | Example AWS access key used in documentation |
| `0123456789abcdef...` (64 hex chars) | Test encryption key used in `vitest.config.ts` and CI |
| `test-session-secret-at-least-32-chars-long!!` | Test session secret used in `vitest.config.ts` and CI |

### Adding allowlist entries

If Gitleaks reports a false positive, you can add the specific pattern to `.gitleaks.toml`. Follow these guidelines:

1. **Prefer narrow regex patterns** over broad path exclusions. A regex allowlist entry targets the specific false positive. A path exclusion hides all findings in the directory.
2. **Document why the pattern is safe** in a comment above the regex.
3. **Never allowlist patterns that match real credential formats.** If you are unsure whether a finding is real, treat it as a real secret, rotate it, and remove it from the codebase.

---

## Interpreting findings

### Gitleaks findings

A Gitleaks finding looks like this:

```text
Finding:     REDACTED
RuleID:      generic-api-key
Entropy:     4.25
File:        apps/api/src/config.ts
Line:        42
Commit:      abc123def456
```

**Resolution steps:**

1. **Verify the finding.** Open the file and line number. Determine whether the value is a real credential or a false positive.
2. **If the secret is real:**
   - Rotate the credential immediately through the external service's dashboard.
   - Remove the secret from the codebase and store it in the environment (`dotenv`, SSM, or a secrets manager).
   - If the secret exists in Git history, consider using `git filter-repo` to remove it. Coordinate with the team before rewriting history.
3. **If the finding is a false positive:**
   - Add a narrow regex pattern to the `.gitleaks.toml` allowlist.
   - Open a PR with the allowlist change and document why the pattern is safe.

### pnpm audit findings

An audit finding shows the package name, severity, advisory URL, and affected version range.

**Resolution steps:**

1. **Check if the package is a direct dependency.** Run `pnpm why <package-name>` to see the dependency chain.
2. **If a patch exists:** Update the package version. For transitive dependencies, use `pnpm.overrides` in the root `package.json` to force a specific version. The Sentinel codebase already uses overrides for `tar` and `nodemailer`:

   ```json
   {
     "pnpm": {
       "overrides": {
         "tar": ">=7.5.11",
         "nodemailer": ">=7.0.11"
       }
     }
   }
   ```

3. **If no patch exists:** Assess whether the vulnerability is exploitable in Sentinel's runtime context. If the vulnerable code path is unreachable, document this in a comment in `package.json` and wait for an upstream fix.

### Trivy findings

Trivy findings show the vulnerability ID (CVE), severity, package, installed version, and fixed version.

**Resolution steps:**

1. **Identify the package and version.** Trivy reports the exact package and version with the vulnerability.
2. **Update the dependency** to the fixed version listed in the finding.
3. **If the finding is in a transitive dependency,** use `pnpm.overrides` to force the fixed version.
4. **If `--ignore-unfixed` still shows findings,** the vulnerability has no available fix. Monitor the upstream project for a patch.

### OSV-Scanner findings

OSV-Scanner findings reference advisories from the OSV database. Each finding includes a package name, version, and one or more advisory identifiers (GHSA, CVE, or OSV).

**Resolution steps:** Follow the same process as pnpm audit findings. OSV-Scanner often surfaces advisories faster than the npm advisory database because it aggregates from multiple sources.

---

## Dependency override policy

When a vulnerability exists in a transitive dependency and the direct dependency has not released a fix, use `pnpm.overrides` in the root `package.json` to pin the transitive dependency to a patched version.

Requirements for override entries:

1. The override must pin to a version that contains the fix (use `>=` syntax).
2. Add a comment in the PR description explaining which advisory the override addresses.
3. Remove the override once the direct dependency updates its own dependency.

---

## Adding a new scanner

If you want to add a new security scanner to CI:

1. Add a new job to `.github/workflows/ci.yml` following the existing pattern (pin the action or binary to a specific version or SHA).
2. Set `permissions: contents: read` on the job.
3. Document the scanner in this file under the appropriate section (CI pipeline or nightly).
4. Test the scanner locally before adding it to CI.
