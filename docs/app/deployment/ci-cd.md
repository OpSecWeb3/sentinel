# CI/CD Pipeline

Sentinel uses GitHub Actions for continuous integration and deployment. Every push to `main` runs the full CI suite and, if it passes, deploys to the Hetzner VPS automatically. Documentation-only changes skip the deploy job.

## Pipeline overview

```mermaid
flowchart TD
    A([Push to main]) --> B{Paths changed?}
    B -->|Only *.md or docs/**| Z([Deploy skipped])
    B -->|Any other file| C

    subgraph CI ["CI Workflow (ci.yml)"]
        C[Checkout code] --> D[Setup pnpm 9.15.4 + Node 22]
        D --> E[pnpm install --frozen-lockfile]
        E --> F[pnpm lint]
        F --> G[pnpm typecheck]
        G --> H[pnpm db:migrate]
        H --> I[pnpm test]
    end

    I -->|CI passes| J

    subgraph Deploy ["Deploy Workflow (deploy.yml)"]
        J[Assume AWS IAM role via OIDC] --> K[Fetch secrets from AWS SSM]
        K --> L[Build /tmp/sentinel.env]
        L --> M[Setup SSH key]
        M --> N[Ensure repo cloned on VPS]
        N --> O[scp .env to VPS]
        O --> P[SSH: run scripts/deploy.sh]
        P --> Q{Health checks pass?}
        Q -->|Yes| R[nginx -s reload]
        Q -->|No| S[Collect logs]
        R --> T([Deploy complete])
        S --> U([Deploy failed])
    end

    I -->|CI fails| V([Blocked — deploy does not run])
```

## CI workflow

**File:** `.github/workflows/ci.yml`

### Triggers

| Event | Branches |
|---|---|
| `push` | `main`, `develop` |
| `pull_request` | `main` |

### Service containers

The CI job spins up two service containers alongside the runner:

| Service | Image | Port | Credentials |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | `5432` | user: `sentinel`, db: `sentinel_test` |
| `redis` | `redis:7-alpine` | `6379` | none (no password in CI) |

Both services use health checks (`pg_isready` and `redis-cli ping`) so that subsequent steps do not start until the containers are ready.

### Steps

| Step | Command | Description |
|---|---|---|
| Checkout | `actions/checkout@v4` | Checks out the repository at the pushed commit. |
| Setup pnpm | `pnpm/action-setup@v4` (version `9.15.4`) | Installs pnpm and activates Corepack. |
| Setup Node | `actions/setup-node@v4` (Node 22, cache: pnpm) | Installs Node.js and restores the pnpm cache. |
| Install dependencies | `pnpm install --frozen-lockfile` | Installs all workspace dependencies exactly as pinned in `pnpm-lock.yaml`. |
| Lint | `pnpm lint` | Runs ESLint across all workspaces. Fails on any lint error. |
| Typecheck | `pnpm typecheck` | Runs `tsc --noEmit` across all workspaces. Fails on any type error. |
| Run migrations | `pnpm db:migrate` | Applies Drizzle Kit migrations to the `sentinel_test` database. |
| Test | `pnpm test` | Runs the full test suite using Vitest. |

### Test environment variables

The test step uses the following environment:

| Variable | Value |
|---|---|
| `NODE_ENV` | `test` |
| `DATABASE_URL` | `postgresql://sentinel:sentinel@localhost:5432/sentinel_test` |
| `REDIS_URL` | `redis://localhost:6379/1` |
| `SESSION_SECRET` | `test-session-secret-at-least-32-chars-long!!` |
| `ENCRYPTION_KEY` | `0123456789abcdef...` (64 hex chars, test only) |
| `ALLOWED_ORIGINS` | `http://localhost:3000` |
| `SMTP_FROM` | `test@sentinel.dev` |
| `SMTP_URL` | `smtp://localhost:1025` |
| `DISABLE_RATE_LIMIT` | `true` |

`DISABLE_RATE_LIMIT=true` prevents rate-limiting middleware from interfering with rapid test requests. This variable has no effect in production.

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

A push to `main` that changes only `*.md` files or files under `docs/` does not trigger this workflow. All other changes to `main` trigger a deploy.

### Concurrency control

```yaml
concurrency:
  group: deploy-production
  cancel-in-progress: false
```

Only one deploy runs at a time in the `deploy-production` group. If a deploy is already running when a new push arrives, the new deploy queues behind the current one rather than cancelling it. This prevents partial deploys from overlapping.

### Permissions

```yaml
permissions:
  id-token: write
  contents: read
```

`id-token: write` is required for the GitHub OIDC provider to issue a short-lived token that the AWS action exchanges for temporary credentials.

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

The `deploy` job does not start until `ci` succeeds. Failures in lint, typecheck, or tests block the deploy.

## AWS OIDC authentication

The deploy workflow authenticates to AWS without storing long-lived access keys in GitHub. GitHub Actions acts as an OpenID Connect identity provider. At runtime, GitHub issues a short-lived OIDC token signed by GitHub's public key. The AWS action presents this token to AWS Security Token Service (STS) and assumes the IAM role specified in `secrets.AWS_ROLE_ARN`. STS returns temporary credentials valid for the duration of the job.

This approach means:

- No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secrets are stored in GitHub.
- Credentials expire automatically when the job ends.
- The IAM role trust policy restricts which repositories and branches can assume it.

```yaml
- name: Configure AWS credentials (OIDC)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
    aws-region: ${{ secrets.AWS_REGION }}
```

## Fetching secrets from AWS SSM

After assuming the IAM role, the workflow fetches all production secrets from AWS SSM Parameter Store and writes them to a temporary file at `/tmp/sentinel.env`:

```yaml
- name: Fetch secrets from SSM and build .env
  run: |
    fetch_param() {
      local name="$1"
      local default="${2:-}"
      local value
      value=$(aws ssm get-parameter --name "$name" --with-decryption \
        --query 'Parameter.Value' --output text 2>/dev/null) || value="$default"
      echo "$value"
    }

    DATABASE_URL=$(fetch_param /sentinel/production/DATABASE_URL)
    SESSION_SECRET=$(fetch_param /sentinel/production/SESSION_SECRET)
    # ... all other parameters
```

Parameters marked `SecureString` in SSM are decrypted in-flight using `--with-decryption`. The workflow uses `printf` (not `echo`) to append values, which correctly handles multi-line values such as PEM-encoded private keys.

The resulting `/tmp/sentinel.env` file is copied to the VPS over SSH in a subsequent step and never persisted in the GitHub Actions runner's file system beyond the job lifetime.

## SSH deployment

### Required GitHub secrets

| Secret | Description |
|---|---|
| `AWS_ROLE_ARN` | ARN of the IAM role to assume via OIDC. |
| `AWS_REGION` | AWS region where SSM parameters are stored, e.g. `us-east-1`. |
| `HETZNER_HOST` | IP address or hostname of the Hetzner VPS. |
| `HETZNER_USER` | SSH user on the VPS (e.g. `sentinel`). |
| `HETZNER_SSH_KEY` | Private SSH key (PEM format) whose public key is in the VPS `authorized_keys`. |
| `GITHUB_TOKEN` | Personal access token or built-in `GITHUB_TOKEN` used for `git clone` and `git pull` on the VPS. |

### SSH setup steps

The workflow writes the private key to `~/.ssh/deploy_key`, sets permissions to `600`, and adds the server's host key to `~/.ssh/known_hosts` using `ssh-keyscan`:

```bash
mkdir -p ~/.ssh
echo "${{ secrets.HETZNER_SSH_KEY }}" > ~/.ssh/deploy_key
chmod 600 ~/.ssh/deploy_key
ssh-keyscan -H ${{ secrets.HETZNER_HOST }} >> ~/.ssh/known_hosts
```

### Initial repository clone

If `/opt/sentinel/.git` does not exist on the server (first deploy only), the workflow clones the repository using the GitHub token:

```bash
ssh -i ~/.ssh/deploy_key ${USER}@${HOST} "
  if [ ! -d /opt/sentinel/.git ]; then
    sudo mkdir -p /opt/sentinel
    sudo chown \$USER:\$USER /opt/sentinel
    git clone 'https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git' /opt/sentinel
  fi
"
```

### .env delivery

The workflow uses `scp` to copy the assembled `.env` file directly to the VPS:

```bash
scp -i ~/.ssh/deploy_key /tmp/sentinel.env ${USER}@${HOST}:/opt/sentinel/.env
```

This replaces the `.env` file on every deploy, ensuring the running containers always use the current secrets from SSM.

### Remote deploy script execution

The deploy step SSHs into the VPS, configures the git remote to use the token for the `git pull` inside `deploy.sh`, runs the script, then resets the remote URL to the unauthenticated form:

```bash
ssh -i ~/.ssh/deploy_key ${USER}@${HOST} "
  cd /opt/sentinel
  git remote set-url origin 'https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git'
  bash scripts/deploy.sh
  git remote set-url origin 'https://github.com/${REPO}.git'
"
```

## Deploy script steps

`scripts/deploy.sh` runs on the VPS and performs the following steps:

1. **Pull latest code** — `git pull origin main` updates the working tree to the latest commit.
2. **Ensure Docker networks** — Creates `gateway` and `shared-infra` if they do not exist.
3. **Run migrations** — Sources `.env` and runs `npx drizzle-kit migrate --config packages/db/drizzle.config.ts`.
4. **Seed database** — Runs `npx tsx packages/db/src/seed.ts` to insert or update seed data (e.g. chain network definitions).
5. **Build and start containers** — `docker compose -f docker-compose.prod.yml build` followed by `docker compose -f docker-compose.prod.yml up -d --remove-orphans`.
5. **API health check** — Polls `http://localhost:4100/health` up to 30 times at 2-second intervals. Prints the attempt number on success. Dumps API logs and exits with code 1 on exhaustion.
6. **Web health check** — Polls `http://localhost:3100/` using the same retry logic.
7. **Nginx reload** — Runs `docker exec gateway nginx -s reload` to apply any updated proxy configuration. Prints a warning if the gateway container is not running but does not fail.
8. **Status output** — Prints `docker compose ps` to confirm all containers are running.

## Failure handling

If the deploy job fails at any step, the workflow's `collect logs on failure` step runs automatically:

```yaml
- name: Collect logs on failure
  if: failure()
  run: |
    ssh -i ~/.ssh/deploy_key ${USER}@${HOST} \
      "cd /opt/sentinel && docker compose -f docker-compose.prod.yml logs --tail=100" || true
```

The last 100 lines from all containers are printed to the GitHub Actions job log. The `|| true` ensures this step itself does not fail and obscure the original error.

## PR checks workflow

**File:** `.github/workflows/pr-checks.yml`

The PR checks workflow runs on every pull request targeting `main`. It uses per-PR concurrency
grouping (`pr-${{ github.event.pull_request.number }}`) with `cancel-in-progress: true`, so
force-pushing to a PR branch cancels any in-progress check run.

The workflow defines four parallel jobs:

| Job | Name | Services | Steps |
|---|---|---|---|
| `lint-typecheck` | Lint & Typecheck | None | `pnpm lint`, `pnpm typecheck` |
| `build` | Build | None | `pnpm build` (with placeholder `NEXT_PUBLIC_API_URL`) |
| `migrations` | Migrations | PostgreSQL 16 | `pnpm db:migrate`, three-way migration sync check, schema drift detection |
| `test` | Tests | PostgreSQL 16, Redis 7 | `pnpm db:migrate`, `pnpm test:unit`, `pnpm test:integration` |

### Three-way migration sync check

The `migrations` job verifies that the number of SQL migration files, journal entries in
`_journal.json`, and rows in the `drizzle.__drizzle_migrations` table all match. A mismatch
indicates that a migration file was added without updating the journal, or that a migration
was not applied.

### Schema drift detection

After applying migrations, the job runs `pnpm db:generate` (with a 30-second timeout to
prevent interactive prompts from hanging CI) and checks `git status` for uncommitted changes
in `packages/db/migrations/`. If changes are detected, the schema has drifted from the
migration files and the developer must run `pnpm db:generate` locally and commit the result.

## Skipping deploys

A push to `main` that modifies only files matching `*.md` or `docs/**` does not trigger the deploy workflow. For example, committing changes to this documentation file does not deploy to production. Any change outside those path patterns — including changes to `docs/` alongside application code — triggers the full pipeline.
