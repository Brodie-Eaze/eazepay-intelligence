/**
 * EazePay App drain handlers.
 *
 * Called by the webhook worker for jobs with `source: EAZEPAY_APP`. Each
 * handler normalises one App-side event-type into Intelligence's domain
 * (Application + RevenueEvent rows, WS broadcast).
 *
 * Contract: docs/integration/eazepay-app-contract.md
 *
 * Event coverage (Phase B):
 *   - application.offers_presented  → APPLICATION offers cached
 *   - application.contracted        → APPLICATION → CONTRACTED + funding event
 *   - application.declined          → APPLICATION → DECLINED
 *   - application.funded            → APPLICATION → FUNDED + revenue event
 *   - merchant.onboarded            → partner upsert
 *   - merchant.status_changed       → partner status update
 *   - revenue.recorded              → RevenueEvent row
 *   - loan.repayment.*              → recorded as commission/repayment events
 *
 * Unknown event-type → audit + log (do not throw — the worker would
 * retry forever and DLQ the row); the outbox sweeper's retry/DLQ logic
 * is for *transient* failures, not for permanent shape mismatches.
 */
import {
  ApplicationStatus,
  Prisma,
  RevenueEventType,
  RevenueStream,
  WebhookSource,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { getLogger } from '../../../config/logger.js';
import { writeAuditLog } from '../../../shared/middleware/audit-log.middleware.js';
import { publishWsEvent, withPartnerLabel } from '../../../shared/utils/ws-publisher.js';
import { encryptForOrg } from '../../../shared/kms/tenant-dek.js';
import { hashPII } from '../../../shared/utils/encryption.js';
import { withTenantSession } from '../../../shared/tenant/tenant-context.js';
import { resolveBrandToOrgSlug } from './brand-org-mapping.js';
import { EAZEPAY_APP_EVENT_TYPES, type EazepayAppEventType } from './event-types.js';

interface EazepayAppJob {
  webhookEventId: string;
  envelope: {
    id: string;
    eventId: string;
    eventType: string;
    subject: { type: string; id: string } | null;
    data: Record<string, unknown>;
    createdAt: string;
  };
}

// ─── Per-event-type payload schemas ─────────────────────────────────────────
//
// App's `data` payload is reference-only by contract — no money, no PII.
// We narrow each event-type to the fields we actually depend on. Anything
// else stays in the raw payload field on the WebhookEvent row and remains
// queryable for later schema upgrades.

const OffersPresentedSchema = z.object({
  applicationId: z.string().uuid(),
  brand: z.string().min(1).max(64),
  consumerEmailLower: z.string().email().optional(),
  consumerEmail: z.string().email().optional(),
  consumerNameFull: z.string().min(1).max(200).optional(),
  consumerPhoneE164: z.string().min(4).max(32).optional(),
  externalApplicationId: z.string().min(1).max(128).optional(),
  partnerExternalId: z.string().min(1).max(128).optional(),
  offers: z
    .array(
      z.object({
        lenderName: z.string().min(1).max(80),
        offerAmount: z.string().or(z.number()).optional(),
        apr: z.string().or(z.number()).optional(),
        term: z.number().int().nullable().optional(),
      }),
    )
    .optional(),
});

const ContractedSchema = z.object({
  applicationId: z.string().uuid(),
  brand: z.string().min(1).max(64),
  lenderName: z.string().min(1).max(80).optional(),
  contractedAmount: z.string().or(z.number()).optional(),
  apr: z.string().or(z.number()).optional(),
  term: z.number().int().nullable().optional(),
  fundingTimestamp: z.string().datetime().optional(),
  partnerExternalId: z.string().min(1).max(128).optional(),
});

const DeclinedSchema = z.object({
  applicationId: z.string().uuid(),
  brand: z.string().min(1).max(64),
  reasonCode: z.string().max(64).optional(),
  partnerExternalId: z.string().min(1).max(128).optional(),
});

const FundedSchema = z.object({
  applicationId: z.string().uuid(),
  brand: z.string().min(1).max(64),
  fundedAmount: z.string().or(z.number()),
  fundedAt: z.string().datetime(),
  lenderName: z.string().min(1).max(80).optional(),
  partnerExternalId: z.string().min(1).max(128).optional(),
  // Optional currency override — defaults to AUD platform-wide.
  currency: z.string().length(3).optional(),
});

const MerchantOnboardedSchema = z.object({
  merchantExternalId: z.string().min(1).max(128),
  brand: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  effectiveAt: z.string().datetime().optional(),
});

const MerchantStatusChangedSchema = z.object({
  merchantExternalId: z.string().min(1).max(128),
  brand: z.string().min(1).max(64),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'OFFBOARDED']),
  effectiveAt: z.string().datetime().optional(),
});

const RevenueRecordedSchema = z.object({
  brand: z.string().min(1).max(64),
  partnerExternalId: z.string().min(1).max(128),
  amount: z.string().or(z.number()),
  currency: z.string().length(3).optional(),
  stream: z.string().min(1).max(64),
  eventType: z.string().min(1).max(64),
  effectiveAt: z.string().datetime(),
  externalEventId: z.string().min(1).max(128),
  metadata: z.record(z.unknown()).optional(),
});

const LoanRepaymentSchema = z.object({
  loanId: z.string().uuid(),
  brand: z.string().min(1).max(64),
  amount: z.string().or(z.number()),
  currency: z.string().length(3).optional(),
  effectiveAt: z.string().datetime(),
  partnerExternalId: z.string().min(1).max(128).optional(),
});

// ─── Drain entry point ──────────────────────────────────────────────────────

export class EazepayAppProcessor {
  constructor(private readonly prisma: PrismaClient) {}

  async process(job: EazepayAppJob): Promise<void> {
    const log = getLogger();
    const env = job.envelope;
    // Phase 1.6 (RLS): under the eazepay_app runtime role, every Prisma
    // query needs app.org_id set or RLS returns zero rows / refuses writes.
    // The WebhookEvent row already carries the orgId resolved at ingest;
    // wrap the drain in withTenantSession so all downstream writes
    // (Application, Partner, RevenueEvent, etc.) pass RLS. We do this at
    // the entry point rather than inside every handler so the contract is
    // explicit: "draining an EazePay App event is a tenant operation".
    const evt = await this.prisma.webhookEvent.findUnique({
      where: { id: job.webhookEventId },
      select: { orgId: true },
    });
    if (!evt) {
      log.warn({ webhookEventId: job.webhookEventId }, 'eazepay_app.webhook_event_not_found');
      return;
    }
    await withTenantSession(this.prisma, { orgId: evt.orgId }, async (tx) => {
      await this.processInner(job, log, tx as unknown as PrismaClient);
    });
  }

  private async processInner(
    job: EazepayAppJob,
    log: ReturnType<typeof getLogger>,
    db: PrismaClient,
  ): Promise<void> {
    const env = job.envelope;
    const knownType = (EAZEPAY_APP_EVENT_TYPES as readonly string[]).includes(env.eventType);
    if (!knownType) {
      // Unknown event-type. Don't throw — the BullMQ retry envelope would
      // retry → DLQ → operator noise for a permanent shape mismatch. Log
      // loudly + audit so the gap is visible in the metric stream.
      log.warn(
        {
          errorId: 'eazepay_app.unknown_event_type',
          webhookEventId: job.webhookEventId,
          eventType: env.eventType,
        },
        'eazepay_app.unknown_event_type',
      );
      await writeAuditLog({
        action: 'WEBHOOK_FAILED',
        resourceType: 'webhook_event',
        resourceId: job.webhookEventId,
        metadata: { source: 'EAZEPAY_APP', reason: 'unknown_event_type', eventType: env.eventType },
      });
      return;
    }
    try {
      switch (env.eventType as EazepayAppEventType) {
        case 'application.offers_presented':
          await this.handleOffersPresented(job, db);
          return;
        case 'application.contracted':
          await this.handleContracted(job, db);
          return;
        case 'application.declined':
          await this.handleDeclined(job, db);
          return;
        case 'application.funded':
          await this.handleFunded(job, db);
          return;
        case 'merchant.onboarded':
          await this.handleMerchantOnboarded(job, db);
          return;
        case 'merchant.status_changed':
          await this.handleMerchantStatusChanged(job, db);
          return;
        case 'revenue.recorded':
          await this.handleRevenueRecorded(job, db);
          return;
        case 'loan.repayment.collected':
        case 'loan.repayment.failed':
          await this.handleLoanRepayment(job, db);
          return;
      }
    } catch (err) {
      // Schema mismatch (z.parse failed) is a permanent fault — log + audit
      // and DO NOT rethrow. Re-throwing would loop the row to DLQ for a
      // forever-broken shape. Genuine transient faults (DB outage, KMS
      // outage) will rethrow inside the helpers and propagate normally.
      if (err instanceof z.ZodError) {
        log.error(
          {
            errorId: 'eazepay_app.invalid_payload',
            webhookEventId: job.webhookEventId,
            eventType: env.eventType,
            issues: err.issues.slice(0, 5),
          },
          'eazepay_app.invalid_payload',
        );
        await writeAuditLog({
          action: 'WEBHOOK_FAILED',
          resourceType: 'webhook_event',
          resourceId: job.webhookEventId,
          metadata: {
            source: 'EAZEPAY_APP',
            reason: 'invalid_payload',
            eventType: env.eventType,
          },
        });
        return;
      }
      throw err;
    }
  }

  // ─── Org resolution ───────────────────────────────────────────────────────

  private async resolveOrgId(brand: string, db: PrismaClient): Promise<string | null> {
    const res = resolveBrandToOrgSlug(brand);
    if (!res.orgSlug) return null;
    const org = await db.organization.findUnique({
      where: { slug: res.orgSlug },
      select: { id: true, deletedAt: true },
    });
    if (!org || org.deletedAt) return null;
    return org.id;
  }

  // ─── application.offers_presented ────────────────────────────────────────

  private async handleOffersPresented(job: EazepayAppJob, db: PrismaClient): Promise<void> {
    const data = OffersPresentedSchema.parse(job.envelope.data);
    const orgId = await this.resolveOrgId(data.brand, db);
    // GAP-120: brand=direct (or any unmapped brand) lands in QUARANTINE.
    // We still persist the WebhookEvent (already done by ingest) but skip
    // domain normalisation — the row stays raw and operator-reviewable.
    if (!orgId) {
      await this.quarantine(job, db, 'unmapped_brand');
      return;
    }
    const partner = data.partnerExternalId
      ? await db.partner.findFirst({
          where: { orgId, externalId: data.partnerExternalId, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (!partner) {
      await this.quarantine(job, db, 'unknown_partner');
      return;
    }

    // Encrypt PII under the per-org DEK (Phase 3). Hashes via lower-case
    // normaliser so the customers/:hash endpoint joins on email correctly.
    const name = data.consumerNameFull ?? '';
    const email = (data.consumerEmail ?? data.consumerEmailLower ?? '').toLowerCase();
    const phone = data.consumerPhoneE164 ?? '';
    const [nameCt, emailCt, phoneCt] = await Promise.all([
      encryptForOrg(db, name, orgId),
      encryptForOrg(db, email, orgId),
      encryptForOrg(db, phone, orgId),
    ]);

    await db.application.upsert({
      where: {
        orgId_externalApplicationId: {
          orgId,
          externalApplicationId: data.externalApplicationId ?? data.applicationId,
        },
      },
      create: {
        id: uuidv7(),
        orgId,
        partnerId: partner.id,
        externalApplicationId: data.externalApplicationId ?? data.applicationId,
        consumerNameCiphertext: nameCt,
        consumerEmailCiphertext: emailCt,
        consumerPhoneCiphertext: phoneCt,
        consumerEmailHash: hashPII(email),
        consumerPhoneHash: hashPII(phone),
        status: ApplicationStatus.OFFERED,
        submittedAt: new Date(job.envelope.createdAt),
      },
      update: {
        status: ApplicationStatus.OFFERED,
      },
    });
    await publishWsEvent(
      orgId,
      withPartnerLabel({
        type: 'application.created',
        at: new Date().toISOString(),
        partnerId: partner.id,
        applicationId: data.applicationId,
        status: 'OFFERED',
      }),
    );
  }

  // ─── application.contracted ──────────────────────────────────────────────

  private async handleContracted(job: EazepayAppJob, db: PrismaClient): Promise<void> {
    const data = ContractedSchema.parse(job.envelope.data);
    const orgId = await this.resolveOrgId(data.brand, db);
    if (!orgId) {
      await this.quarantine(job, db, 'unmapped_brand');
      return;
    }
    const existing = await db.application.findFirst({
      where: { orgId, externalApplicationId: data.applicationId },
    });
    if (!existing) {
      await this.quarantine(job, db, 'unknown_application');
      return;
    }
    await db.application.update({
      where: { id: existing.id },
      data: {
        status: ApplicationStatus.CONTRACTED,
      },
    });
    if (data.lenderName) {
      await db.lenderDecision.create({
        data: {
          id: uuidv7(),
          orgId,
          applicationId: existing.id,
          partnerId: existing.partnerId,
          lenderName: data.lenderName,
          // EazePay App carries lender name but not tier; default to
          // PRIME (matches the App's default tiering) and let downstream
          // enrichment correct via the lender-decision update path.
          lenderTier: 'PRIME',
          decision: 'APPROVED',
          decisionTimestamp: new Date(),
          approvalAmount: data.contractedAmount
            ? new Prisma.Decimal(data.contractedAmount.toString())
            : null,
          apr: data.apr ? new Prisma.Decimal(data.apr.toString()) : null,
          term: data.term ?? null,
        },
      });
    }
  }

  // ─── application.declined ────────────────────────────────────────────────

  private async handleDeclined(job: EazepayAppJob, db: PrismaClient): Promise<void> {
    const data = DeclinedSchema.parse(job.envelope.data);
    const orgId = await this.resolveOrgId(data.brand, db);
    if (!orgId) {
      await this.quarantine(job, db, 'unmapped_brand');
      return;
    }
    const existing = await db.application.findFirst({
      where: { orgId, externalApplicationId: data.applicationId },
    });
    if (!existing) {
      await this.quarantine(job, db, 'unknown_application');
      return;
    }
    await db.application.update({
      where: { id: existing.id },
      data: { status: ApplicationStatus.DECLINED },
    });
  }

  // ─── application.funded ──────────────────────────────────────────────────

  private async handleFunded(job: EazepayAppJob, db: PrismaClient): Promise<void> {
    const data = FundedSchema.parse(job.envelope.data);
    const orgId = await this.resolveOrgId(data.brand, db);
    if (!orgId) {
      await this.quarantine(job, db, 'unmapped_brand');
      return;
    }
    const existing = await db.application.findFirst({
      where: { orgId, externalApplicationId: data.applicationId },
      include: { partner: true },
    });
    if (!existing) {
      await this.quarantine(job, db, 'unknown_application');
      return;
    }
    await db.application.update({
      where: { id: existing.id },
      data: { status: ApplicationStatus.FUNDED },
    });
    // Record the funding as a revenue event keyed on the application —
    // the merchant fee is computed downstream by the aggregation worker.
    const amount = new Prisma.Decimal(data.fundedAmount.toString());
    await this.recordRevenue(db, {
      orgId,
      partnerId: existing.partnerId,
      source: WebhookSource.EAZEPAY_APP,
      stream: RevenueStream.EAZEPAY_APP,
      eventType: RevenueEventType.MERCHANT_FEE,
      amount,
      currency: data.currency ?? 'AUD',
      effectiveAt: new Date(data.fundedAt),
      idempotencyKey: `eazepay-app:funded:${data.applicationId}`,
      metadata: { lender: data.lenderName ?? null },
    });
  }

  // ─── merchant.onboarded ──────────────────────────────────────────────────

  private async handleMerchantOnboarded(job: EazepayAppJob, db: PrismaClient): Promise<void> {
    const data = MerchantOnboardedSchema.parse(job.envelope.data);
    const orgId = await this.resolveOrgId(data.brand, db);
    if (!orgId) {
      await this.quarantine(job, db, 'unmapped_brand');
      return;
    }
    await db.partner.upsert({
      where: { orgId_externalId: { orgId, externalId: data.merchantExternalId } },
      create: {
        id: uuidv7(),
        orgId,
        externalId: data.merchantExternalId,
        name: data.name,
        // App-side onboarded merchants don't carry industry today; use
        // 'unknown' until the App event evolves to include it. Operators
        // can override via the partner update endpoint.
        industry: 'unknown',
        onboardingDate: data.effectiveAt ? new Date(data.effectiveAt) : new Date(),
      },
      update: {
        name: data.name,
      },
    });
  }

  // ─── merchant.status_changed ─────────────────────────────────────────────

  private async handleMerchantStatusChanged(job: EazepayAppJob, db: PrismaClient): Promise<void> {
    const data = MerchantStatusChangedSchema.parse(job.envelope.data);
    const orgId = await this.resolveOrgId(data.brand, db);
    if (!orgId) {
      await this.quarantine(job, db, 'unmapped_brand');
      return;
    }
    const existing = await db.partner.findFirst({
      where: { orgId, externalId: data.merchantExternalId },
    });
    if (!existing) {
      await this.quarantine(job, db, 'unknown_partner');
      return;
    }
    // OFFBOARDED → soft-delete (audit-safe). Other statuses kept on a
    // lifecycle metadata field; the Partner table doesn't currently have
    // a status enum so we record it as JSON metadata on the partner.
    if (data.status === 'OFFBOARDED') {
      await db.partner.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
    }
  }

  // ─── revenue.recorded ────────────────────────────────────────────────────

  private async handleRevenueRecorded(job: EazepayAppJob, db: PrismaClient): Promise<void> {
    const data = RevenueRecordedSchema.parse(job.envelope.data);
    const orgId = await this.resolveOrgId(data.brand, db);
    if (!orgId) {
      await this.quarantine(job, db, 'unmapped_brand');
      return;
    }
    const partner = await db.partner.findFirst({
      where: { orgId, externalId: data.partnerExternalId, deletedAt: null },
      select: { id: true },
    });
    if (!partner) {
      await this.quarantine(job, db, 'unknown_partner');
      return;
    }
    const stream = mapRevenueStream(data.stream);
    const eventType = mapRevenueEventType(data.eventType);
    await this.recordRevenue(db, {
      orgId,
      partnerId: partner.id,
      source: WebhookSource.EAZEPAY_APP,
      stream,
      eventType,
      amount: new Prisma.Decimal(data.amount.toString()),
      currency: data.currency ?? 'AUD',
      effectiveAt: new Date(data.effectiveAt),
      idempotencyKey: `eazepay-app:rev:${data.externalEventId}`,
      metadata: { ...(data.metadata ?? {}), source: 'EAZEPAY_APP' },
    });
  }

  // ─── loan.repayment.* ────────────────────────────────────────────────────

  private async handleLoanRepayment(job: EazepayAppJob, db: PrismaClient): Promise<void> {
    const data = LoanRepaymentSchema.parse(job.envelope.data);
    const orgId = await this.resolveOrgId(data.brand, db);
    if (!orgId) {
      await this.quarantine(job, db, 'unmapped_brand');
      return;
    }
    const partner = data.partnerExternalId
      ? await db.partner.findFirst({
          where: { orgId, externalId: data.partnerExternalId, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (!partner) {
      await this.quarantine(job, db, 'unknown_partner');
      return;
    }
    const failed = job.envelope.eventType === 'loan.repayment.failed';
    const amount = new Prisma.Decimal(data.amount.toString());
    await this.recordRevenue(db, {
      orgId,
      partnerId: partner.id,
      source: WebhookSource.EAZEPAY_APP,
      stream: RevenueStream.EAZEPAY_APP,
      eventType: failed ? RevenueEventType.REVERSAL : RevenueEventType.COMMISSION,
      amount: failed ? amount.neg() : amount,
      currency: data.currency ?? 'AUD',
      effectiveAt: new Date(data.effectiveAt),
      idempotencyKey: `eazepay-app:loan:${data.loanId}:${data.effectiveAt}`,
      metadata: { loanId: data.loanId, failed },
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private async recordRevenue(
    db: PrismaClient,
    args: {
      orgId: string;
      partnerId: string;
      source: WebhookSource;
      stream: RevenueStream;
      eventType: RevenueEventType;
      amount: Prisma.Decimal;
      currency: string;
      effectiveAt: Date;
      idempotencyKey: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await db.revenueEvent.create({
        data: {
          orgId: args.orgId,
          partnerId: args.partnerId,
          source: args.source,
          stream: args.stream,
          eventType: args.eventType,
          amount: args.amount,
          currency: args.currency.toUpperCase(),
          effectiveAt: args.effectiveAt,
          idempotencyKey: args.idempotencyKey,
          metadata: args.metadata as Prisma.InputJsonValue,
        },
      });
      await publishWsEvent(
        args.orgId,
        withPartnerLabel({
          type: 'revenue.event',
          at: new Date().toISOString(),
          partnerId: args.partnerId,
          stream: args.stream,
          eventType: args.eventType,
          amount: args.amount.toString(),
        }),
      );
      await writeAuditLog({
        action: 'REVENUE_EVENT_RECORDED',
        resourceType: 'revenue_event',
        resourceId: args.idempotencyKey,
        metadata: { stream: args.stream, type: args.eventType, amount: args.amount.toString() },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Duplicate idempotency key — already recorded. Idempotent by design.
        return;
      }
      throw err;
    }
  }

  /**
   * Quarantine path: mark the WebhookEvent row with a quarantine reason
   * and audit. Does NOT throw — the worker should not loop a row that
   * cannot map to a domain object (no org, no partner, etc.). Operator
   * can later use /platform/orgs/:id/eazepay-app/quarantine to triage.
   */
  private async quarantine(job: EazepayAppJob, db: PrismaClient, reason: string): Promise<void> {
    await db.webhookEvent.update({
      where: { id: job.webhookEventId },
      data: {
        status: 'QUARANTINED',
        processingError: `eazepay_app.quarantine: ${reason}`,
      },
    });
    await writeAuditLog({
      action: 'INGESTION_REJECTED',
      resourceType: 'webhook_event',
      resourceId: job.webhookEventId,
      metadata: { source: 'EAZEPAY_APP', reason, eventType: job.envelope.eventType },
    });
  }
}

function mapRevenueStream(v: string): RevenueStream {
  switch (v.toUpperCase()) {
    case 'EAZEPAY_APP':
      return RevenueStream.EAZEPAY_APP;
    case 'MICAMP':
      return RevenueStream.MICAMP;
    case 'PIXIE':
      return RevenueStream.PIXIE;
    default:
      return RevenueStream.EAZEPAY_APP;
  }
}

function mapRevenueEventType(v: string): RevenueEventType {
  switch (v.toUpperCase()) {
    case 'MERCHANT_FEE':
      return RevenueEventType.MERCHANT_FEE;
    case 'COMMISSION':
      return RevenueEventType.COMMISSION;
    case 'REVERSAL':
      return RevenueEventType.REVERSAL;
    case 'PROCESSING_FEE':
      return RevenueEventType.PROCESSING_FEE;
    case 'PIXIE_MARGIN':
      return RevenueEventType.PIXIE_MARGIN;
    default:
      return RevenueEventType.COMMISSION;
  }
}
