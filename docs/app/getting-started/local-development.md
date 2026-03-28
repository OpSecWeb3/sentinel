# Local Development

This guide walks through setting up a fully functional Sentinel development environment on your machine.

## Step 1: Clone the repository

```bash
git clone https://github.com/your-org/sentinel.git
cd sentinel
```

## Step 2: Install dependencies

Sentinel uses pnpm workspaces. Install all dependencies from the repository root:

```bash
pnpm install
```

pnpm resolves the workspace dependency graph and links local packages (such as `@sentinel/shared` and `@sentinel/db`) as symlinks in each workspace's `node_modules`. Do not run `npm install` or `yarn install` — the lockfile is pnpm-only.

## Step 3: Configure environment variables

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` in your editor. The defaults work for local development with the Docker Compose setup below, but review each variable:

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Controls TLS-only cookie flags and HSTS headers. |
| `PORT` | `4000` | Port the Hono API server binds to. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Consumed by the Next.js frontend at build time and runtime. |
| `DATABASE_URL` | `postgresql://sentinel:sentinel@localhost:5434/sentinel` | Points to the Compose PostgreSQL container (mapped to host port 5434 in the dev compose file). |
| `REDIS_URL` | `redis://:sentinel-dev@localhost:6380` | Points to the Compose Redis container (mapped to host port 6380 in the dev compose file). |
| `API_BASE_URL` | `http://localhost:4000` | Used to construct OAuth redirect URIs for GitHub and Slack integrations. |
| `SESSION_SECRET` | `change-me-...` | Must be at least 32 characters. Change this before starting the server. |
| `ENCRYPTION_KEY` | `000...0` | 64 hex characters (32 bytes) for AES-256-GCM. Generate a real key before starting: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated list of origins allowed by the CORS middleware. |

Variables for Slack OAuth (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`), email (`SMTP_URL`, `SMTP_FROM`), and observability (`SENTRY_DSN`, `LOG_LEVEL`) are optional for local development.

The optional `ENCRYPTION_KEY_PREV` variable enables backward-compatible key rotation. Set it to the old key value when rotating `ENCRYPTION_KEY`. See [Security Architecture — Key Rotation](../architecture/security-architecture.md#key-rotation) for details.

## Step 4: Start infrastructure

Start PostgreSQL and Redis using Docker Compose:

```bash
docker compose up postgres redis -d
```

Docker Compose downloads the `postgres:16-alpine` and `redis:7-alpine` images on first run. The services use named volume `pgdata` so that your data persists across container restarts.

Verify both containers are healthy:

```bash
docker compose ps
```

Both the `postgres` and `redis` services should show `(healthy)` in the `STATUS` column. The healthchecks poll every 5 seconds with up to 5 retries.

## Step 5: Run database migrations

Sentinel uses Drizzle Kit to apply schema migrations. Run migrations against your local database:

```bash
pnpm db:migrate
```

This command runs `drizzle-kit migrate` from the `packages/db` workspace, applying any pending SQL migration files in order. Migrations are idempotent — running the command again when no new migrations exist is safe.

To seed the database with initial reference data (for example, EVM chain network definitions):

```bash
pnpm db:seed
```

To open Drizzle Studio (a browser-based schema explorer):

```bash
pnpm db:studio
```

## Step 6: Start the application services

Open three terminal tabs and start each service individually during development, so that you can see each service's log output separately.

**Terminal 1 — API server:**

```bash
pnpm dev:api
```

The Hono API server starts on `http://localhost:4000`. It uses `tsx --watch` for hot reload; changes to any TypeScript file in `apps/api/src/` restart the process automatically.

**Terminal 2 — Background worker:**

```bash
pnpm dev:worker
```

The BullMQ worker starts and connects to Redis. It registers all job handlers for event processing, alert dispatch, data retention, correlation evaluation, and module-specific jobs. The worker also schedules recurring jobs (data retention, session cleanup, key rotation, poll sweeps) on first start.

**Terminal 3 — Web frontend:**

```bash
pnpm dev:web
```

The Next.js dev server starts on `http://localhost:3000` with Turbopack. Changes to React components take effect in the browser without a full page reload.

## Step 7: Verify everything is running

Check the API health endpoint:

```bash
curl http://localhost:4000/health
```

A healthy response looks like:

```json
{
  "status": "ok",
  "db": "ok",
  "redis": "ok",
  "timestamp": "2026-03-28T12:00:00.000Z"
}
```

If `db` or `redis` is `"error"`, check that the Docker Compose containers are healthy and that `DATABASE_URL` and `REDIS_URL` in `.env` match the ports exposed by the dev compose file.

Open the dashboard in your browser at `http://localhost:3000`. You will be redirected to the registration page if no account exists yet.

## Common setup issues

### `pnpm install` fails with workspace not found

Ensure you are running `pnpm install` from the repository root (where `pnpm-workspace.yaml` lives), not from inside a workspace directory.

### API crashes immediately with `Error: Shared Redis connection not initialised`

The API process requires Redis to be reachable at startup. Confirm the Redis container is running:

```bash
docker compose ps redis
```

If the container is not running, start it with `docker compose up redis -d`.

### Migration fails with `relation already exists`

This usually means the database has a partial schema from a previous failed migration. Drizzle Kit tracks applied migrations in a `__drizzle_migrations` table. Inspect that table to determine which migrations have been applied, then resolve any schema conflicts manually.

### Port conflicts

If another process is using port 4000, 3000, 5434 (PostgreSQL), or 6380 (Redis), either stop the conflicting process or change the port mappings in the Docker Compose file and update `.env` accordingly. The production Docker Compose file (`docker-compose.prod.yml`) uses ports 4100 (API) and 3100 (web) to avoid conflicts with the development setup.

### `X-Sentinel-Request` header error during local API testing

The CSRF middleware requires the `X-Sentinel-Request` header on all state-changing requests made with a session cookie. When testing the API directly with `curl` or Postman, include the header:

```bash
curl -X POST http://localhost:4000/api/detections \
  -H "Content-Type: application/json" \
  -H "X-Sentinel-Request: 1" \
  -H "Cookie: sentinel.sid=<your-session-id>" \
  -d '{"name": "Test"}'
```

Requests authenticated with a `Bearer sk_...` API key skip the CSRF check entirely.

## Development workflow

### Making changes

- Changes to `apps/api/src/` restart the API process via `tsx --watch`.
- Changes to `apps/web/src/` are hot-reloaded by the Next.js dev server.
- Changes to shared packages (`packages/shared/`, `packages/db/`, `packages/notifications/`, `modules/*/`) are reflected immediately because those workspaces are symlinked and compiled on-the-fly by `tsx`.

### Adding a database migration

After modifying the Drizzle schema in `packages/db/src/schema/`, generate a new migration file:

```bash
pnpm db:generate
```

Review the generated SQL in `packages/db/migrations/`, then apply it:

```bash
pnpm db:migrate
```

### Building for production

Build all workspaces in dependency order:

```bash
pnpm build
```

Individual workspaces can be built in isolation:

```bash
pnpm --filter @sentinel/api build
pnpm --filter @sentinel/web build
```

### Type checking

Run TypeScript across all workspaces without emitting output:

```bash
pnpm typecheck
```

### Linting

```bash
pnpm lint
```
