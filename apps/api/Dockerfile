# syntax=docker/dockerfile:1.7

# ───────────────────────────────────────────────────────────────────────────
# EazePay Intelligence — API service (Fastify + Prisma + BullMQ)
#
# Multi-stage build for a pnpm workspace.
#   1. deps    — installs the full workspace deps (cached layer)
#   2. build   — generates Prisma client + compiles TypeScript → dist/
#   3. runner  — minimal runtime image: node:20-alpine + dist/ + node_modules
#
# On Railway:
#   - Builder context is the repo root (the Dockerfile is referenced via
#     dockerfilePath in railway.json).
#   - `pnpm --filter api exec prisma migrate deploy` runs as a release step
#     (see apps/api/railway.json `preDeployCommand`) so migrations land
#     BEFORE the new container starts taking traffic.
# ───────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.12.0

# ── deps ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy workspace manifests + the shared tsconfig first for cache hits on
# unchanged deps. tsconfig.base.json is referenced from each app's
# tsconfig via `extends: ../../tsconfig.base.json` so it MUST live at the
# build's /repo root before any `tsc` runs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm fetch --frozen-lockfile
RUN pnpm install --frozen-lockfile --offline

# ── build ─────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY apps/api ./apps/api
RUN pnpm --filter api db:generate
RUN pnpm --filter api build

# ── runner ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner
ARG PNPM_VERSION=9.12.0
RUN apk add --no-cache libc6-compat openssl tini
WORKDIR /repo
ENV NODE_ENV=production

# pnpm available in the runner so the Railway preDeployCommand works
# against the baked node_modules.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/package.json ./apps/api/
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules

USER node
EXPOSE 3010

ENTRYPOINT ["/sbin/tini", "--"]
# tsc preserves the source tree's directory structure under outDir because
# the include list spans src/, tests/, and prisma/seed.ts — the common
# parent is the package root. Entry lives at dist/src/index.js, not
# dist/index.js. Same path used by package.json `start` in this commit.
CMD ["node", "apps/api/dist/src/index.js"]
