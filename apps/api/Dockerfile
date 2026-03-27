# ── Stage 1: Install ALL workspace dependencies ──────────────────────
FROM node:22-alpine AS deps

RUN apk add --no-cache libc6-compat python3 make g++
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
COPY modules/release-chain/package.json ./modules/release-chain/

# Install all dependencies (including devDependencies for the build)
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build the API app ───────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/ ./

# Copy workspace config
COPY tsconfig.base.json ./

# Copy all workspace package source (needed for TypeScript resolution)
COPY packages/shared/ ./packages/shared/
COPY packages/db/ ./packages/db/
COPY packages/notifications/ ./packages/notifications/
COPY modules/github/ ./modules/github/
COPY modules/chain/ ./modules/chain/
COPY modules/infra/ ./modules/infra/
COPY modules/release-chain/ ./modules/release-chain/

# Copy API source
COPY apps/api/ ./apps/api/

# Build only the API app
RUN pnpm --filter @sentinel/api build

# ── Stage 3: Production dependencies only ────────────────────────────
FROM node:22-alpine AS prod-deps

RUN apk add --no-cache libc6-compat python3 make g++
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/notifications/package.json ./packages/notifications/
COPY modules/github/package.json ./modules/github/
COPY modules/chain/package.json ./modules/chain/
COPY modules/infra/package.json ./modules/infra/
COPY modules/release-chain/package.json ./modules/release-chain/

RUN pnpm install --frozen-lockfile --prod

# ── Stage 4: Production runtime ──────────────────────────────────────
FROM node:22-alpine AS runner

RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 sentinel && \
    adduser --system --uid 1001 sentinel

# Copy production node_modules (includes pnpm virtual store + symlinks)
COPY --from=prod-deps --chown=sentinel:sentinel /app/ ./

# Copy root package.json and workspace config (needed for pnpm resolution)
COPY --from=builder --chown=sentinel:sentinel /app/package.json ./package.json
COPY --from=builder --chown=sentinel:sentinel /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=sentinel:sentinel /app/tsconfig.base.json ./tsconfig.base.json

# Copy built API output
COPY --from=builder --chown=sentinel:sentinel /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=sentinel:sentinel /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=sentinel:sentinel /app/apps/api/tsconfig.json ./apps/api/tsconfig.json

# Copy workspace package sources (they export raw TypeScript, no build step)
COPY --from=builder --chown=sentinel:sentinel /app/packages/shared/ ./packages/shared/
COPY --from=builder --chown=sentinel:sentinel /app/packages/db/ ./packages/db/
COPY --from=builder --chown=sentinel:sentinel /app/packages/notifications/ ./packages/notifications/
COPY --from=builder --chown=sentinel:sentinel /app/modules/github/ ./modules/github/
COPY --from=builder --chown=sentinel:sentinel /app/modules/chain/ ./modules/chain/
COPY --from=builder --chown=sentinel:sentinel /app/modules/infra/ ./modules/infra/
COPY --from=builder --chown=sentinel:sentinel /app/modules/release-chain/ ./modules/release-chain/

# Install tsx globally for running TS workspace packages at runtime
RUN npm install -g tsx

USER sentinel

EXPOSE 4000

CMD ["dumb-init", "tsx", "apps/api/dist/index.js"]
