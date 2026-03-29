# Installation

This guide walks you through installing Sentinel on your own infrastructure using Docker Compose. By the end, you will have a running Sentinel instance that you can log into and configure.

## Prerequisites

Before you begin, make sure the following tools are installed and running on the machine where you plan to deploy Sentinel:

- **Docker** 24.0 or later
- **Docker Compose** v2 (the `docker compose` plugin, not the legacy `docker-compose` command)
- **Git** 2.x or later
- An outbound internet connection to pull Docker images from Docker Hub

Sentinel also requires the following external services. You can run them on the same host or connect to managed instances:

- **PostgreSQL** 16 or later
- **Redis** 7 or later

To verify your Docker Compose version, run:

```
docker compose version
```

The output should show `Docker Compose version v2.x.x` or later. If you see `docker-compose version 1.x.x`, you are using the legacy standalone binary and need to upgrade.

### Resource Requirements

Each Sentinel service is constrained to specific resource limits in the production Docker Compose configuration:

| Service | Memory Limit | CPU Limit | Default Replicas |
|---|---|---|---|
| API | 384 MB | 1.0 | 1 |
| Worker | 384 MB | 1.0 | 2 |
| Web UI | 384 MB | 0.5 | 1 |

For a minimal deployment, a host with 2 GB of available RAM and 2 CPU cores is sufficient for the Sentinel services alone. Budget additional resources for PostgreSQL (at least 1 GB RAM) and Redis (at least 512 MB RAM) if you run them on the same host.

## Step 1: Clone the Repository

Clone the Sentinel repository to your server:

```
git clone https://github.com/your-org/sentinel.git
cd sentinel
```

## Step 2: Configure the Environment

Sentinel reads its configuration from a `.env` file in the project root. Copy the provided example file to create your own:

```
cp .env.example .env
```

Open `.env` in your editor and set the following required variables before starting the services:

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | Full PostgreSQL connection string. Use `?sslmode=require` in production. | `postgresql://sentinel:yourpassword@postgres:5432/sentinel?sslmode=require` |
| `REDIS_URL` | Redis connection string including password. Use `rediss://` (TLS) in production. | `rediss://:yourpassword@redis:6379` |
| `SESSION_SECRET` | Secret used to sign session cookies. Must be at least 32 characters. | `change-me-to-a-long-random-string` |
| `ENCRYPTION_KEY` | 64-character hex string (32 bytes) used for AES-256-GCM encryption of secrets at rest. | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins (your web UI origin). | `https://sentinel.yourcompany.com` |
| `API_BASE_URL` | The public URL of the API service. Used for OAuth redirect URIs. | `https://api.sentinel.yourcompany.com` |
| `NEXT_PUBLIC_API_URL` | The API URL that the browser-side web app calls. Must be reachable from the user's browser. | `https://api.sentinel.yourcompany.com` |

The following variables are optional but recommended for production:

| Variable | Description |
|---|---|
| `SMTP_URL` | SMTP connection string for email notifications (e.g., `smtp://user:pass@smtp.example.com:587`). |
| `SMTP_FROM` | The sender address for email notifications. |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Required only if you want to use Slack OAuth to connect channels. |

> **Important:** Do not commit your `.env` file to version control. It contains secrets.

> **Security note:** In production, Redis must be password-protected and PostgreSQL connections should use TLS (`?sslmode=require` in the connection string). The production Docker Compose configuration expects both services to be available on an external `shared-infra` network.

## Step 3: Start the Services

### Option A: Production Deployment

For production, use the production Compose file. This configuration expects PostgreSQL and Redis to already be running on an external Docker network named `shared-infra`:

```
docker compose -f docker-compose.prod.yml up -d
```

Docker Compose builds and starts the following services:

| Service | Description | Default Port |
|---|---|---|
| **api** | The Sentinel REST API | 4100 |
| **worker** | Background worker that processes events and dispatches alerts (two replicas by default) | -- |
| **web** | The Next.js web UI | 3100 |

PostgreSQL and Redis are not defined in the production Compose file. They are expected to already be running on the `shared-infra` network.

### Option B: Self-Contained Evaluation

If you want a self-contained setup for evaluation or testing, use the development Compose file which includes PostgreSQL and Redis as bundled services:

```
docker compose up -d
```

This starts PostgreSQL (port 5432) and Redis (port 6379) alongside the Sentinel services. The API runs on port 4000 in this configuration.

### Monitoring Startup

Wait for all services to report as healthy. You can monitor startup progress with:

```
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f
```

Each service includes a health check. When you see the `api` and `web` services with a status of `healthy`, the platform is ready.

## Step 4: Run Database Migrations

After the services start for the first time, apply the database schema:

```
docker compose -f docker-compose.prod.yml exec api node -e "require('./dist/db/migrate.js')"
```

If you are using the self-contained evaluation setup, replace `docker-compose.prod.yml` with `docker-compose.yml`. Migrations are idempotent -- running them more than once is safe.

## Step 5: Access the Web UI

Open your browser and navigate to:

```
http://localhost:3100
```

The API is available at:

```
http://localhost:4100
```

If you deployed to a remote server, replace `localhost` with your server's hostname or IP address. Confirm that your firewall or reverse proxy allows inbound traffic on ports 3100 and 4100. In production, you typically place an nginx reverse proxy in front of both services and expose them on standard HTTPS ports.

## Step 6: Create Your Account and Organization

The first time you open the web UI, Sentinel redirects you to the login page. Since there are no accounts yet, click the **register** link to create one.

On the registration page:

1. Make sure the **[new-org]** mode is selected (this is the default for the first user).
2. Enter a **username**.
3. Enter your **email address**.
4. Enter a **password** (minimum 8 characters).
5. Enter a name for your **organization** (for example, `Acme Security`).
6. Click **Register**.

After registration, Sentinel displays your **invite secret** -- a one-time string that other team members use to join your organization. Copy it and store it securely. This secret cannot be displayed again after you leave this page. You can regenerate it from **Settings** at any time.

Click **continue to dashboard** to proceed. You are assigned the **admin** role.

## Verifying the Installation

After logging in, the **Dashboard** shows summary statistics across all modules. On a fresh installation with no integrations configured yet, all counters show zero -- this is expected.

To confirm the API is healthy independently, open:

```
http://localhost:4100/health
```

You should receive a `200 OK` response.

## Common Issues

**Port conflicts**

If port 4100 or 3100 is already in use on your machine, the services fail to start. Identify the conflicting process:

```
lsof -i :4100
lsof -i :3100
```

Either stop the conflicting process or change the port mappings in your Docker Compose file before running `docker compose up -d`.

**Docker is not running**

If `docker compose up -d` returns an error such as `Cannot connect to the Docker daemon`, start the Docker daemon:

- On macOS: open the Docker Desktop application.
- On Linux: run `sudo systemctl start docker`.

**Database fails to connect**

If the `api` service exits with a database connection error, verify that:

1. PostgreSQL is running and reachable from within the Docker network.
2. The `DATABASE_URL` in your `.env` file has the correct hostname, port, username, and password.
3. If using the `shared-infra` network, confirm the network exists: `docker network ls | grep shared-infra`.

**Cannot reach the web UI from a remote machine**

Ensure the web UI's `NEXT_PUBLIC_API_URL` environment variable is set to the externally reachable address of the API, not `localhost`. The browser makes direct calls to the API, so `localhost` does not work when the browser is on a different machine from the server.

**Health check fails repeatedly**

The API health check has a 10-second start period, and the web UI has a 15-second start period. If services are slow to start (for example, on a resource-constrained host), check the container logs for specific error messages:

```
docker compose -f docker-compose.prod.yml logs api
docker compose -f docker-compose.prod.yml logs web
```

**External Docker networks do not exist**

The production Compose file references two external networks: `gateway` and `shared-infra`. Create them before starting the services:

```
docker network create gateway
docker network create shared-infra
```
