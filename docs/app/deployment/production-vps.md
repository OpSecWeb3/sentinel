# Production VPS Deployment

Sentinel runs in production on a Hetzner VPS. This document covers server provisioning, initial setup, and ongoing operations.

## Server requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 40 GB SSD | 80 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| Open ports | 22, 80, 443 | 22, 80, 443 |

The combined memory limits for the application containers defined in `docker-compose.prod.yml` are: API 384 MB, two workers at 384 MB each, and web 384 MB, totaling 1,536 MB. PostgreSQL and Redis run on the shared-infra network and are not defined in the Sentinel compose file; their resource consumption depends on their own configuration. A 4 GB server provides sufficient headroom for the application containers, the OS, Nginx, and the shared database services.

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

The deploy script runs Drizzle Kit migrations directly on the host (outside Docker) using the `npx drizzle-kit` command. Node.js and pnpm must be installed on the server:

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

Create the two external Docker networks that `docker-compose.prod.yml` expects. These are created once and persist across deploys:

```bash
docker network create gateway
docker network create shared-infra
```

The deploy script also creates these networks idempotently on every run (`|| true` suppresses the "already exists" error), so this step is only required for the initial server setup.

| Network | Attached services | Description |
|---|---|---|
| `gateway` | `api`, `web`, Nginx container | Routes ingress from the Nginx reverse proxy. |
| `shared-infra` | `api`, `worker` | Internal network; not reachable from Nginx. |

## Deploy directory

The application lives at `/opt/sentinel`:

```bash
mkdir -p /opt/sentinel
chown sentinel:sentinel /opt/sentinel
```

All subsequent operations run from this directory.

## Nginx reverse proxy

Nginx proxies public HTTPS traffic to the application containers. Sentinel recommends running Nginx as a Docker container attached to the `gateway` network, named `gateway`, so that `docker exec gateway nginx -s reload` (called by the deploy script) works correctly.

### Example Nginx configuration

Create `/etc/nginx/sites-available/sentinel` (or the equivalent path for a containerized Nginx):

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Redirect all HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Web frontend
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

    # API
    location /api {
        proxy_pass         http://sentinel-api:4100;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # Websocket / health endpoint
    location /health {
        proxy_pass http://sentinel-api:4100;
    }
}
```

`sentinel-web` and `sentinel-api` resolve inside the `gateway` Docker network by their container names.

### SSL with Let's Encrypt

Use Certbot to obtain and auto-renew a TLS certificate:

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

Certbot installs a systemd timer that renews certificates automatically before expiry.

## First deploy

### 1. Clone the repository

Switch to the `sentinel` user and clone the repository:

```bash
su - sentinel
git clone https://github.com/your-org/sentinel.git /opt/sentinel
cd /opt/sentinel
```

### 2. Create the .env file

The `.env` file is not committed to git. In production, the CI/CD pipeline copies it to the server on every deploy. For the initial deploy, create it manually from the SSM parameters or from your secure password store:

```bash
cp .env.example .env
# Edit .env and fill in all production values
nano /opt/sentinel/.env
```

Key variables that must be set for production:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string; append `?sslmode=require` if using TLS. |
| `REDIS_URL` | Redis connection string; use `rediss://` for TLS-encrypted connections. |
| `SESSION_SECRET` | Random string, minimum 32 characters. |
| `ENCRYPTION_KEY` | 64 hex characters (32 bytes). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALLOWED_ORIGINS` | Comma-separated list of your public domain(s), e.g. `https://your-domain.com`. |
| `NEXT_PUBLIC_API_URL` | Public URL of the API, e.g. `https://your-domain.com`. |
| `NODE_ENV` | Must be `production`. |

### 3. Run the deploy script

```bash
cd /opt/sentinel
bash scripts/deploy.sh
```

The script executes the following steps in order:

1. Pulls the latest code from `origin main`.
2. Creates the `gateway` and `shared-infra` Docker networks if they do not exist.
3. Loads the `.env` file and runs Drizzle Kit migrations against the production database.
4. Runs the database seed script (`npx tsx packages/db/src/seed.ts`).
5. Builds Docker images and starts all containers with `docker compose -f docker-compose.prod.yml up -d --remove-orphans`.
6. Polls `http://localhost:4100/health` until the API responds or 30 attempts are exhausted (60 seconds total).
7. Polls `http://localhost:3100/` until the web server responds or 30 attempts are exhausted.
8. Reloads the Nginx container configuration with `docker exec gateway nginx -s reload`.

## Updating to a new version

After a push to `main`, the GitHub Actions deploy workflow handles this automatically. To update manually:

```bash
cd /opt/sentinel
bash scripts/deploy.sh
```

The script runs `git pull origin main` as its first step, then rebuilds images and restarts containers. Containers are restarted with `--remove-orphans` to clean up any services removed from the compose file.

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

## Database backups

### Manual backup

```bash
docker exec sentinel-postgres pg_dump -U sentinel sentinel > /opt/backups/sentinel-$(date +%Y%m%d-%H%M%S).sql
```

Compress large dumps:

```bash
docker exec sentinel-postgres pg_dump -U sentinel sentinel | gzip > /opt/backups/sentinel-$(date +%Y%m%d-%H%M%S).sql.gz
```

### Recommended backup schedule

Schedule automated backups with cron. As root or the `sentinel` user:

```bash
crontab -e
```

Add the following entry to run a daily backup at 02:00 UTC and retain 14 days of backups:

```cron
0 2 * * * docker exec sentinel-postgres pg_dump -U sentinel sentinel | gzip > /opt/backups/sentinel-$(date +\%Y\%m\%d).sql.gz && find /opt/backups -name "sentinel-*.sql.gz" -mtime +14 -delete
```

Create the backup directory first:

```bash
mkdir -p /opt/backups
```

### Restore from backup

```bash
gunzip -c /opt/backups/sentinel-20260328.sql.gz | docker exec -i sentinel-postgres psql -U sentinel sentinel
```
