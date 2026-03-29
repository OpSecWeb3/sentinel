# Prerequisites

Install and verify the following tools before setting up a local Sentinel development environment.

## System requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 2 cores | 4 cores |
| RAM | 4 GB | 8 GB |
| Disk | 5 GB free (for Docker images, node_modules, and database data) | 10 GB free |
| OS | macOS 13+, Ubuntu 22.04+, Windows 11 with WSL2 | macOS or Linux |

The Docker VM (on macOS and Windows) must be allocated at least 4 GB of memory. The default 2 GB is insufficient to run PostgreSQL, Redis, and all three application services simultaneously.

## Required tools

| Tool | Minimum version | Notes |
|---|---|---|
| Node.js | 22.x | Use the LTS release. Earlier versions lack the native fetch and crypto APIs that Sentinel uses. |
| pnpm | 9.15.4 | The `packageManager` field in `package.json` pins this exact version. Use `corepack enable` to activate it automatically. |
| Docker | 24.0+ | Required to run PostgreSQL and Redis locally. |
| Docker Compose | v2 (plugin) | Sentinel uses `docker compose` (the v2 CLI plugin), not the standalone `docker-compose` binary. |
| Git | 2.x | Any recent release works. |

### Verifying versions

```bash
node --version        # must be >= 22.0.0
pnpm --version        # must be 9.15.4
docker --version      # must be >= 24.0.0
docker compose version  # must show v2.x.x
git --version
```

### Activating pnpm with Corepack

If you installed Node.js via a version manager such as `nvm` or `fnm`, activate Corepack so that the correct pnpm version is resolved automatically:

```bash
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

## Recommended tools

These tools are not required to run Sentinel but improve the development experience significantly.

| Tool | Purpose |
|---|---|
| VS Code | The repository includes editor settings for TypeScript path mappings and formatting. |
| VS Code — [TypeScript and JavaScript Language Features](https://marketplace.visualstudio.com/items?itemName=vscode.typescript-language-features) | Accurate IntelliSense across all workspaces. Enable "Use workspace version" when prompted. |
| VS Code — [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) | Autocomplete and linting for Tailwind utility classes in the `apps/web` workspace. |
| VS Code — [Drizzle ORM](https://marketplace.visualstudio.com/items?itemName=drizzle.drizzle-orm) | Schema highlighting and migration assistance. |

## Optional tools

These tools allow you to inspect the database and cache directly, which is useful when debugging event pipelines or session state.

| Tool | Install | Purpose |
|---|---|---|
| `psql` | `brew install postgresql` / `apt install postgresql-client` | Query PostgreSQL directly. The dev compose maps Postgres to `localhost:5434` (not the default 5432). Connect with `psql -h localhost -p 5434 -U sentinel sentinel`. |
| `redis-cli` | Bundled with Redis or `brew install redis` | Inspect BullMQ queues and rate-limit keys. The dev compose Redis is on `localhost:6380` with no password. Connect with `redis-cli -p 6380`. |
| AWS CLI | `brew install awscli` / [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | Required for `scripts/seed-ssm.sh` which stores environment variables in AWS SSM Parameter Store for production deployments. Also useful for testing the AWS module's SQS integration locally. |
| GitHub CLI (`gh`) | `brew install gh` / [official installer](https://cli.github.com/) | Useful for managing GitHub App installations and testing the GitHub module's webhook verification locally. Not required for normal development. |

## Shared infrastructure (production)

In production, PostgreSQL and Redis run as shared infrastructure in the parent `chainalert` project, not in Sentinel's compose files. Sentinel's `docker-compose.prod.yml` connects to them via external `shared-infra` and `gateway` Docker networks. Do not add PostgreSQL or Redis services to Sentinel's production compose.

For local development, the `docker-compose.dev.yml` file includes standalone PostgreSQL and Redis containers. These are isolated from any host-level database or cache instances by using non-standard ports (5434 and 6380).

## Platform notes

### macOS

Docker Desktop for Mac provides both the Docker daemon and the Compose plugin. Allocate at least 4 GB of memory to the Docker VM in Docker Desktop settings to run all services comfortably.

Install Node.js with [nvm](https://github.com/nvm-sh/nvm) or [Volta](https://volta.sh/):

```bash
# nvm
nvm install 22
nvm use 22
```

### Linux

Install Docker Engine (not Docker Desktop) using the official repository for your distribution. Ensure the Compose plugin is installed:

```bash
sudo apt install docker-compose-plugin   # Debian / Ubuntu
sudo dnf install docker-compose-plugin   # Fedora / RHEL
```

Add your user to the `docker` group to avoid requiring `sudo` for every Docker command:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Windows (WSL2)

Run all development tooling inside a WSL2 distribution (Ubuntu 22.04 or later is recommended). Docker Desktop for Windows with the WSL2 backend automatically exposes the Docker socket to WSL distributions.

**Important:** Clone the repository inside the WSL2 filesystem (`~/` or `/home/<user>/`), not on the Windows filesystem (`/mnt/c/`). File-system watchers used by hot-reload do not work reliably across the WSL2/Windows boundary, and `pnpm install` performance degrades significantly on the Windows filesystem.

```bash
# Inside your WSL2 terminal
cd ~
git clone https://github.com/your-org/sentinel.git
```
