# Production VPS Deployment

Sentinel runs in production on a Hetzner VPS. This document covers server provisioning,
initial setup, and ongoing operations.

## Server requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 40 GB SSD | 80 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| Open ports | 22, 80, 443 | 22, 80, 443 |

The combined memory limits for the application containers defined in `docker-compose.prod.yml`
are: API 384 MB, two workers at 384 MB each, and web 384 MB, totaling 1,536 MB. PostgreSQL
and Redis run on the shared-infra network and are not defined in the Sentinel compose file;
their resource consumption depends on their own configuration. A 4 GB server provides
sufficient headroom for the application containers, the OS, Nginx, and the shared database
services.

## Initial server setup

### 1. Connect to the server

```bash
ssh root@<your-server-ip>
```

### 2. Create a deploy user

Do not run the application as root. Create a dedicated user and grant it Docker access:

```bash
useradd -m -s /bin/bash sentinel
usermod -aG docker sentinel
```

Add the user's public key (or copy the root authorized key):

```bash
mkdir -p /home/sentinel/.ssh
cp ~/.ssh/authorized_keys /home/sentinel/.ssh/authorized_keys
chown -R sentinel:sentinel /home/sentinel/.ssh
chmod 700 /home/sentinel/.ssh
chmod 600 /home/sentinel/.ssh/authorized_keys
```

### 3. Install Docker

```bash
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Verify the installation:

```bash
docker --version
docker compose version
```

### 4. Install Node.js and pnpm

The deploy script runs Drizzle Kit migrations directly on the host (outside Docker) using the
`npx drizzle-kit` command. Node.js and pnpm must be installed on the server:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pnpm@9.15.4
```

### 5. Install wget

The health check in `deploy.sh` uses `wget`. Confirm it is installed:

```bash
apt-get install -y wget
```

## Docker network setup

Create the two external Docker networks that `docker-compose.prod.yml` expects. These are
created once and persist across deploys:

```bash
docker network create gateway
docker network create shared-infra
```

The deploy script also creates these networks idempotently on every run (`|| true` suppresses
the "already exists" error), so this step is only required for the initial server setup.

| Network | Attached services | Description |
|---|---|---|
| `gateway` | `api`, `web`, Nginx container | Routes ingress from the Nginx reverse proxy. |
| `shared-infra` | `api`, `worker`, PostgreSQL, Redis | Internal network; not reachable from Nginx. |

## Shared infrastructure (PostgreSQL and Redis)

PostgreSQL and Redis run as shared infrastructure in a parent project (typically named
`chainalert`), not in the Sentinel compose file. Both services must be attached to the
`shared-infra` Docker network so that Sentinel containers can reach them.

### PostgreSQL

- Image: `postgres:16-alpine`
- Must be accessible from the `shared-infra` network.
- Use password authentication. Store the password in AWS SSM.
- Append `?sslmode=require` to `DATABASE_URL` if TLS is configured on the server.
- The deploy script runs migrations on the host via `npx drizzle-kit migrate`, which connects
  to PostgreSQL using the `DATABASE_URL` from `.env`.

### Redis

- Image: `redis:7-alpine`
- Must be password-protected in production. The Zod schema enforces a password in the
  `REDIS_URL` when `NODE_ENV=production`.
- Must be accessible from the `shared-infra` network.
- Use `rediss://` (TLS) when possible.
- The Redis password is stored at `/shared/production/REDIS_PASSWORD` in AWS SSM (a shared
  infrastructure path, not under the `/sentinel/` prefix).

## Deploy directory

The application lives at `/opt/sentinel`:

```bash
mkdir -p /opt/sentinel
chown sentinel:sentinel /opt/sentinel
```

All subsequent operations run from this directory.

## Nginx reverse proxy

Nginx proxies public HTTPS traffic to the application containers. Sentinel recommends running
Nginx as a Docker container attached to the `gateway` network, named `gateway`, so that
`docker exec gateway nginx -s reload` (called by the deploy script) works correctly.

### Example Nginx configuration

Create the Nginx configuration file (location depends on your Nginx setup -- containerized
or host-installed):

```nginx
# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name api.your-domain.com your-domain.com;

    # ACME challenge for Let's Encrypt
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# API server
server {
    listen 443 ssl;
    server_name api.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/api.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    location / {
        proxy_pass         http://sentinel-api:4100;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Request size limit (webhook payloads)
        client_max_body_size 10m;
    }
}

# Web frontend
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        proxy_pass         http://sentinel-web:3100;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

`sentinel-web` and `sentinel-api` resolve inside the `gateway` Docker network by their
container names.

### Important: TRUSTED_PROXY_COUNT

When running behind Nginx, set `TRUSTED_PROXY_COUNT=1` in the production `.env` file. This
configures the API's rate limiter and IP extraction to read the real client IP from
`X-Forwarded-For` at depth 1 from the right, instead of seeing every request as originating
from the Nginx container IP.

### SSL with Let's Encrypt

Use Certbot to obtain and auto-renew a TLS certificate:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com -d api.your-domain.com
```

Certbot installs a systemd timer that renews certificates automatically before expiry.

For a containerized Nginx, use the `certbot/certbot` Docker image or mount the certificate
volume from the host.

## First deploy

### 1. Clone the repository

Switch to the `sentinel` user and clone the repository:

```bash
su - sentinel
git clone https://github.com/your-org/sentinel.git /opt/sentinel
cd /opt/sentinel
```

### 2. Seed SSM parameters

Before the first deploy, populate AWS SSM Parameter Store with all production secrets:

```bash
bash scripts/seed-ssm.sh --generate
```

This generates `SESSION_SECRET` and `ENCRYPTION_KEY` automatically and prompts for all other
values. See [Secrets Management](./secrets-management.md) for the full parameter list and
rotation procedures.

Seed the shared Redis password separately:

```bash
aws ssm put-parameter \
  --region eu-west-2 \
  --name /shared/production/REDIS_PASSWORD \
  --type SecureString \
  --value '<password>' \
  --overwrite
```

### 3. Create the .env file

The `.env` file is not committed to git. In production, the CI/CD pipeline copies it to the
server on every deploy. For the initial deploy, create it manually from the SSM parameters or
from your secure password store:

```bash
cp .env.example .env
# Edit .env and fill in all production values
nano /opt/sentinel/.env
chmod 600 /opt/sentinel/.env
```

The deploy script verifies that `.env` has permissions `600` and refuses to proceed otherwise.

Key variables that must be set for production:

| Variable | Description |
|---|---|
| `NODE_ENV` | Must be `production`. |
| `DATABASE_URL` | PostgreSQL connection string; append `?sslmode=require` if using TLS. |
| `REDIS_URL` | Redis connection string; use `rediss://` for TLS-encrypted connections. Include the password. |
| `SESSION_SECRET` | Random string, minimum 32 characters. |
| `ENCRYPTION_KEY` | 64 hex characters (32 bytes). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `ALLOWED_ORIGINS` | Comma-separated list of your public domain(s), e.g. `https://your-domain.com`. |
| `NEXT_PUBLIC_API_URL` | Public URL of the API, e.g. `https://api.your-domain.com`. |
| `API_BASE_URL` | Same as `NEXT_PUBLIC_API_URL`. Used for OAuth redirect URIs. |
| `TRUSTED_PROXY_COUNT` | Set to `1` when behind a single Nginx reverse proxy. |

### 4. Run the deploy script

```bash
cd /opt/sentinel
bash scripts/deploy.sh
```

The script executes the following steps in order:

1. Verifies `.env` file permissions are `600`.
2. Captures the current git commit SHA for potential rollback.
3. Pulls the latest code from `origin main`.
4. Detects whether the deploy includes database migrations.
5. Creates the `gateway` and `shared-infra` Docker networks if they do not exist.
6. Installs host dependencies with `pnpm install --frozen-lockfile`.
7. Builds Docker images.
8. If migrations are pending, takes a pre-migration database backup via `scripts/backup-db.sh`.
9. Loads `.env` and runs `npx drizzle-kit migrate` against the production database.
10. Runs the database seed script (`npx tsx packages/db/src/seed.ts`).
11. Starts all containers with `docker compose -f docker-compose.prod.yml up -d --remove-orphans`.
12. Polls `http://localhost:4100/health` until the API responds (30 attempts, 2-second intervals).
13. Polls `http://localhost:3100/` until the web server responds.
14. Reloads the Nginx container with `docker exec gateway nginx -s reload`.

### Automatic rollback

If any step after `git pull` fails and the deploy does **not** include database migrations,
the script automatically rolls back to the previous commit, rebuilds, and restarts containers.
If the deploy includes migrations, automatic rollback is disabled and manual intervention is
required -- the script prints instructions for checking migration state and restoring from
backup.

## Updating to a new version

After a push to `main`, the GitHub Actions deploy workflow handles this automatically. To
update manually:

```bash
cd /opt/sentinel
bash scripts/deploy.sh
```

The script runs `git pull origin main` as its first step, then rebuilds images and restarts
containers. Containers are restarted with `--remove-orphans` to clean up any services removed
from the compose file.

## Monitoring

### Live container resource usage

```bash
docker stats
```

Displays CPU, memory, network I/O, and block I/O for all running containers in real time.

### Stream logs from all services

```bash
docker compose -f /opt/sentinel/docker-compose.prod.yml logs --tail=100 -f
```

### Stream logs from a single service

```bash
docker compose -f /opt/sentinel/docker-compose.prod.yml logs --tail=100 -f api
docker compose -f /opt/sentinel/docker-compose.prod.yml logs --tail=100 -f worker
docker compose -f /opt/sentinel/docker-compose.prod.yml logs --tail=100 -f web
```

### Check container health status

```bash
docker compose -f /opt/sentinel/docker-compose.prod.yml ps
```

Services show `(healthy)`, `(unhealthy)`, or `(starting)` based on their health check results.

### Prometheus metrics

The API exposes a `/metrics` endpoint in Prometheus exposition format. Protect it with the
`METRICS_TOKEN` environment variable in production. Scrape it from your monitoring stack:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: sentinel-api
    scheme: http
    bearer_token: "<METRICS_TOKEN value>"
    static_configs:
      - targets: ["sentinel-api:4100"]
```

### Sentry

Configure `SENTRY_DSN` and `SENTRY_ENVIRONMENT` for error tracking and performance monitoring
across all three services. See
[Environment Variables](../configuration/environment-variables.md#observability) for details.

## Log management

### Docker log rotation

Production services use the `json-file` log driver with automatic rotation configured in the
compose file:

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Each container retains up to 30 MB of logs (3 files of 10 MB). Docker handles rotation
automatically.

### Log format

The API and worker emit structured JSON logs via Pino. The `LOG_LEVEL` environment variable
controls the minimum level (default: `info`). In production, use `info` or `warn` to avoid
excessive log volume.

### Viewing logs on disk

Docker stores container logs at `/var/lib/docker/containers/<container-id>/<container-id>-json.log`.
Use `docker compose logs` to view them without navigating the filesystem.

## Database backups

### Automated backups with backup-db.sh

The `scripts/backup-db.sh` script provides a production-ready backup solution:

```bash
# Manual backup
bash scripts/backup-db.sh

# Automated daily backup (add to crontab)
0 2 * * * cd /opt/sentinel && bash scripts/backup-db.sh >> /var/log/sentinel-backup.log 2>&1
```

Features:

- Dumps via `DATABASE_URL` (preferred) or `docker exec` fallback.
- Compresses with gzip.
- Optional S3 upload (`BACKUP_S3_BUCKET` env var).
- Local retention: 7 days (configurable via `LOCAL_RETENTION`).
- S3 retention: 30 days (configurable via `S3_RETENTION`).

### Restoring from backup

```bash
bash scripts/restore-db.sh /backups/postgres/sentinel-backup-2026-03-28-020000.sql.gz
```

The script prompts for confirmation before dropping and recreating the database. It supports
both `DATABASE_URL` (direct connection) and `docker exec` (container fallback) modes.

### Pre-migration backups

The deploy script automatically takes a database backup before applying migrations that
include changes to `packages/db/migrations/`. If the migration fails, the backup can be
restored manually:

```bash
bash scripts/restore-db.sh /backups/postgres/<latest-backup>.sql.gz
```
