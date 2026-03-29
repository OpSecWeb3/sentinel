# ── Stage 1: Install ALL workspace dependencies ──────────────────────
FROM node:22-alpine AS deps

RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config and lockfile (layer-cache friendly)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy only package.json files for all workspace packages
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/notifications/package.json ./packages/notifications/
COPY modules/github/package.json ./modules/github/
COPY modules/chain/package.json ./modules/chain/
COPY modules/infra/package.json ./modules/infra/
COPY modules/registry/package.json ./modules/registry/
COPY modules/aws/package.json ./modules/aws/

# Install all dependencies (including devDependencies for the build)
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build the Next.js app ────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/ ./

# Copy web app source
COPY apps/web/ ./apps/web/

# NEXT_PUBLIC_* vars are inlined into the JS bundle at build time.
# They must be passed as build args — runtime env vars are too late.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Build the Next.js app (output: "standalone" in next.config.ts)
RUN pnpm --filter @sentinel/web build

# ── Stage 3: Production runtime ──────────────────────────────────────
FROM node:22-alpine AS runner

RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3100

# Create non-root user
RUN addgroup --system --gid 1001 sentinel && \
    adduser --system --uid 1001 sentinel

# Copy standalone server (bundles all dependencies)
COPY --from=builder --chown=sentinel:sentinel /app/apps/web/.next/standalone ./

# Copy static assets
COPY --from=builder --chown=sentinel:sentinel /app/apps/web/.next/static ./apps/web/.next/static

# Copy public directory if it exists (COPY won't fail if missing when using glob)
COPY --from=builder --chown=sentinel:sentinel /app/apps/web/public ./apps/web/public

USER sentinel

EXPOSE 3100

CMD ["dumb-init", "node", "apps/web/server.js"]
