# One-shot migrate + seed image for production deploys.
# Keep the package.json COPY list in sync with apps/api/Dockerfile (deps stage).

FROM node:22-alpine AS deps

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
COPY modules/registry/package.json ./modules/registry/
COPY modules/aws/package.json ./modules/aws/

RUN pnpm install --frozen-lockfile

FROM deps AS runner

WORKDIR /app

COPY packages/db/ ./packages/db/

ENV NODE_ENV=production

CMD ["sh", "-c", "pnpm --filter @sentinel/db migrate && pnpm --filter @sentinel/db seed"]
