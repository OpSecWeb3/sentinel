#!/bin/bash
set -e

echo "=== Sentinel Dev Setup ==="
echo ""

# 1. Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "Docker is required. Install it first."; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required. Run: npm install -g pnpm"; exit 1; }

# 2. Create .env from example if it doesn't exist
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env

  # Generate real secrets
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
  ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

  # Replace placeholders
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|change-me-to-a-long-random-string-at-least-32-chars|${SESSION_SECRET}|" .env
    sed -i '' "s|0000000000000000000000000000000000000000000000000000000000000000|${ENCRYPTION_KEY}|" .env
  else
    sed -i "s|change-me-to-a-long-random-string-at-least-32-chars|${SESSION_SECRET}|" .env
    sed -i "s|0000000000000000000000000000000000000000000000000000000000000000|${ENCRYPTION_KEY}|" .env
  fi

  echo "Generated SESSION_SECRET and ENCRYPTION_KEY in .env"
else
  echo ".env already exists, skipping"
fi

# 3. Start infra
echo ""
echo "Starting Postgres + Redis..."
docker compose -f docker-compose.dev.yml up -d
echo "Waiting for services to be healthy..."
sleep 3

# 4. Install dependencies
echo ""
echo "Installing dependencies..."
pnpm install

# 5. Generate and run migrations
echo ""
echo "Generating database migrations..."
pnpm db:generate

echo "Running migrations..."
pnpm db:migrate

echo ""
echo "=== Setup complete! ==="
echo ""
echo "── Option A: Run apps on host (hot reload) ──"
echo "  pnpm dev:api        → http://localhost:4000"
echo "  pnpm dev:worker"
echo "  pnpm dev:web        → http://localhost:3000"
echo ""
echo "── Option B: Run everything in Docker ──"
echo "  docker compose -f docker-compose.dev.yml --profile full up --build"
echo "  API → http://localhost:4000  |  Web → http://localhost:3000"
echo ""
echo "DB Studio:  pnpm db:studio"
echo ""
echo "First steps:"
echo "  1. Register: POST http://localhost:4000/auth/register"
echo '     Body: {"username":"admin","email":"admin@example.com","password":"changeme123","orgName":"My Org"}'
echo "  2. Login:    POST http://localhost:4000/auth/login"
echo '     Body: {"username":"admin","password":"changeme123"}'
echo ""
