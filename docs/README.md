# Sentinel documentation

Sentinel is a multi-module security monitoring platform that detects, correlates, and alerts on threats across infrastructure, code repositories, supply chains, and blockchain networks. It ingests events from GitHub repositories, Ethereum Virtual Machine (EVM) blockchains, infrastructure hosts, Docker and npm package registries, and Amazon Web Services (AWS), evaluates those events against configurable detection rules, and raises enriched alerts through Slack, email, or webhook channels.

Sentinel's correlation engine connects disparate signals -- a branch protection change followed by a secrets push, or repeated failed CloudTrail calls in a short window -- into high-confidence findings that point operators directly to the root cause rather than individual indicators.

---

## Who this is for

- **Security engineers** who need a single pane of glass across GitHub, AWS, container registries, and blockchain networks.
- **DevSecOps teams** who want automated detection rules and alert routing without building a custom pipeline.
- **Platform developers** who want to extend Sentinel with new detection modules or integrate it into existing infrastructure.

---

## Documentation tracks

This documentation is split into two tracks. Choose the track that matches your role.

| Track | Location | Audience | Covers |
|-------|----------|----------|--------|
| **Technical** | [`docs/app/`](app/) | Platform developers, module authors, contributors | Architecture, API reference, module development, data models, deployment internals |
| **Operator guides** | [`docs/user/`](user/) | Security engineers, DevSecOps teams | Installation, integration setup, writing detections, managing alerts, runbooks |

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
| Set up a local development environment | [Developer getting started](app/getting-started) |
| Deploy to production | [Deployment guide](app/deployment) |
| Set up secret scanning in your local workflow | [Security scanning](security-scanning.md) |
| Manage users, roles, and organizations | [Administration](user/administration) |
| Create and rotate API keys | [Administration](user/administration) |
| Understand data retention policies | [Data model](app/data-model) |
| Run and write tests | [Testing guide](TESTING.md) |
| Contribute code or documentation | [Contributing guide](CONTRIBUTING.md) |
| Review documentation writing standards | [Style guide](STYLE-GUIDE.md) |

---

## Prerequisites

Before you begin with either track, confirm that you have access to the following infrastructure components. Sentinel requires all three to function.

| Component | Minimum version | Purpose |
|-----------|----------------|---------|
| PostgreSQL | 16 | Primary data store for events, detections, alerts, sessions, and organization data |
| Redis | 7 | Job queue backend (BullMQ), rate limiting, and caching |
| Node.js | 22 (LTS) | Runtime for the API server, background worker, and web application |
| pnpm | 9.15.4 | Package manager for the monorepo workspace |
| Docker | 24+ | Container runtime for local development and production deployment |

For operators deploying Sentinel, see the [Quick start](user/getting-started) for a complete installation walkthrough.

For developers contributing to the codebase, see the [Developer getting started](app/getting-started) guide and [Contributing](CONTRIBUTING.md) for local environment setup.

---

## Technical track -- `docs/app/`

| Document | Description |
|----------|-------------|
| [`app/architecture`](app/architecture) | System architecture, data flow, and service responsibilities |
| [`app/api-reference`](app/api-reference) | REST (Representational State Transfer) API endpoints, authentication, rate limits |
| [`app/modules`](app/modules) | `DetectionModule` interface, `EventTypeDefinition`, `DetectionTemplate`, and `TemplateInput` contracts |
| [`app/modules`](app/modules) (GitHub) | GitHub module: webhook events, rule types, and template catalogue |
| [`app/modules`](app/modules) (Chain) | EVM chain module: supported networks, contract monitoring, on-chain event detection |
| [`app/modules`](app/modules) (Infra) | Infrastructure module: host-based event ingestion and detection |
| [`app/modules`](app/modules) (Registry) | Package registry module: supply-chain events and detection templates |
| [`app/modules`](app/modules) (AWS) | AWS module: CloudTrail event ingestion and detection rules |
| [`app/correlation-engine`](app/correlation-engine) | Correlation engine: sequence, aggregation, and absence rule types |
| [`app/services`](app/services) | Session-based authentication, API keys, and RBAC (Role-Based Access Control) |
| [`app/data-model`](app/data-model) | PostgreSQL schema, Drizzle ORM conventions, retention policies |
| [`app/deployment`](app/deployment) | Docker Compose production deployment, Hetzner VPS setup, GitHub Actions CI/CD |
| [`app/configuration`](app/configuration) | Environment variables, secrets management, external dependencies |

## Operator track -- `docs/user/`

| Document | Description |
|----------|-------------|
| [`user/getting-started`](user/getting-started) | Install Sentinel and receive your first alert in under 30 minutes |
| [`user/integrations`](user/integrations) | Connecting GitHub, AWS, and blockchain networks |
| [`user/detections`](user/detections) | Creating, editing, and managing detection rules |
| [`user/detections`](user/detections) (templates) | Using and customizing built-in detection templates |
| [`user/detections`](user/detections) (correlation) | Writing correlation rules: sequence, aggregation, absence |
| [`user/alerts`](user/alerts) (channels) | Configuring Slack, email, and webhook notification channels |
| [`user/alerts`](user/alerts) | Triaging, acknowledging, and resolving alerts |
| [`user/administration`](user/administration) (audit log) | Using the audit log for compliance and forensics |
| [`user/administration`](user/administration) (RBAC) | Managing organization members, roles, and permissions |
| [`user/administration`](user/administration) (API keys) | Creating and rotating API keys for programmatic access |
| [`user/core-concepts`](user/core-concepts) | Core domain concepts: events, detections, alerts, modules |
| [`user/glossary.md`](user/glossary.md) | Terminology reference for all Sentinel-specific terms |
| [`user/troubleshooting`](user/troubleshooting) | Common issues and resolution steps |

---

## Project references

| Document | Location | Description |
|----------|----------|-------------|
| [Contributing](CONTRIBUTING.md) | `docs/CONTRIBUTING.md` | Development setup, branch conventions, PR process, code standards |
| [Style guide](STYLE-GUIDE.md) | `docs/STYLE-GUIDE.md` | Documentation writing standards and formatting rules |
| [Testing](TESTING.md) | `docs/TESTING.md` | Test infrastructure, running tests, writing new tests |
| [Security scanning](security-scanning.md) | `docs/security-scanning.md` | CI secret scanning, dependency auditing, Trivy filesystem scanning |
| [Security policy](../SECURITY.md) | `SECURITY.md` | Vulnerability reporting process and response targets |
| [Design system](../DESIGN.md) | `DESIGN.md` | Color tokens, typography, spacing, animation, component conventions |
| [License](../LICENSE) | `LICENSE` | MIT License |

---

## Getting help

- **Bug reports and feature requests:** Open an issue at the project's GitHub repository. See the [issue reporting guidelines](CONTRIBUTING.md#reporting-issues) for the expected format.
- **Security vulnerabilities:** Do not open a public issue. Follow the responsible disclosure process described in [`SECURITY.md`](../SECURITY.md).
- **Questions and discussion:** Use GitHub Discussions.
