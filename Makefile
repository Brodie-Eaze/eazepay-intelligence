.DEFAULT_GOAL := help
.PHONY: help install setup dev build typecheck lint test test-watch \
        db-migrate db-seed db-reset db-studio \
        worker-webhook worker-aggregation worker-revenue \
        services-up services-down services-logs \
        clean fresh

# ─── Help ──────────────────────────────────────────────────────────────────
help:  ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nEazePay Intelligence — common tasks\n\n"} /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } /^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ Setup

install:  ## Install dependencies
	pnpm install

setup: install services-up db-migrate db-seed  ## One-shot: install + bring up services + migrate + seed
	@echo ""
	@echo "✓ Setup complete. Run 'make dev' to start the platform."

##@ Dev

dev:  ## Start API + web in parallel
	pnpm dev

build:  ## Production build (both apps)
	pnpm build

typecheck:  ## TypeScript across the monorepo
	pnpm typecheck

lint:  ## ESLint across the monorepo
	pnpm lint

test:  ## Vitest unit suite (fast)
	pnpm test

test-watch:  ## Vitest watch mode
	pnpm --filter api exec vitest

##@ Database

db-migrate:  ## Apply migrations
	pnpm --filter api exec prisma migrate dev --skip-seed

db-seed:  ## Re-seed (idempotent)
	pnpm --filter api exec tsx prisma/seed.ts

db-reset:  ## Drop + recreate + migrate + seed (destroys local data)
	@psql -d postgres -c "DROP DATABASE IF EXISTS eazepay_intel;" -c "CREATE DATABASE eazepay_intel;" >/dev/null
	@$(MAKE) db-migrate db-seed

db-studio:  ## Prisma Studio
	pnpm --filter api exec prisma studio

##@ Workers

worker-webhook:  ## Run the webhook processing worker
	pnpm --filter api worker:webhook

worker-aggregation:  ## Run the aggregation rollup worker
	pnpm --filter api worker:aggregation

worker-revenue:  ## Run the revenue scheduler (one-shot)
	pnpm --filter api worker:revenue

##@ Local services

services-up:  ## Start Postgres + Redis (docker-compose; falls back to brew on macOS if docker not present)
	@if command -v docker >/dev/null 2>&1; then \
		docker compose up -d; \
	else \
		echo "docker not found — assuming brew services postgresql@16 + redis are running"; \
	fi

services-down:  ## Stop Postgres + Redis (docker-compose only)
	@if command -v docker >/dev/null 2>&1; then docker compose down; fi

services-logs:  ## Tail Postgres + Redis logs (docker-compose only)
	@if command -v docker >/dev/null 2>&1; then docker compose logs -f; fi

##@ Maintenance

clean:  ## Remove node_modules + build artefacts
	rm -rf node_modules apps/*/node_modules apps/*/dist apps/web/.next packages/*/node_modules .turbo

fresh: clean install  ## Clean + reinstall
