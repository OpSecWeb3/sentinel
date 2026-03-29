# CI/CD Pipeline

Sentinel uses GitHub Actions for continuous integration and deployment. Every push to `main`
runs the full CI suite and, if it passes, deploys to the Hetzner VPS automatically.
Documentation-only changes skip the deploy job.

## Pipeline overview

```
Push to main
  |
  +-- paths-ignore: *.md, docs/**  --> Deploy skipped
  |
  +-- Any other file
        |
        v
   CI Workflow (ci.yml)
   ├── Gitleaks secret scan
   ├── Dependency audit (pnpm audit --prod)
   ├── Trivy filesystem scan
   ├── Lint & Typecheck
   ├── Build (all packages)
   ├── Migration sync check (Postgres service container)
   └── Tests (Postgres + Redis service containers)
        |
        v  (all jobs pass)
   Deploy Workflow (deploy.yml)
   ├── Assume AWS IAM role via OIDC
   ├── Fetch secrets from AWS SSM
   ├── Build /tmp/sentinel.env
   ├── Setup SSH key
   ├── Ensure repo cloned on VPS
   ├── SCP .env to VPS
   ├── SSH: run scripts/deploy.sh
   ├── External smoke check (curl /health)
   └── Collect logs on failure
```

## CI workflow

**File:** `.github/workflows/ci.yml`

### Triggers

| Event | Branches |
|---|---|
| `pull_request` | `main` |
| `workflow_call` | (reusable -- called by `deploy.yml`) |

### Permissions

```yaml
permissions:
  contents: read
```

The CI workflow uses read-only permissions. No write access to the repository is required.

### Concurrency

```yaml
concurrency:
  group: ci-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: true (for PRs only)
```

Force-pushing to a PR branch cancels any in-progress CI run for that PR. Push events to `main`
(via `workflow_call` from deploy) are not cancelled.

### Jobs

The CI workflow runs seven parallel jobs:

| Job | Name | Service containers | Steps |
|---|---|---|---|
| `gitleaks` | Gitleaks | None | Scan repository for leaked secrets |
| `dependency-audit` | Dependency Audit | None | `pnpm audit --prod --audit-level=high` |
| `trivy-fs` | Trivy Filesystem Scan | None | `trivy fs --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 .` |
| `lint-typecheck` | Lint & Typecheck | None | `pnpm lint`, `pnpm typecheck` |
| `build` | Build | None | `pnpm build` (with placeholder `NEXT_PUBLIC_API_URL`) |
| `migrations` | Migrations | PostgreSQL 16 | `pnpm db:migrate`, three-way sync check, schema drift detection |
| `test` | Tests | PostgreSQL 16, Redis 7 | `pnpm db:migrate`, `pnpm test:unit --coverage`, `pnpm test:integration --coverage` |

### Service containers

The `migrations` and `test` jobs spin up service containers alongside the runner:

| Service | Image | Port | Credentials |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | `5432` | user: `sentinel`, password: `sentinel`, db: `sentinel_test` |
| `redis` | `redis:7-alpine` | `6379` | None (no password in CI) |

Both services use health checks (`pg_isready` and `redis-cli ping`) so that subsequent steps
do not start until the containers are ready.

### Test environment variables

The integration test step uses the following environment:

| Variable | Value |
|---|---|
| `NODE_ENV` | `test` |
| `DATABASE_URL` | `postgresql://sentinel:sentinel@localhost:5432/sentinel_test` |
| `REDIS_URL` | `redis://localhost:6379/1` |
| `SESSION_SECRET` | `test-session-secret-at-least-32-chars-long!!` |
| `ENCRYPTION_KEY` | `0123456789abcdef...` (64 hex chars, test only) |
| `ALLOWED_ORIGINS` | `http://localhost:3000` |
| `API_BASE_URL` | `http://localhost:4000` |
| `SMTP_FROM` | `test@sentinel.dev` |
| `SMTP_URL` | `smtp://localhost:1025` |
| `DISABLE_RATE_LIMIT` | `true` |

`DISABLE_RATE_LIMIT=true` prevents rate-limiting middleware from interfering with rapid test
requests. This variable has no effect in production.

### Three-way migration sync check

The `migrations` job verifies that the number of SQL migration files, journal entries in
`_journal.json`, and rows in the `drizzle.__drizzle_migrations` table all match:

```bash
SQL_COUNT=$(ls packages/db/migrations/*.sql 2>/dev/null | wc -l)
JOURNAL_COUNT=$(grep -c '"tag"' packages/db/migrations/meta/_journal.json)
DB_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT count(*) FROM drizzle.__drizzle_migrations;")
```

A mismatch indicates that a migration file was added without updating the journal, or that a
migration was not applied. This check catches:

- Migration files committed without running `pnpm db:generate` (missing journal entry).
- Journal entries without corresponding SQL files (deleted migration).
- Migrations that failed to apply (database row count mismatch).

### Schema drift detection

After applying migrations, the job runs `pnpm db:generate` (with a 30-second timeout to
prevent interactive prompts from hanging CI) and checks `git status` for uncommitted changes
in `packages/db/migrations/`. If changes are detected, the schema has drifted from the
migration files and the developer must run `pnpm db:generate` locally and commit the result.

---

## Security scanning

### Gitleaks

Gitleaks scans the repository directory for hardcoded secrets (API keys, passwords, tokens).
It uses the `.gitleaks.toml` configuration file at the repository root for custom rules and
allowlists. The scan runs on every PR and on every push to `main` (via the CI reusable
workflow).

- **Version**: 8.24.3 (pinned)
- **Mode**: Directory scan (`gitleaks dir .`)
- **Output**: Redacted (the `--redact` flag masks secret values in output)

### Trivy filesystem scan

[Trivy](https://aquasecurity.github.io/trivy/) scans the filesystem for:

- Known vulnerabilities in dependencies (lockfiles, package manifests).
- Misconfigurations in Dockerfiles and infrastructure files.

Configuration:

- **Severity**: HIGH and CRITICAL only.
- **Flag**: `--ignore-unfixed` skips vulnerabilities without available patches.
- **Exit code**: 1 on findings (fails the CI job).

### pnpm audit

`pnpm audit --prod --audit-level=high` checks production dependencies against the npm
advisory database. Only HIGH and above advisories fail the build.

### Pinned action versions

All GitHub Actions in the CI workflow are pinned to full commit SHAs (not mutable tags) to
prevent supply-chain attacks via tag reassignment:

```yaml
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
- uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0
- uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
```

---

## Scheduled security workflow

**File:** `.github/workflows/security-checks.yml`

### Triggers

| Trigger | Schedule |
|---|---|
| `schedule` | Daily at 03:21 UTC |
| `workflow_dispatch` | Manual trigger |

### Jobs

| Job | Tool | Description |
|---|---|---|
| `gitleaks` | Gitleaks 8.24.3 | Full git history scan (`gitleaks git .`). Scans all commits, not just the working directory. |
| `osv-scanner` | OSV Scanner v2.1.0 | Lockfile vulnerability scan against the [OSV database](https://osv.dev/). Scans `pnpm-lock.yaml` for known vulnerabilities across all ecosystems (npm, GitHub Advisories, etc.). |

The nightly security workflow differs from the CI workflow:

- Gitleaks scans the full git history (not just the working directory), catching secrets in
  any historical commit.
- OSV Scanner provides a second opinion on dependency vulnerabilities, complementing the
  `pnpm audit` and Trivy scans in CI.

---

## Deploy workflow

**File:** `.github/workflows/deploy.yml`

### Triggers

```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - "*.md"
      - "docs/**"
```

A push to `main` that changes only `*.md` files or files under `docs/` does not trigger this
workflow. All other changes to `main` trigger a deploy.

### Concurrency control

```yaml
concurrency:
  group: deploy-production
  cancel-in-progress: false
```

Only one deploy runs at a time in the `deploy-production` group. If a deploy is already
running when a new push arrives, the new deploy queues behind the current one rather than
cancelling it. This prevents partial deploys from overlapping.

### Permissions

```yaml
permissions:
  id-token: write
  contents: read
```

`id-token: write` is required for the GitHub OIDC provider to issue a short-lived token that
the AWS action exchanges for temporary credentials.

### Job order

The deploy workflow reuses the CI workflow as a required job:

```yaml
jobs:
  ci:
    uses: ./.github/workflows/ci.yml

  deploy:
    needs: ci
    runs-on: ubuntu-latest
    environment: production
```

The `deploy` job does not start until `ci` succeeds. Failures in any CI job block the deploy.

### AWS OIDC authentication

The deploy workflow authenticates to AWS without storing long-lived access keys in GitHub.
GitHub Actions acts as an OpenID Connect identity provider. At runtime, GitHub issues a
short-lived OIDC token signed by GitHub's public key. The AWS action presents this token to
AWS Security Token Service (STS) and assumes the IAM role specified in `secrets.AWS_ROLE_ARN`.
STS returns temporary credentials valid for the duration of the job.

This approach means:

- No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secrets are stored in GitHub.
- Credentials expire automatically when the job ends.
- The IAM role trust policy restricts which repositories and branches can assume it.

### Secret fetching from AWS SSM

After assuming the IAM role, the workflow fetches all production secrets from AWS SSM
Parameter Store and writes them to a temporary file at `/tmp/sentinel.env`. The `fetch_param`
helper function handles missing parameters gracefully by returning a default value or an
empty string.

Parameters marked `SecureString` in SSM are decrypted in-flight using `--with-decryption`.
The workflow uses `printf` (not `echo`) to append values, which correctly handles multi-line
values such as PEM-encoded private keys.

### Required SSM parameter validation

Before copying the `.env` file to the server, the workflow validates that all required SSM
parameters have non-empty values:

- `DATABASE_URL`
- `SESSION_SECRET`
- `ENCRYPTION_KEY`
- `ALLOWED_ORIGINS`
- `NEXT_PUBLIC_API_URL`
- `REDIS_PASSWORD`
- `TRUSTED_PROXY_COUNT`

If any required parameter is empty, the workflow fails with an error listing the missing
parameters and their SSM paths.

### SSH deployment

#### Required GitHub secrets

| Secret | Description |
|---|---|
| `AWS_ROLE_ARN` | ARN of the IAM role to assume via OIDC. |
| `AWS_REGION` | AWS region where SSM parameters are stored, e.g. `eu-west-2`. |
| `HETZNER_HOST` | IP address or hostname of the Hetzner VPS. |
| `HETZNER_USER` | SSH user on the VPS (e.g. `sentinel`). |
| `HETZNER_SSH_KEY` | Private SSH key (PEM format) whose public key is in the VPS `authorized_keys`. |
| `GITHUB_TOKEN` | Personal access token or built-in `GITHUB_TOKEN` used for `git clone` and `git pull` on the VPS. |

#### SSH setup steps

The workflow writes the private key to `~/.ssh/deploy_key`, sets permissions to `600`, and
adds the server's host key to `~/.ssh/known_hosts` using `ssh-keyscan`.

#### .env delivery

The workflow uses `scp` to copy the assembled `.env` file directly to the VPS:

```bash
scp -i ~/.ssh/deploy_key /tmp/sentinel.env ${USER}@${HOST}:/opt/sentinel/.env
ssh -i ~/.ssh/deploy_key ${USER}@${HOST} "chmod 600 /opt/sentinel/.env"
```

This replaces the `.env` file on every deploy, ensuring the running containers always use the
current secrets from SSM.

#### Remote deploy script execution

The deploy step SSHs into the VPS, temporarily configures the git remote to use the token for
the `git pull` inside `deploy.sh`, runs the script, then resets the remote URL to the
unauthenticated form via a `trap` handler:

```bash
ssh -i ~/.ssh/deploy_key ${USER}@${HOST} "
  cd /opt/sentinel
  git remote set-url origin 'https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git'
  trap 'git remote set-url origin https://github.com/${REPO}.git' EXIT
  bash scripts/deploy.sh
"
```

### External smoke check

After the deploy script completes, the workflow performs an external health check from the
GitHub Actions runner (not from the VPS):

```bash
API_URL=$(aws ssm get-parameter --name /sentinel/production/NEXT_PUBLIC_API_URL ...)
curl -fsS --max-time 8 "${API_URL}/health"
```

This validates that the API is reachable from the public internet, not just from localhost on
the VPS. It retries up to 10 times with 3-second intervals.

### Failure handling

If the deploy job fails at any step, the `collect logs on failure` step runs automatically:

```yaml
- name: Collect logs on failure
  if: failure()
  run: |
    ssh -i ~/.ssh/deploy_key ${USER}@${HOST} \
      "cd /opt/sentinel && docker compose -f docker-compose.prod.yml logs --tail=100" || true
```

The last 100 lines from all containers are printed to the GitHub Actions job log. The
`|| true` ensures this step itself does not fail and obscure the original error.

---

## Interpreting CI failures

### Gitleaks failure

A Gitleaks failure means the scan detected a pattern matching a known secret type (API key,
private key, password, etc.) in the repository files. To resolve:

1. Check the Gitleaks output for the file and line number.
2. If the finding is a false positive, add an allowlist entry to `.gitleaks.toml`.
3. If the finding is a real secret, remove it from the repository and rotate the credential.

### Dependency audit failure

A `pnpm audit` failure indicates a HIGH or CRITICAL vulnerability in a production dependency.
To resolve:

1. Run `pnpm audit --prod` locally to see the full advisory details.
2. Update the affected package: `pnpm update <package>`.
3. If no fix is available, evaluate the impact. The `pnpm.overrides` field in `package.json`
   can force a specific version of a transitive dependency.

### Trivy failure

A Trivy failure indicates a HIGH or CRITICAL vulnerability in the filesystem scan. Trivy
checks lockfiles, Dockerfiles, and IaC files. The `--ignore-unfixed` flag means only
vulnerabilities with available patches trigger failures.

### Build failure

A build failure indicates a TypeScript compilation error in one of the workspace packages.
Run `pnpm build` locally to reproduce and fix.

### Migration sync check failure

This failure means the SQL files, journal entries, and applied database rows are out of sync.
Common causes:

- A migration was generated but not committed (`pnpm db:generate` output not staged).
- A migration file was manually deleted or renamed.
- The journal file (`_journal.json`) was edited by hand.

Run `pnpm db:generate` locally, verify the output, and commit both the SQL and meta files.

### Schema drift failure

This failure means the TypeScript schema in `packages/db/schema/` has changed but no
migration file was generated. Run `pnpm db:generate` locally and commit the result.

### Test failure

Run the failing test locally:

```bash
pnpm test:unit    # for unit tests
pnpm test:integration   # for integration tests (requires Postgres + Redis)
```

See `docs/TESTING.md` for database setup instructions.

---

## Skipping deploys

A push to `main` that modifies only files matching `*.md` or `docs/**` does not trigger the
deploy workflow. Any change outside those path patterns -- including changes to `docs/`
alongside application code -- triggers the full pipeline.
