# syntax=docker/dockerfile:1.7

# ───────────────────────────────────────────────────────────────────────────
# EazePay Intelligence — Web (Next.js 14, App Router)
#
# Multi-stage build for a pnpm workspace. Next is configured in standalone
# output mode (see next.config.js `output: 'standalone'`) so the runner
# image only carries the .next/standalone server + .next/static — no
# devDependencies, no source.
# ───────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20.10.0
ARG PNPM_VERSION=9.12.0

# ── deps ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm fetch --frozen-lockfile
RUN pnpm install --frozen-lockfile --offline

# ── build ─────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY apps/web ./apps/web
# Next pulls these at build time and bakes them into the bundle — every
# NEXT_PUBLIC_* must be set as a build-arg on Railway, NOT a runtime env var.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_ENV=production
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
ENV NEXT_PUBLIC_ENV=${NEXT_PUBLIC_ENV}
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build

# ── runner ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runner
RUN apk add --no-cache libc6-compat tini
WORKDIR /repo
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3011
ENV HOSTNAME=0.0.0.0

# Standalone output bundles the minimal server.js + the trace-determined
# node_modules into .next/standalone. .next/static must be copied alongside
# it because the standalone server expects it at .next/static.
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3011

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
