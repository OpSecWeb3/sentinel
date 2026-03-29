# Docker Compose Reference

Sentinel ships three Docker Compose files serving distinct purposes:

| File | Purpose |
|---|---|
| `docker-compose.yml` | Generic baseline; used in CI and as a reference. |
| `docker-compose.dev.yml` | Local development with isolated ports, hot-reload, and optional test runner. |
| `docker-compose.prod.yml` | Production; attaches services to external Docker networks, sets production ports, and enforces resource limits. |

## Development compose

### Overview

`docker-compose.dev.yml` provides a self-contained development environment. All services
hot-reload: code changes are picked up instantly by `tsx watch` (API, worker) and
`next dev --turbopack` (web).

### Ports

| Service | Host port | Container port |
|---|---|---|
| Web (Next.js) | 3000 | 3000 |
| API (Hono) | 4000 | 4000 |
| PostgreSQL | 5434 | 5432 |
| Redis | 6380 | 6379 |

Ports 5434 and 6380 are used to avoid conflicts with any locally-installed PostgreSQL or
Redis instances.

### Shared dev image

All application services (`api`, `worker`, `web`, `test`) share a single Dockerfile
(`Dockerfile.dev`) built on `node:22-alpine`. The image installs:

- Build toolchain (`python3`, `make`, `g++`) for native modules (argon2)
- `pnpm@9.15.4` via Corepack
- `tsx` globally for TypeScript execution

Source code is not copied into the image. Instead, it is bind-mounted at runtime via volumes,
so code changes do not require a rebuild.

### Volume mounts

The dev compose uses bind mounts to map host source directories into the container:

```yaml
volumes:
  - ./apps:/app/apps
  - ./packages:/app/packages
  - ./modules:/app/modules
  - ./tsconfig.base.json:/app/tsconfig.base.json
```

Anonymous volumes prevent host `node_modules` from shadowing container-installed dependencies:

```yaml
  - /app/node_modules
  - /app/apps/api/node_modules
  - /app/apps/worker/node_modules
  # ... one per workspace
```

### Database migrations

A dedicated `migrate` service runs `pnpm --filter @sentinel/db migrate` on startup and exits.
The `api` and `worker` services depend on it with `condition: service_completed_successfully`,
ensuring the database schema is up to date before the application starts.

### Test runner

The test service runs under the `test` profile and is not started by default:

```bash
docker compose -f docker-compose.dev.yml --profile test run --rm test
```

It uses a separate database (`sentinel_test`) and Redis database index (`/1`) to avoid
interfering with development data. The `DISABLE_RATE_LIMIT=true` flag prevents rate-limiting
middleware from interfering with rapid test requests.

### Starting development services

Start all services (infrastructure, migrations, and application):

```bash
docker compose -f docker-compose.dev.yml up
```

Rebuild the dev image after lockfile changes:

```bash
docker compose -f docker-compose.dev.yml up --build
```

Start only infrastructure (for running app services on the host):

```bash
docker compose -f docker-compose.dev.yml up postgres redis
```

### Environment variable injection (dev)

All application services load variables from `env_file: .env`. However, the dev compose file
overrides `DATABASE_URL` and `REDIS_URL` in each service's `environment` block to point to
the container-network addresses (`postgres:5432` and `redis:6379`). These overrides take
precedence over any values in `.env`.

---

## Production compose

### Overview

`docker-compose.prod.yml` is used for the Hetzner VPS deployment. It does not define
PostgreSQL or Redis services; those run as shared infrastructure on the `shared-infra` Docker
network in a parent project.

### Services

| Service | Container name | Port | Networks |
|---|---|---|---|
| API | `sentinel-api` | 4100:4100 | `gateway`, `shared-infra` |
| Worker | (unnamed, 2 replicas) | None | `shared-infra` |
| Web | `sentinel-web` | 3100:3100 | `gateway` |

### Resource limits

| Service | Memory | CPU |
|---|---|---|
| API | 384 MB | 1.0 |
| Worker (per replica) | 384 MB | 1.0 |
| Web | 384 MB | 0.5 |

Total memory for 2 worker replicas: 384 + (2 x 384) + 384 = 1,536 MB.

### Health checks

| Service | Method | Interval | Timeout | Retries | Start period |
|---|---|---|---|---|---|
| API | `wget --spider http://localhost:4100/health` | 15 s | 5 s | 3 | 10 s |
| Worker | Node.js script checking `/tmp/.worker-heartbeat` mtime < 60 s | 30 s | 5 s | 3 | 15 s |
| Web | `wget --spider http://localhost:3100/` | 15 s | 5 s | 3 | 15 s |

The worker health check verifies that the heartbeat file has been touched within the last 60
seconds. If BullMQ processing stalls, the heartbeat stops updating and Docker marks the
container as unhealthy.

### Logging

All production services use the `json-file` log driver with rotation:

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Each container retains up to 30 MB of logs (3 files of 10 MB each).

### Build arguments (web)

The web service passes build arguments that are inlined into the Next.js bundle at build time:

```yaml
args:
  - NEXT_PUBLIC_API_URL
  - NEXT_PUBLIC_SENTRY_DSN
  - NEXT_PUBLIC_SENTRY_ENVIRONMENT
  - SENTRY_ORG
  - SENTRY_PROJECT
  - SENTRY_AUTH_TOKEN
```

These values come from the `.env` file (which Docker Compose reads for build arg
substitution). Changing any of these values requires rebuilding the web image.

---

## Service definitions

### postgres (dev and baseline only)

| Property | Value |
|---|---|
| Image | `postgres:16-alpine` |
| Internal port | `5432` |
| Host port (dev) | `5434` |
| Named volume | `sentinel-pgdata` |
| Memory limit (baseline) | `1024M` |
| Health check | `pg_isready -U sentinel` every 5 s, 5 retries |

PostgreSQL stores all relational data: organizations, users, detections, alerts, events, and
audit logs. The named volume `sentinel-pgdata` persists data across container restarts and
recreation.

Environment variables injected at startup:

| Variable | Default |
|---|---|
| `POSTGRES_USER` | `sentinel` |
| `POSTGRES_PASSWORD` | `${POSTGRES_PASSWORD:-sentinel}` |
| `POSTGRES_DB` | `sentinel` |

### redis (dev and baseline only)

| Property | Value |
|---|---|
| Image | `redis:7-alpine` |
| Internal port | `6379` |
| Host port (dev) | `6380` |
| Memory limit (baseline) | `512M` |
| Health check | `redis-cli ping` every 5 s, 5 retries |

Redis backs the BullMQ job queues, rate limiter, and any short-lived caching. The baseline
`docker-compose.yml` starts Redis with `--requirepass sentinel-dev`; the dev compose file runs
Redis without a password for simplicity.

**Production note**: In production, the Redis instance runs on the shared-infra network with
password authentication. The password is injected from AWS SSM and the `REDIS_URL` variable
uses the form `redis://:<password>@redis:6379`.

### api

| Property | Dev | Production |
|---|---|---|
| Dockerfile | `Dockerfile.dev` | `apps/api/Dockerfile` |
| Port | `4000:4000` | `4100:4100` |
| Memory limit | -- | `384M` |
| CPU limit | -- | `1.0` |
| Restart policy | -- | `unless-stopped` |
| Networks | Default | `gateway`, `shared-infra` |

The API service depends on both `postgres` and `redis` reaching `service_healthy` before it
starts. In production, the API binds to port `4100` and Nginx proxies public traffic to that
port.

### worker

| Property | Dev | Production |
|---|---|---|
| Dockerfile | `Dockerfile.dev` | `apps/worker/Dockerfile` |
| Replicas | 1 | 2 |
| Memory limit | -- | `384M` per replica |
| CPU limit | -- | `1.0` per replica |
| Restart policy | -- | `unless-stopped` |
| Networks | Default | `shared-infra` only |

The worker has no public-facing port. It connects to PostgreSQL and Redis over `shared-infra`
and processes BullMQ queues for event ingestion, alert dispatch, correlation evaluation, data
retention, and integration polling.

### web

| Property | Dev | Production |
|---|---|---|
| Dockerfile | `Dockerfile.dev` | `apps/web/Dockerfile` |
| Port | `3000:3000` | `3100:3100` |
| Memory limit | -- | `384M` |
| CPU limit | -- | `0.5` |
| Restart policy | -- | `unless-stopped` |
| Networks | Default | `gateway` only |

The web service runs the Next.js standalone server. The `NEXT_PUBLIC_API_URL` build argument
must be provided at image build time because Next.js inlines `NEXT_PUBLIC_*` variables into
the JavaScript bundle during the build stage -- runtime environment variables cannot substitute
for them.

---

## Docker networks

In production, `docker-compose.prod.yml` declares both networks as external -- they must exist
before running `docker compose up`:

```bash
docker network create gateway
docker network create shared-infra
```

| Network | Purpose | Services attached |
|---|---|---|
| `gateway` | Routes ingress from the Nginx reverse proxy to app services | `api`, `web` |
| `shared-infra` | Internal-only network for service-to-service communication with PostgreSQL and Redis | `api`, `worker` |

The `worker` service is intentionally absent from `gateway`. It communicates only with
PostgreSQL and Redis over `shared-infra` and is never directly reachable from Nginx.

The deploy script creates both networks automatically (idempotently) on every deploy:

```bash
docker network create gateway 2>/dev/null || true
docker network create shared-infra 2>/dev/null || true
```

---

## Volume persistence

```yaml
volumes:
  sentinel-pgdata:
```

A single named volume, `sentinel-pgdata`, persists the PostgreSQL data directory at
`/var/lib/postgresql/data` inside the container. Docker manages this volume independently of
the container lifecycle.

To inspect the volume:

```bash
docker volume inspect sentinel-pgdata
```

To back up the database before a destructive operation:

```bash
docker exec sentinel-postgres pg_dump -U sentinel sentinel > backup-$(date +%Y%m%d).sql
```

---

## Environment variable injection

All application services (`api`, `worker`, `web`) use `env_file: .env` to load variables from
the `.env` file at the project root. Docker Compose reads each `KEY=VALUE` line and injects
them as environment variables into the container process.

Copy the example file before starting services for the first time:

```bash
cp .env.example .env
```

Variables set directly under a service's `environment` key in the compose file take precedence
over values in `env_file`. The dev compose file uses this to override `DATABASE_URL` and
`REDIS_URL` with the correct container-network addresses, regardless of what is in `.env`.

---

## Multi-stage Dockerfile design

All three application Dockerfiles follow a four-stage pattern:

| Stage | Base image | Purpose |
|---|---|---|
| `deps` | `node:22-alpine` | Install all workspace dependencies including devDependencies. |
| `builder` | `node:22-alpine` | Copy source, compile TypeScript to `dist/`. |
| `prod-deps` | `node:22-alpine` | Reinstall with `--prod` flag to exclude devDependencies. |
| `runner` | `node:22-alpine` | Copy compiled output and production `node_modules` only. |

The `runner` stage creates a non-root system user (`sentinel`, UID/GID 1001) and switches to
it before defining `CMD`. All copied files are `chown`ed to `sentinel:sentinel`. The API and
worker use `dumb-init` as PID 1 to handle signal propagation correctly.

The web `runner` stage copies the Next.js standalone output (`apps/web/.next/standalone`) which
bundles all server-side dependencies, keeping the final image small.

---

## Scaling workers

To run more than the default two worker replicas:

```bash
docker compose -f docker-compose.prod.yml up -d --scale worker=4
```

Each additional replica consumes up to 384 MB of memory and 1.0 CPU. Scale workers when queue
throughput is insufficient; monitor queue depth via `docker stats` or Sentry before adjusting.

---

## Useful commands

### View running containers and their status

```bash
docker compose -f docker-compose.prod.yml ps
```

### Stream logs from all services

```bash
docker compose -f docker-compose.prod.yml logs -f
```

### Tail the last 100 lines from a single service

```bash
docker compose -f docker-compose.prod.yml logs --tail=100 -f api
```

### Open a shell in a running container

```bash
docker compose -f docker-compose.prod.yml exec api sh
```

### Run a one-off database migration manually

```bash
docker compose -f docker-compose.prod.yml exec api npx drizzle-kit migrate --config packages/db/drizzle.config.ts
```

### Live resource usage

```bash
docker stats
```

### Stop all services (preserve volumes)

```bash
docker compose -f docker-compose.prod.yml down
```

### Stop all services and remove volumes

**Warning:** This deletes all PostgreSQL data. Use only in non-production environments.

```bash
docker compose -f docker-compose.prod.yml down -v
```
