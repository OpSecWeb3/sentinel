# Sentinel Documentation

Sentinel is a multi-module security monitoring platform that detects, correlates, and alerts on threats across infrastructure, code repositories, supply chains, and blockchain networks. It ingests events from GitHub repositories, Ethereum Virtual Machine (EVM) blockchains, infrastructure hosts, Docker and npm package registries, and Amazon Web Services (AWS), evaluates those events against configurable detection rules, and raises enriched alerts through Slack, email, or webhook channels.

Sentinel's correlation engine connects disparate signals -- a branch protection change followed by a secrets push, or repeated failed CloudTrail calls in a short window -- into high-confidence findings that point operators directly to the root cause rather than individual indicators.

---

## Documentation tracks

This documentation is split into two tracks. Choose the track that matches your role.

| Track | Location | Audience | Covers |
|-------|----------|----------|--------|
| **Technical** (`app/`) | `docs/app/` | Platform developers, module authors, contributors | Architecture, API reference, module development, data models, deployment internals |
| **Operator guides** (`user/`) | `docs/user/` | Security engineers, DevSecOps teams | Installation, integration setup, writing detections, managing alerts, runbooks |

---

## Quick navigation

Use this table to find the right page for your task.

| I want to... | Go to |
|--------------|-------|
| Install Sentinel and receive my first alert | [Quick start](user/getting-started) |
| Understand the system architecture | [Architecture overview](app/architecture) |
| Connect a GitHub App, AWS account, or blockchain network | [Integrations guide](user/integrations) |
| Create a detection rule | [Writing detections](user/detections) |
| Use a built-in detection template | [Detection templates](user/detections) |
| Write a correlation rule (sequence, aggregation, absence) | [Correlation rules](user/detections) |
| Configure Slack, email, or webhook notifications | [Alert channels](user/alerts) |
| Triage and resolve alerts | [Managing alerts](user/alerts) |
| Look up an API endpoint | [API reference](app/api-reference) |
| Build a new detection module | [Module interface](app/modules) |
| Set up a local development environment | [Getting started (developer)](app/getting-started) |
| Deploy to production | [Deployment guide](app/deployment) |
| Set up free secret scanning | [Secret scanning](security-scanning.md) |
| Manage users, roles, and organizations | [Administration](user/administration) |
| Create and rotate API keys | [Administration](user/administration) |
| Understand data retention policies | [Data model](app/data-model) |
| Contribute code or documentation | [Contributing guide](CONTRIBUTING.md) |

---

## Prerequisites

Before you begin with either track, confirm that you have access to the following infrastructure components. Sentinel requires all three to function.

| Component | Minimum version | Purpose |
|-----------|----------------|---------|
| PostgreSQL | 16 | Primary data store for events, detections, alerts, sessions, and organization data |
| Redis | 7 | Job queue backend (BullMQ), rate limiting, and caching |
| Node.js | 22 (LTS) | Runtime for the API server, background worker, and web application |

For operators deploying Sentinel, see the [Quick start](user/getting-started) for a complete installation walkthrough.

For developers contributing to the codebase, see the [Developer getting started](app/getting-started) guide for local environment setup.

---

## Technical track -- `docs/app/`

| Document | Description |
|----------|-------------|
| `app/architecture` | System architecture, data flow, and service responsibilities |
| `app/api-reference` | REST (Representational State Transfer) API endpoints, authentication, rate limits |
| `app/modules` | `DetectionModule` interface, `EventTypeDefinition`, `DetectionTemplate`, and `TemplateInput` contracts |
| `app/modules` (GitHub) | GitHub module: webhook events, rule types, and template catalogue |
| `app/modules` (Chain) | EVM chain module: supported networks, contract monitoring, on-chain event detection |
| `app/modules` (Infra) | Infrastructure module: host-based event ingestion and detection |
| `app/modules` (Registry) | Package registry module: supply-chain events and detection templates |
| `app/modules` (AWS) | AWS module: CloudTrail event ingestion and detection rules |
| `app/correlation-engine` | Correlation engine: sequence, aggregation, and absence rule types |
| `app/services` | Session-based authentication, API keys, and RBAC (Role-Based Access Control) |
| `app/data-model` | PostgreSQL schema, Drizzle ORM conventions, retention policies |
| `app/deployment` | Docker Compose production deployment, Hetzner VPS setup, GitHub Actions CI/CD |
| `app/configuration` | Environment variables, secrets management, external dependencies |

## Operator track -- `docs/user/`

| Document | Description |
|----------|-------------|
| `user/getting-started` | Install Sentinel and receive your first alert in under 30 minutes |
| `user/integrations` | Connecting GitHub, AWS, and blockchain networks |
| `user/detections` | Creating, editing, and managing detection rules |
| `user/detections` (templates) | Using and customizing built-in detection templates |
| `user/detections` (correlation) | Writing correlation rules: sequence, aggregation, absence |
| `user/alerts` (channels) | Configuring Slack, email, and webhook notification channels |
| `user/alerts` | Triaging, acknowledging, and resolving alerts |
| `user/administration` (audit log) | Using the audit log for compliance and forensics |
| `user/administration` (RBAC) | Managing organization members, roles, and permissions |
| `user/administration` (API keys) | Creating and rotating API keys for programmatic access |
| `user/core-concepts` | Core domain concepts: events, detections, alerts, modules |
| `user/glossary.md` | Terminology reference for all Sentinel-specific terms |
| `user/troubleshooting` | Common issues and resolution steps |

---

## Getting help

- **Bug reports and feature requests:** Open an issue at the project's GitHub repository. See the [issue reporting guidelines](CONTRIBUTING.md#reporting-issues) for the expected format.
- **Security vulnerabilities:** Do not open a public issue. Follow the responsible disclosure process described in `SECURITY.md`.
- **Questions and discussion:** Use GitHub Discussions.

---

## Design system

The visual design language -- color tokens, typography, spacing, animation principles, and component conventions -- is documented in [`DESIGN.md`](../DESIGN.md) at the repository root. Consult that file before building or modifying any front-end components.
