---
name: Sentinel Project
description: Security monitoring platform — monorepo with Next.js web app, API, worker, modules
type: project
---

Full-stack security monitoring platform (monorepo: pnpm workspaces).

**Why:** Personal/non-work project for monitoring GitHub, on-chain, infra events and triggering alerts.

**How to apply:** Understand the full-stack context when suggesting changes — backend is Hono+Drizzle+BullMQ, frontend is Next.js 15 App Router.

**Web app:** `apps/web/` — Next.js 15, React 19, TypeScript, Tailwind, always dark mode.

**Design system:** Custom hand-rolled components in `apps/web/src/components/ui/`. No Radix UI (except `@radix-ui/react-slot` for Button asChild). Components: Button, Card, Input, Select, Badge, ConfirmDialog, Toast, SearchInput, FilterBar, NavTabs.

**Theme:** Terminal/hacker aesthetic — JetBrains Mono everywhere, terminal green primary, near-black bg, `$`/`>`/`[bracket]` symbols throughout, scanlines, blink cursors.

**Modules:** github, release-chain, chain (EVM on-chain), infra (host scanning).
