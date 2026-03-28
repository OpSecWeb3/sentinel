# Docker Compose Reference

Sentinel ships three Docker Compose files serving distinct purposes:

| File | Purpose |
|---|---|
| `docker-compose.yml` | Generic baseline; used in CI and as a reference. |
| `docker-compose.dev.yml` | Local development with isolated ports and optional `full` profile. |
| `docker-compose.prod.yml` | Production; attaches services to external Docker networks, sets production ports. |

## Service definitions

### postgres

| Property | Value |
|---|---|
| Image | `postgres:16-alpine` |
| Internal port | `5432` |
| Host port (dev) | `5434` |
| Named volume | `sentinel-pgdata` |
| Memory limit | `1024M` |
| Health check | `pg_isready -U sentinel` every 5 s, 5 retries |

PostgreSQL stores all relational data: organizations, users, detections, alerts, events, and audit logs. The named volume `sentinel-pgdata` persists data across container restarts and recreation.

Environment variables injected at startup:

| Variable | Default |
|---|---|
| `POSTGRES_USER` | `sentinel` |
| `POSTGRES_PASSWORD` | `${POSTGRES_PASSWORD:-sentinel}` |
| `POSTGRES_DB` | `sentinel` |

### redis

| Property | Value |
|---|---|
| Image | `redis:7-alpine` |
| Internal port | `6379` |
| Host port (dev) | `6380` |
| Memory limit | `512M` |
| Health check | `redis-cli -a <password> ping` every 5 s, 5 retries |

Redis backs the BullMQ job queues, session store, and any short-lived caching. The dev compose file starts the server with `--requirepass sentinel-dev`. In production, the password is injected from AWS SSM and the `REDIS_URL` variable uses the form `redis://:<password>@redis:6379`.

### api

| Property | Value |
|---|---|
| Dockerfile | `apps/api/Dockerfile` |
| Port (dev) | `4000:4000` |
| Port (prod) | `4100:4100` |
| Memory limit (prod) | `384M` |
| CPU limit (prod) | `1.0` |
| Restart policy | `unless-stopped` |
| Networks (prod) | `gateway`, `shared-infra` |
| Health check (prod) | `wget --spider http://localhost:4100/health` every 15 s, 5 s timeout, 3 retries, 10 s start period |

The API service depends on both `postgres` and `redis` reaching `service_healthy` before it starts. In production, the API binds to port `4100` and Nginx proxies public traffic to that port.

### worker

| Property | Value |
|---|---|
| Dockerfile | `apps/worker/Dockerfile` |
| Replicas | `2` |
| Memory limit (prod) | `384M` per replica |
| CPU limit (prod) | `1.0` per replica |
| Restart policy | `unless-stopped` |
| Networks (prod) | `shared-infra` only |

The worker has no public-facing port. It connects to PostgreSQL and Redis over `shared-infra` and processes BullMQ queues for event ingestion, alert dispatch, correlation evaluation, data retention, and integration polling.

### web

| Property | Value |
|---|---|
| Dockerfile | `apps/web/Dockerfile` |
| Port (dev) | `3000:3000` |
| Port (prod) | `3100:3100` |
| Memory limit (prod) | `384M` |
| CPU limit (prod) | `0.5` |
| Restart policy | `unless-stopped` |
| Networks (prod) | `gateway` only |
| Health check (prod) | `wget --spider http://localhost:3100/` every 15 s, 5 s timeout, 3 retries, 15 s start period |

The web service runs the Next.js standalone server. The `NEXT_PUBLIC_API_URL` build argument must be provided at image build time because Next.js inlines `NEXT_PUBLIC_*` variables into the JavaScript bundle during the build stage — runtime environment variables cannot substitute for them.

## Volume persistence

```
volumes:
  sentinel-pgdata:
```

A single named volume, `sentinel-pgdata`, persists the PostgreSQL data directory at `/var/lib/postgresql/data` inside the container. Docker manages this volume independently of the container lifecycle.

To inspect the volume:

```bash
docker volume inspect sentinel-pgdata
```

To back up the database before a destructive operation:

```bash
docker exec sentinel-postgres pg_dump -U sentinel sentinel > backup-$(date +%Y%m%d).sql
```

## Environment variable injection

All application services (`api`, `worker`, `web`) use `env_file: .env` to load variables from the `.env` file at the project root. Docker Compose reads each `KEY=VALUE` line and injects them as environment variables into the container process.

Copy the example file before starting services for the first time:

```bash
cp .env.example .env
```

Variables set directly under a service's `environment` key in the compose file take precedence over values in `env_file`. The dev compose file uses this to override `DATABASE_URL` and `REDIS_URL` with the correct container-network addresses, regardless of what is in `.env`.

## Docker networks

In production, `docker-compose.prod.yml` declares both networks as external — they must exist before running `docker compose up`:

```bash
docker network create gateway
docker network create shared-infra
```

| Network | Purpose | Services attached |
|---|---|---|
| `gateway` | Routes ingress from the Nginx reverse proxy to app services | `api`, `web` |
| `shared-infra` | Internal-only network for service-to-service communication | `api`, `worker` |

The `worker` service is intentionally absent from `gateway`. It communicates only with PostgreSQL and Redis over `shared-infra` and is never directly reachable from Nginx.

The deploy script creates both networks automatically (idempotently) on every deploy:

```bash
docker network create gateway 2>/dev/null || true
docker network create shared-infra 2>/dev/null || true
```

## Starting services

### Start all services

```bash
docker compose -f docker-compose.prod.yml up -d
```

### Start only infrastructure (development)

Use this command to bring up PostgreSQL and Redis without building or starting the application services. This is the standard first step for local development:

```bash
docker compose -f docker-compose.dev.yml up postgres redis -d
```

When using the baseline `docker-compose.yml`:

```bash
docker compose up postgres redis -d
```

### Start all services including application (development)

The dev compose file uses a `full` profile for the application services. Activate it with:

```bash
docker compose -f docker-compose.dev.yml --profile full up -d
```

## Scaling workers

To run more than the default two worker replicas:

```bash
docker compose -f docker-compose.prod.yml up -d --scale worker=4
```

Each additional replica consumes up to 384 MB of memory and 1.0 CPU. Scale workers when queue throughput is insufficient; monitor queue depth in Sentry or via `docker stats` before adjusting.

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

## Multi-stage Dockerfile design

All three application Dockerfiles follow a four-stage pattern:

| Stage | Base image | Purpose |
|---|---|---|
| `deps` | `node:22-alpine` | Install all workspace dependencies including devDependencies. |
| `builder` | `node:22-alpine` | Copy source, compile TypeScript to `dist/`. |
| `prod-deps` | `node:22-alpine` | Reinstall with `--prod` flag to exclude devDependencies. |
| `runner` | `node:22-alpine` | Copy compiled output and production `node_modules` only. |

The `runner` stage creates a non-root system user (`sentinel`, UID/GID 1001) and switches to it before defining `CMD`. All copied files are `chown`ed to `sentinel:sentinel`. The API and worker use `dumb-init` as PID 1 to handle signal propagation correctly.

The web `runner` stage copies the Next.js standalone output (`apps/web/.next/standalone`) which bundles all server-side dependencies, keeping the final image small.
