# Sentinel — Developer Documentation

This track covers the technical implementation of Sentinel: a full-stack security monitoring platform that detects and correlates security events across GitHub, EVM blockchains, infrastructure and hosts, package registries, and AWS.

The documentation is intended for developers contributing to the platform, platform engineers deploying and operating it, and security engineers extending it with new detection modules.

## What this track covers

- Standing up a local development environment from source
- Running the test suite against real infrastructure
- Understanding the system architecture and data flow
- Contributing new detection rules, modules, and UI features

For end-user guides covering the dashboard, detection authoring, and alert routing, see [docs/user/](../user/README.md).

## Navigation

### Getting Started

| Document | Description |
|---|---|
| [Prerequisites](./getting-started/prerequisites.md) | Required tooling, versions, and platform notes |
| [Local Development](./getting-started/local-development.md) | Clone, configure, and run Sentinel locally |
| [Running Tests](./getting-started/running-tests.md) | Test stack, setup, and conventions |

### Architecture

| Document | Description |
|---|---|
| [Overview](./architecture/overview.md) | System context diagram, design decisions, and technology choices |
| [Monorepo Structure](./architecture/monorepo-structure.md) | Workspace layout, dependency graph, and build order |
| [Data Flow](./architecture/data-flow.md) | Event ingestion, rule evaluation, alerting, and correlation paths |
| [Backend](./architecture/backend.md) | Hono API setup, middleware stack, route structure, and error handling |
| [Frontend](./architecture/frontend.md) | Next.js App Router structure, data fetching, and design system |
| [Security Architecture](./architecture/security-architecture.md) | Authentication, authorization, CSRF, encryption, and rate limiting |

### Additional Documentation

| Document | Description |
|---|---|
| [API Reference](./api-reference/) | Endpoint specifications, request/response schemas |
| [Configuration](./configuration/) | Environment variables, feature flags |
| [Data Model](./data-model/) | Database schema documentation |
| [Deployment](./deployment/) | Production deployment procedures |
| [Detection Engine](./detection-engine/) | Rule evaluation internals |
| [Correlation Engine](./correlation-engine/) | Cross-event correlation |
| [Modules](./modules/) | Per-module implementation guides |
| [Services](./services/) | Service-level details (API, worker, web) |
| [External Dependencies](./external-dependencies/) | Third-party service integrations |

## Repository layout (top level)

```
sentinel/
  apps/
    api/        Hono REST API — port 4000
    worker/     BullMQ background worker
    web/        Next.js 15 dashboard — port 3000
  packages/
    db/         Drizzle ORM schema and migration runner
    shared/     Cross-workspace utilities, types, and queue primitives
    notifications/  Email and Slack delivery
  modules/
    github/     GitHub webhook processing and rule evaluation
    chain/      EVM blockchain monitoring
    infra/      Host and infrastructure monitoring
    registry/   Package registry (npm, PyPI, etc.) monitoring
    aws/        AWS CloudTrail and SQS event monitoring
  docs/         This documentation tree
  docker-compose.dev.yml   Development compose (hot-reload, port 5434/6380)
  docker-compose.yml       Production-like compose (self-contained, port 5432/6379)
  docker-compose.prod.yml  Production compose (external networks, resource limits)
```

## Technology stack at a glance

| Layer | Technology |
|---|---|
| API runtime | Node.js 22, Hono 4.7, `@hono/node-server` |
| Database | PostgreSQL 16, Drizzle ORM |
| Cache / queue | Redis 7, BullMQ 5 |
| Frontend | Next.js 15 App Router, React 19, Tailwind CSS 3.4 |
| Language | TypeScript 5.7 throughout |
| Package manager | pnpm 9.15.4 workspaces |
| Containerization | Docker Compose v2 |
