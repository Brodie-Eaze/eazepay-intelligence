/**
 * Cross-resource search.
 *
 * One endpoint, queries across customers (by hash prefix), partners (by name /
 * external_id), applications (by external id), and lenders (by name). Each
 * result has a `kind` and a click-through URL hint for the frontend.
 *
 * Saved views: bookmark a complex filter set on any resource type.
 */
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { getPrismaReader, getPrismaWriter } from '../../config/database.js';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { csrfGuard } from '../../shared/middleware/csrf.middleware.js';
import { getBootstrapOrgId } from '../../shared/tenant/bootstrap-org.js';
import { errors } from '../../shared/errors/app-error.js';

interface Hit {
  kind: 'customer' | 'partner' | 'application' | 'lender';
  id: string;
  label: string;
  sub?: string | null;
  href: string;
}

const SearchQuery = z.object({
  q: z.string().min(2).max(120),
  kinds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  // Mixed-mode: search is read-only and routes to the replica; saved-views
  // CRUD writes to the primary. Per-route below decides which client.
  const prisma = getPrismaReader();
  const prismaW = getPrismaWriter();

  app.get('/search', { preHandler: requireAuth }, async (req) => {
    const { q, kinds: kindsCsv, limit } = SearchQuery.parse(req.query);
    const kinds = kindsCsv
      ?.split(',')
      .map((k) => k.trim())
      .filter(Boolean) ?? ['customer', 'partner', 'application', 'lender'];
    const out: Hit[] = [];

    if (kinds.includes('partner')) {
      const partners = await prisma.partner.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { externalId: { contains: q, mode: 'insensitive' } },
            { industry: { contains: q, mode: 'insensitive' } },
          ],
        },
        take: Math.ceil(limit / 2),
      });
      for (const p of partners) {
        out.push({
          kind: 'partner',
          id: p.id,
          label: p.name,
          sub: `${p.industry} · ${p.externalId}`,
          href: `/partners/${p.id}`,
        });
      }
    }

    if (kinds.includes('application')) {
      const apps = await prisma.application.findMany({
        where: { externalApplicationId: { contains: q, mode: 'insensitive' } },
        take: Math.ceil(limit / 2),
        orderBy: { createdAt: 'desc' },
      });
      for (const a of apps) {
        out.push({
          kind: 'application',
          id: a.id,
          label: a.externalApplicationId,
          sub: a.status,
          href: `/applications/${a.id}`,
        });
      }
    }

    if (kinds.includes('lender')) {
      const lenders = await prisma.lenderDecision.findMany({
        where: { lenderName: { contains: q, mode: 'insensitive' } },
        distinct: ['lenderName'],
        select: { lenderName: true, lenderTier: true },
        take: Math.ceil(limit / 4),
      });
      for (const l of lenders) {
        out.push({
          kind: 'lender',
          id: l.lenderName,
          label: l.lenderName,
          sub: l.lenderTier,
          href: `/lenders/${encodeURIComponent(l.lenderName)}`,
        });
      }
    }

    if (kinds.includes('customer') && /^[a-f0-9]{2,64}$/i.test(q)) {
      // Hex prefix — match against email-hash hex prefix
      const allCustomers = await prisma.application.findMany({
        select: { consumerEmailHash: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      });
      const seen = new Set<string>();
      for (const a of allCustomers) {
        const hex = a.consumerEmailHash.toString('hex');
        if (!hex.toLowerCase().startsWith(q.toLowerCase())) continue;
        if (seen.has(hex)) continue;
        seen.add(hex);
        out.push({
          kind: 'customer',
          id: hex,
          label: `Customer ${hex.slice(0, 8)}`,
          sub: `last seen ${a.createdAt.toISOString().slice(0, 10)}`,
          href: `/customers/${hex}`,
        });
        if (out.filter((h) => h.kind === 'customer').length >= Math.ceil(limit / 2)) break;
      }
    }

    return { query: q, hits: out.slice(0, limit) };
  });

  // ─── Saved views ─────────────────────────────────────────────────────────

  const SavedViewSchema = z.object({
    name: z.string().min(1).max(80),
    resourceType: z.string().min(1).max(40),
    query: z.record(z.unknown()),
    isShared: z.boolean().default(false),
  });

  app.get('/saved-views', { preHandler: requireAuth }, async (req) => {
    const auth = req.auth!;
    const q = z.object({ resourceType: z.string().optional() }).parse(req.query);
    const rows = await prisma.savedView.findMany({
      where: {
        OR: [{ userId: auth.userId }, { isShared: true }],
        ...(q.resourceType ? { resourceType: q.resourceType } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
    return rows.map((v) => ({
      id: v.id,
      name: v.name,
      resourceType: v.resourceType,
      query: v.query,
      isShared: v.isShared,
      authorEmail: v.user.email,
      mine: v.userId === auth.userId,
      updatedAt: v.updatedAt.toISOString(),
    }));
  });

  app.post('/saved-views', { preHandler: [requireAuth, csrfGuard] }, async (req, reply) => {
    const auth = req.auth!;
    const input = SavedViewSchema.parse(req.body);
    // Phase 1 retrofit: saved views are org-scoped so a multi-org user's
    // shared views don't bleed across their tenants.
    const orgId = auth.orgId ?? (await getBootstrapOrgId(prismaW));
    const created = await prismaW.savedView.create({
      data: {
        id: uuidv7(),
        orgId,
        userId: auth.userId,
        name: input.name,
        resourceType: input.resourceType,
        query: input.query as object,
        isShared: input.isShared,
      },
    });
    reply.status(201);
    return { id: created.id };
  });

  app.delete('/saved-views/:id', { preHandler: [requireAuth, csrfGuard] }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Use writer for the read-then-delete: avoids the rare race where the
    // replica hasn't caught up to a recent create from this same user.
    const row = await prismaW.savedView.findUnique({ where: { id } });
    if (!row || row.userId !== auth.userId) throw errors.notFound('SavedView', id);
    await prismaW.savedView.delete({ where: { id } });
    reply.status(204).send();
  });
}
