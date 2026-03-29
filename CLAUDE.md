# Sentinel

Security monitoring platform — monorepo with pnpm workspaces.

## Stack

- **Web:** Next.js 15, React 19, TypeScript, Tailwind (apps/web)
- **API:** Hono, Drizzle ORM, PostgreSQL 16 (apps/api)
- **Worker:** BullMQ, Redis 7 (apps/worker)
- **Packages:** db, shared, notifications
- **Modules:** github, chain, infra, registry, aws

## Commands

- `pnpm dev` — start all services via Docker Compose
- `pnpm build` — build all packages
- `pnpm test` — run all tests (needs Postgres on :5434 and Redis on :6380)
- `pnpm test:unit` — unit tests only (packages/ and modules/)
- `pnpm test:integration` — integration tests (apps/ and test/)
- `pnpm db:generate` — generate migration from schema changes
- `pnpm db:migrate` — apply pending migrations
- `pnpm lint` / `pnpm typecheck` — lint and typecheck all packages

## Migration Policy

Migrations must be **additive-only** once deployed to production. Never drop,
rename, or change column types in the same deploy as the code that depends on
the change. Use the two-deploy pattern: first deploy removes the code dependency,
second deploy removes the schema object. This enables safe auto-rollback on
failed deploys. See `docs/app/data-model/migrations.md` for full details.

## Infrastructure

Postgres and Redis run as shared infra in the `chainalert` project (parent
directory), not in this repo's compose files. Sentinel's `docker-compose.prod.yml`
connects to them via external `shared-infra` and `gateway` Docker networks.
Do not add Postgres/Redis services to Sentinel's production compose.
