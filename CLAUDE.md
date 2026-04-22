# Sentinel

Security monitoring platform — monorepo with pnpm workspaces.

## General Philosophy

When doing an analysis or evaluation, make 0 assumptions. Make sure every logical step is full backed by concrete code references and do not make any inference from variable/function/filenames without a full code backed guarantee. This is IMPORTANT for this project so etch it in your memory. Every bug path should be fully retraced in code and full path should be proven. All implementations should fully consider upstream and downstream impact of any state modifications/transistions.  

## Stack

- **Web:** Next.js 15, React 19, TypeScript, Tailwind (apps/web)
- **API:** Hono, Drizzle ORM, PostgreSQL 16 (apps/api)
- **Worker:** BullMQ, Redis 7 (apps/worker)
- **Packages:** db, shared, notifications
- **Modules:** github, chain, infra, registry, aws

## Commands

- `pnpm dev` — start all services via Docker Compose
- `pnpm build` — build all packages
- `pnpm test` — run all tests (Postgres `sentinel_test` on :5434, Redis on :6380 — see `docs/TESTING.md` if the DB is missing)
- `pnpm test:unit` — unit tests only (packages/ and modules/)
- `pnpm test:integration` — integration tests (apps/ and test/); Postgres needs database `sentinel_test` (create once on a fresh container — see `docs/TESTING.md`)
- `pnpm db:generate` — generate migration from schema changes
- `pnpm db:migrate` — apply pending migrations
- `pnpm lint` / `pnpm typecheck` — lint and typecheck all packages

## Migration Policy

**Always use Drizzle Kit to generate migrations — never hand-write SQL files.**

1. Edit the TypeScript schema in `packages/db/schema/`
2. Run `pnpm db:generate` — Drizzle diffs schema against its snapshot and
   produces the SQL + updated snapshot in `migrations/meta/`
3. Review the generated SQL for correctness
4. Run `pnpm db:migrate` to apply locally
5. Commit both the `.sql` file and the `meta/` snapshot together

If you need custom SQL that `generate` cannot produce (data migrations,
backfills), use `drizzle-kit generate --custom --name=description`. This
creates an empty SQL file **with** the snapshot, keeping the chain intact.
Never create migration files manually — missing snapshots cause Drizzle to
produce duplicate statements on the next `generate`.

CI runs a **three-way sync check**: SQL file count == journal entries ==
applied DB rows. It also runs `pnpm db:generate` to detect uncommitted
schema drift.

Once deployed to production, migrations must be **additive-only**. Never
drop, rename, or change column types in the same deploy as the code that
depends on the change. Use the two-deploy pattern: first deploy removes the
code dependency, second deploy removes the schema object.

## Infrastructure

Postgres and Redis run as shared infra in the `chainalert` project (parent
directory), not in this repo's compose files. Sentinel's `docker-compose.prod.yml`
connects to them via external `shared-infra` and `gateway` Docker networks.
Do not add Postgres/Redis services to Sentinel's production compose.

