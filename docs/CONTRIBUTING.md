# Contributing to Sentinel

This guide covers everything you need to contribute code, tests, modules, or documentation to the Sentinel monorepo. Read it top to bottom before opening your first pull request (PR).

---

## Prerequisites

Install the following tools before you begin. The versions listed are the same versions used in Continuous Integration (CI) and production.

| Tool | Required version | Install |
|------|-----------------|---------|
| Node.js | 22 (LTS) | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| pnpm | 9.15.4 | `npm install -g pnpm@9.15.4` |
| Docker | 24+ | [docker.com](https://www.docker.com/get-started) |
| Docker Compose | v2 (bundled with Docker Desktop) | Included with Docker Desktop |
| Git | 2.40+ | [git-scm.com](https://git-scm.com) |

Verify your setup:

```bash
node --version    # v22.x.x
pnpm --version    # 9.15.4
docker --version  # Docker version 24.x.x
```

---

## Setting up the development environment

### 1. Clone the repository

```bash
git clone https://github.com/your-org/sentinel.git
cd sentinel
```

### 2. Install dependencies

pnpm installs dependencies for all workspaces in a single pass. Do not use `npm install` or `yarn` -- the repository uses a `pnpm-lock.yaml` lockfile that other package managers do not respect.

```bash
pnpm install --frozen-lockfile
```

### 3. Start infrastructure services

The development Docker Compose file starts PostgreSQL 16 (port 5434) and Redis 7 (port 6380) with stable, predictable credentials. These services are required for the API, worker, and integration tests.

```bash
docker compose -f docker-compose.dev.yml up -d postgres redis
```

Wait for both services to report healthy:

```bash
docker compose -f docker-compose.dev.yml ps
```

### 4. Configure environment variables

Copy the example environment file and fill in the required values. Secrets for external integrations (GitHub App credentials, blockchain Remote Procedure Call (RPC) URLs, AWS credentials) are optional for local development -- you only need the ones relevant to the feature you are working on.

```bash
cp .env.example .env
```

Required variables for local development:

```text
DATABASE_URL=postgresql://sentinel:sentinel@localhost:5434/sentinel
REDIS_URL=redis://:sentinel-dev@localhost:6380
SESSION_SECRET=<at-least-32-random-characters>
ENCRYPTION_KEY=<64-hex-characters>
ALLOWED_ORIGINS=http://localhost:3000
```

Generate a `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Generate an `ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Warning:** The `.env.example` file ships with a zeroed-out `ENCRYPTION_KEY`. Replace it with a real key before starting the API server. The server encrypts integration credentials with AES-256-GCM, and a weak key compromises all stored secrets.

### 5. Run database migrations

```bash
pnpm db:migrate
```

### 6. Install security tooling (optional but recommended)

Set up local secret scanning with Gitleaks and a pre-commit hook:

```bash
pnpm run security:setup
```

This downloads a repository-local Gitleaks binary to `.tools/bin/gitleaks` and installs a Git pre-commit hook that scans staged changes for secrets. See [Security scanning](security-scanning.md) for details.

### 7. Start the development servers

You can start all services at once through Docker Compose:

```bash
pnpm dev
```

Or run each application individually in separate terminals:

**API server** (Hono, port 4000):

```bash
pnpm dev:api
```

**Background worker** (BullMQ, no HTTP port):

```bash
pnpm dev:worker
```

**Web application** (Next.js 15, port 3000):

```bash
pnpm dev:web
```

The web application is available at `http://localhost:3000`. The API is available at `http://localhost:4000`. The health check endpoint is at `http://localhost:4000/health`.

---

## Monorepo workspace structure

The repository uses pnpm workspaces with three top-level workspace groups defined in `pnpm-workspace.yaml`.

```text
sentinel/
├── apps/
│   ├── api/          # Hono REST API -- public routes, module mounts, middleware
│   ├── web/          # Next.js 15 web application
│   └── worker/       # BullMQ background job workers
├── modules/
│   ├── github/       # GitHub module: webhooks, rule evaluators, detection templates
│   ├── chain/        # EVM blockchain module: on-chain event monitoring
│   ├── infra/        # Infrastructure module: host-based event detection
│   ├── registry/     # Package registry module: supply-chain monitoring
│   └── aws/          # AWS module: CloudTrail event ingestion
└── packages/
    ├── db/           # Drizzle ORM schema, migrations, database client
    ├── shared/       # Rule engine, correlation engine, module interface, utilities
    └── notifications/ # Notification dispatch: Slack, email, webhooks
```

### Workspace naming convention

Every workspace publishes under the `@sentinel/` scope. Use the filter flag when running commands against a single workspace:

```bash
pnpm --filter @sentinel/api dev
pnpm --filter @sentinel/db generate
pnpm --filter @sentinel/shared test
```

### Internal package imports

Import from other workspaces using the package name directly. TypeScript path resolution is handled by the root `tsconfig.base.json` and each workspace's `tsconfig.json`.

```typescript
import { env } from '@sentinel/shared/env';
import { getDb } from '@sentinel/db';
import type { DetectionModule } from '@sentinel/shared/module';
```

---

## Code style requirements

### TypeScript

- All code is TypeScript 5.7+ with `strict: true` (configured in `tsconfig.base.json`). Do not use `any` without a documented justification comment.
- The base configuration targets ES2022 with ESNext module resolution (`"moduleResolution": "bundler"`).
- Prefer explicit return types on public functions and module exports.
- Use `unknown` instead of `any` for error values; narrow with `instanceof` or type guards.

### Zod validation at Application Programming Interface (API) boundaries

All HTTP request bodies and external data sources (webhook payloads, module event payloads) must be validated with a Zod schema before use. Raw `JSON.parse` output must never be assigned to a typed variable directly.

```typescript
// Correct
const body = await c.req.json();
const parsed = mySchema.safeParse(body);
if (!parsed.success) {
  return c.json({ error: 'Invalid request' }, 400);
}
const data = parsed.data; // fully typed

// Incorrect -- do not do this
const data = (await c.req.json()) as MyType;
```

### Module interface compliance

Every detection module must implement the `DetectionModule` interface from `@sentinel/shared/module`. The interface is the contract between modules and the API. Do not export any module properties that are not part of the interface unless they are internal implementation details.

### Error handling

Throw `HTTPException` from `hono/http-exception` in route handlers and middleware, not generic `Error` objects. The global error handler in `apps/api/src/index.ts` serializes `HTTPException` correctly and captures everything else to Sentry.

---

## Running tests

See [`docs/TESTING.md`](TESTING.md) for the complete testing guide. The summary below covers the essentials.

### All tests

```bash
pnpm test
```

### Unit tests only

```bash
pnpm test:unit
```

Runs tests in `packages/` and `modules/`. These tests have no external dependencies and run without Docker.

### Integration tests only

```bash
pnpm test:integration
```

Runs tests in `apps/` and `test/`. Requires a running PostgreSQL instance with a `sentinel_test` database (port 5434) and Redis (port 6380).

### Type checking and linting

Run these before pushing. CI fails the build if either check fails.

```bash
pnpm typecheck
pnpm lint
```

### Coverage thresholds

The root `vitest.config.ts` enforces minimum coverage thresholds. CI fails the build if coverage drops below these values:

| Metric | Minimum |
|--------|---------|
| Lines | 49% |
| Functions | 62% |
| Branches | 79% |
| Statements | 49% |

---

## Commit messages

Use the Conventional Commits format. The type and scope must be lowercase.

```text
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

Allowed types:

| Type | When to use |
|------|-------------|
| `feat` | A new feature visible to users or operators |
| `fix` | A bug fix |
| `refactor` | Code change that is neither a feature nor a fix |
| `test` | Adding or updating tests |
| `docs` | Documentation changes only |
| `chore` | Build scripts, CI, dependency updates |
| `perf` | Performance improvement |
| `security` | Security hardening (e.g., hashing algorithm migration, input validation) |

Examples:

```text
feat(github): add branch protection bypass detection template
fix(correlation): prevent duplicate sequence step matches in overlapping windows
docs(api): document rate limit response headers
security: migrate password hashing from bcrypt to argon2id
```

---

## Pull request process

### Branch naming

Create branches from `main`. Use the format `<type>/<short-description>`:

```bash
git checkout -b feat/aws-guardduty-events
git checkout -b fix/correlation-sequence-timeout
git checkout -b docs/module-interface-reference
```

### Before opening a pull request

Confirm the following before requesting review:

1. `pnpm typecheck` passes with no errors.
2. `pnpm lint` passes with no errors.
3. `pnpm test` passes with no failures.
4. New behavior is covered by tests.
5. Publicly visible API changes are reflected in `docs/app/api-reference.md`.
6. New environment variables are documented in `.env.example` with a comment explaining their purpose.
7. The PR description explains what changed and why, not just what the diff shows.

### Review expectations

- All PRs require at least one approving review before merge.
- Address all review comments or explicitly resolve them with a counter-argument before merging.
- Do not force-push to a PR branch after review has started. Append new commits instead so reviewers can see what changed.
- Squash commits on merge to keep the main branch history readable.

### Draft pull requests

Open a draft PR early if you want feedback on direction before the implementation is complete. Mark it ready for review only when all checks pass.

### CI pipeline

Every PR triggers the CI workflow (`.github/workflows/ci.yml`), which runs these jobs in parallel:

| Job | What it checks |
|-----|----------------|
| Gitleaks | Scans the repository for leaked secrets |
| Dependency Audit | Runs `pnpm audit --prod --audit-level=high` for known vulnerabilities |
| Trivy Filesystem Scan | Scans the filesystem for HIGH and CRITICAL vulnerabilities |
| Lint and Typecheck | Runs `pnpm lint` and `pnpm typecheck` across all workspaces |
| Build | Builds all packages with `pnpm build` |
| Migrations | Applies migrations, runs the three-way sync check, detects schema drift |
| Tests | Runs unit tests with coverage, then integration tests with coverage |

All jobs must pass before the PR can merge.

---

## Migration policy

**Always use Drizzle Kit to generate migrations -- never hand-write SQL files.**

1. Edit the TypeScript schema in `packages/db/schema/`.
2. Run `pnpm db:generate` -- Drizzle diffs the schema against its snapshot and produces the SQL file plus an updated snapshot in `migrations/meta/`.
3. Review the generated SQL for correctness.
4. Run `pnpm db:migrate` to apply the migration locally.
5. Commit both the `.sql` file and the `meta/` snapshot together.

If you need custom SQL that `generate` cannot produce (data migrations, backfills), use the custom migration flag:

```bash
pnpm --filter @sentinel/db drizzle-kit generate --custom --name=description
```

This creates an empty SQL file **with** the snapshot, keeping the migration chain intact. Never create migration files manually -- missing snapshots cause Drizzle to produce duplicate statements on the next `generate`.

### CI migration sync check

CI runs a **three-way sync check**: SQL file count must equal journal entries must equal applied database rows. It also runs `pnpm db:generate` and fails if the working tree has uncommitted changes in `packages/db/migrations/`, which detects schema drift.

### Production migration rules

Once deployed to production, migrations must be **additive-only**. Never drop, rename, or change column types in the same deploy as the code that depends on the change. Use the two-deploy pattern:

1. First deploy: remove the code dependency on the old column or table.
2. Second deploy: drop or rename the schema object.

---

## Module development

Detection modules are the primary extension point in Sentinel. Each module implements the `DetectionModule` interface and is registered in `apps/api/src/index.ts`.

A module provides:

- A Hono router mounted at `/modules/{id}` for webhook receivers and module-specific API endpoints.
- `RuleEvaluator` instances that the rule engine calls when an event matches a detection rule.
- `JobHandler` instances that BullMQ calls for scheduled or async tasks.
- `EventTypeDefinition` entries that describe the normalized event schema for each event type the module produces.
- `DetectionTemplate` definitions that users can instantiate from the UI without writing rules manually.
- Optional `RetentionPolicy` entries that the worker uses to prune stale module-owned rows.

The five built-in modules are `github`, `chain`, `infra`, `registry`, and `aws`.

For the full interface specification, field-by-field documentation, and a worked example, see [`docs/app/modules`](app/modules).

---

## Documentation contributions

### Where docs live

All documentation lives under `docs/`. The two tracks are `docs/app/` (technical) and `docs/user/` (operator guides). Do not add documentation files to application source directories.

### Style requirements

Follow the [`docs/STYLE-GUIDE.md`](STYLE-GUIDE.md) for all documentation contributions. Key points:

- Use active voice and second person ("you").
- Wrap every code block with a language tag: ` ```typescript `, ` ```bash `, ` ```sql `.
- Use relative links between documentation files.
- Do not use emojis or decorative symbols.
- Follow the [Diataxis](https://diataxis.fr/) framework: do not mix tutorials, how-to guides, reference, and explanation in a single document.

### Adding a new page

1. Create the file in the appropriate track directory.
2. Add a row for the new page in the quick navigation table in `docs/README.md`.
3. Link to the new page from any related existing pages.

### Updating existing pages

When you change an API endpoint, module interface, or environment variable, update the corresponding documentation in the same PR. Separating code changes from their documentation updates makes the docs stale and is grounds for requesting changes during review.

---

## Reporting issues

### Bug reports

Open a GitHub issue using the "Bug Report" template. Include:

1. **Summary:** A one-sentence description of the unexpected behavior.
2. **Steps to reproduce:** Numbered steps that a maintainer can follow to trigger the bug. Include exact commands, API requests, or UI actions.
3. **Expected behavior:** What you expected to happen.
4. **Actual behavior:** What happened instead. Include error messages, HTTP (Hypertext Transfer Protocol) status codes, or log output.
5. **Environment:** Node.js version, operating system, Docker version, and the Sentinel version or commit hash.
6. **Relevant configuration:** Environment variables (with secrets redacted), detection rule configuration, or module settings that affect the behavior.

If the bug involves a specific module, prefix the issue title with the module name in brackets:

```text
[chain] Block poller skips transactions when RPC returns partial batch
[registry] Docker Hub digest change evaluator fails on multi-arch manifests
```

### Feature requests

Open a GitHub issue using the "Feature Request" template. Describe:

1. **Problem:** What limitation or workflow gap the feature addresses.
2. **Proposed solution:** Your preferred approach, including API surface, configuration, and UI changes.
3. **Alternatives considered:** Other approaches you evaluated and why you rejected them.
4. **Module scope:** Which module or subsystem the feature belongs to (`chain`, `github`, `registry`, `infra`, `aws`, `shared`, `api`, `worker`, `web`).

### Security vulnerabilities

Do not open a public issue for security vulnerabilities. Follow the responsible disclosure process described in [`SECURITY.md`](../SECURITY.md) at the repository root.
