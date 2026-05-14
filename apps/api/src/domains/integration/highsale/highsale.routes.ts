/**
 * POST /integration/highsale/snapshots
 *
 * Inbound: HighSale ("EZ Check") pushes one credit-data snapshot per
 * BNPL application across medpay / tradepay / coachpay.
 *
 * Pipeline:
 *   1. HMAC-SHA-256 verification against HIGHSALE_WEBHOOK_SECRET
 *   2. Timestamp tolerance (±5 min)
 *   3. Idempotency: dedupe on (vertical, transaction_id). Returns 202
 *      with `replayed: true` if we already have the row.
 *   4. PII encryption: request_body name / email / phone / DOB / address
 *      go through encryptPII; email + phone + DOB also hashed for join.
 *   5. Persist to credit_enrichments. Demographics block lands on the
 *      same row but is read-gated downstream (stg_credit_enrichments
 *      excludes it; stg_credit_enrichments_protected is the only path).
 *   6. CREDIT_SNAPSHOT_RECEIVED audit row.
 *
 * Contract: docs/architecture/data-warehouse-overview.md § Plane 2
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getEnv } from '../../../config/env.js';
import { getPrisma } from '../../../config/database.js';
import { errors } from '../../../shared/errors/app-error.js';
import { encryptPII, hashPII } from '../../../shared/utils/encryption.js';
import { writeAuditLog } from '../../../shared/middleware/audit-log.middleware.js';
import { requireAuth } from '../../../shared/middleware/auth.middleware.js';
import { HighsaleSnapshotEnvelopeSchema } from './highsale-snapshot.schema.js';

const SIG_HEADER = 'x-highsale-signature';
const TS_HEADER = 'x-highsale-timestamp';
const KEY_HEADER = 'idempotency-key';
const TOLERANCE_SECONDS = 300;

function firstHeader(req: FastifyRequest, name: string): string | null {
  const h = req.headers[name];
  if (!h) return null;
  if (Array.isArray(h)) return h[0] ?? null;
  return h;
}

function stripSha256Prefix(sig: string): string {
  return sig.startsWith('sha256=') ? sig.slice(7) : sig;
}

function verifySignature(
  rawBody: string,
  ts: string,
  providedHex: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Resolve the inbound vertical to the corresponding Organization row.
 * The 3 BNPL verticals map 1:1 to org slugs. Without a known org we
 * have nowhere to persist — reject 422 to make the misconfig loud.
 */
async function resolveOrgIdForVertical(
  prisma: ReturnType<typeof getPrisma>,
  vertical: 'medpay' | 'tradepay' | 'coachpay',
): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { slug: vertical },
    select: { id: true },
  });
  return org?.id ?? null;
}

export async function registerHighsaleIntegrationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/integration/highsale/snapshots', async (req, reply) => {
    const env = getEnv();
    const prisma = getPrisma();

    // ─── Signature + headers ────────────────────────────────────────────
    const ts = firstHeader(req, TS_HEADER);
    const idempotencyKey = firstHeader(req, KEY_HEADER);
    const sigRaw = firstHeader(req, SIG_HEADER);
    if (!ts || !idempotencyKey || !sigRaw) throw errors.invalidSignature();

    const sig = stripSha256Prefix(sigRaw);
    const tsNum = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) throw errors.invalidSignature();
    if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > TOLERANCE_SECONDS) {
      throw errors.invalidSignature();
    }

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    if (!verifySignature(rawBody, ts, sig, env.HIGHSALE_WEBHOOK_SECRET)) {
      throw errors.invalidSignature();
    }

    // ─── Envelope ───────────────────────────────────────────────────────
    const parsed = HighsaleSnapshotEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { accepted: false, reason: 'invalid_envelope', issues: parsed.error.issues };
    }
    const env_ = parsed.data;
    const snap = env_.snapshot;

    // ─── Idempotency check ──────────────────────────────────────────────
    const prior = await prisma.creditEnrichment.findUnique({
      where: { highsaleTransactionId: snap.transaction_id },
      select: { id: true, vertical: true },
    });
    if (prior) {
      reply.status(202);
      return {
        accepted: true,
        snapshotId: prior.id,
        replayed: true,
        vertical: prior.vertical,
      };
    }

    // ─── Org resolution ─────────────────────────────────────────────────
    const orgId = await resolveOrgIdForVertical(prisma, env_.vertical);
    if (!orgId) {
      reply.status(422);
      return {
        accepted: false,
        reason: 'unknown_vertical_org',
        vertical: env_.vertical,
        hint: 'Ensure an Organization row exists with slug matching the vertical.',
      };
    }

    // ─── PII encryption + hash ──────────────────────────────────────────
    const r = snap.request_body;
    const fullName = `${r.first_name} ${r.last_name}`;
    const fullAddress = [r.street_address_1, r.street_address_2 ?? '', r.city, r.state, r.zip_code]
      .filter(Boolean)
      .join('|');

    const nameEnc = encryptPII(fullName);
    const emailEnc = encryptPII(r.email);
    const phoneEnc = encryptPII(r.phone);
    const dobEnc = encryptPII(r.date_of_birth);
    const addressEnc = encryptPII(fullAddress);
    // email + phone + dob hashes for analytical join (deterministic HMAC)
    const consumerEmailHash = hashPII(r.email);
    const consumerPhoneHash = hashPII(r.phone);
    const dateOfBirthHash = hashPII(r.date_of_birth);

    // ─── Persist ────────────────────────────────────────────────────────
    const row = await prisma.creditEnrichment.create({
      data: {
        orgId,
        highsaleTransactionId: snap.transaction_id,
        applicationId: null, // resolved later via correlation token
        externalApplicationId: env_.external_application_id ?? null,
        vertical: env_.vertical,
        pulledAt: new Date(snap.created),

        // PII (encrypted at rest; hashes for join)
        consumerNameCiphertext: nameEnc.ciphertext,
        consumerEmailCiphertext: emailEnc.ciphertext,
        consumerEmailHash,
        consumerPhoneCiphertext: phoneEnc.ciphertext,
        consumerPhoneHash,
        dateOfBirthCiphertext: dobEnc.ciphertext,
        dateOfBirthHash,
        addressCiphertext: addressEnc.ciphertext,
        verifiableIncomeCents: r.verifiable_income,
        rentPaymentCents: r.rent_payment,

        // Lookup flags
        isFrozen: snap.is_frozen,
        isNoHit: snap.is_no_hit,
        isAddressAppend: snap.is_address_append,
        isAddressNoHit: snap.is_address_no_hit,
        isInsufficientCreditData: snap.is_insufficient_credit_data,

        // Grades
        score: snap.score,
        creditLineGrade: snap.credit_line_grade,
        revolvingLinesGrade: snap.revolving_lines_grade,
        oldestAccountGrade: snap.oldest_account_grade,
        latePaymentsGrade: snap.late_payments_grade,
        collectionsGrade: snap.collections_grade,
        newLinesGrade: snap.new_lines_grade,
        utilizationGrade: snap.utilization_grade,
        recentInquiriesGrade: snap.recent_inquiries_grade,
        averageGrade: snap.average_grade,

        // Decision rates
        declineRate: new Prisma.Decimal(snap.decline_rate),
        approvalRate: new Prisma.Decimal(snap.approval_rate),

        // Inquiry quotas
        personalRemainingInquiries: snap.personal_remaining_inquiries,
        personalLoanRemainingInquiries: snap.personal_loan_remaining_inquiries,
        businessRemainingInquiries: snap.business_remaining_inquiries,

        // Aggregate credit profile
        totalLines: snap.total_lines,
        totalRevolvingLines: snap.total_revolving_lines,
        availableCreditCents: snap.available_credit,
        averageCreditLimitCents: snap.average_credit_limit,
        totalCreditLimitCents: snap.total_credit_limit,
        oldestCreditAge: snap.oldest_credit_age,
        averageCreditAge: snap.average_credit_age,
        totalInquiries: snap.total_inquiries,
        utilization: new Prisma.Decimal(snap.utilization),
        latePayments: snap.late_payments,
        collections: snap.collections,
        trendedIncomeCents: snap.trended_income,
        trendedDebtCents: Math.round(snap.trended_debt),

        // Qualification
        isQualified: snap.is_qualified,
        dqReasons: snap.dq_reasons,
        confidenceScore: new Prisma.Decimal(snap.confidence_score),
        fundingEstimateCents: snap.funding_estimate,
        isQualifiedBnpl: snap.is_qualified_bnpl,
        confidenceScoreBnpl: new Prisma.Decimal(snap.confidence_score_bnpl),
        fundingEstimateBnplCents: snap.funding_estimate_bnpl,
        isQualifiedConsumerLoan: snap.is_qualified_consumer_loan,
        fundingEstimateConsumerLoanCents: snap.funding_estimate_consumer_loan,

        // Tradeline detail
        numSatisfactoryTradeLines: snap.num_satisfactory_trade_lines,
        numTradeLinesOpenedInLast6Months: snap.num_trade_lines_opened_in_last_6_months,
        monthsSinceMostRecentDelinquency: snap.months_since_most_recent_delinquency,
        numPrBankruptciesInLast24Months: snap.num_pr_bankruptcies_in_last_24_months,
        totalMonthlyObligationCents: Math.round(snap.total_monthly_obligation),
        numThirdPartyCollectionsWithBalance: snap.num_third_party_collections_with_balance,
        numOpenHomeEquityLoanTrades: snap.num_open_home_equity_loan_trades,
        totalCreditUnionCreditLinesInLast12Months:
          snap.total_credit_union_credit_lines_in_last_12_months,
        totalBalanceOfOpenCreditUnionTradeLinesInLast12MonthsCents: Math.round(
          snap.total_balance_of_open_credit_union_trade_lines_in_last_12_months,
        ),
        monthsSinceMostRecentCreditUnionTradeOpened:
          snap.months_since_most_recent_credit_union_trade_opened,
        totalBalanceOfOpenRevolvingTradesInLast12MonthsCents: Math.round(
          snap.total_balance_of_open_revolving_trades_in_last_12_months,
        ),
        utilizationOfOpenRevolvingTradesInLast12Months: new Prisma.Decimal(
          snap.utilization_of_open_revolving_trades_in_last_12_months,
        ),
        numOfRepoTrades: snap.num_of_repo_trades,
        totalBalanceOfRepoTradesCents: Math.round(snap.total_balance_of_repo_trades),
        numOfRetailTrades: snap.num_of_retail_trades,
        numOfOpenRetailTrades: snap.num_of_open_retail_trades,
        numOfThirdPartyCollections: snap.num_of_third_party_collections,
        numOfNonMedicalThirdPartyCollections: snap.num_of_non_medical_third_party_collections,
        numOfThirdPartyCollectionsInTheLast36Months:
          snap.num_of_third_party_collections_in_the_last_36_months,
        numOfStudentLoanTrades: snap.num_of_student_loan_trades,
        numOfOpenStudentLoanTrades: snap.num_of_open_student_loan_trades,
        numOfSatisfactoryOpenStudentLoanTrades: snap.num_of_satisfactory_open_student_loan_trades,
        numOf90PlusDaysPastDueStudentLoans: snap.num_of_90_plus_days_past_due_student_loans,
        numOfAuthUserTrades: snap.num_of_auth_user_trades,
        numOpenUnsecuredInstallmentTrades: snap.num_open_unsecured_installment_trades,
        totalOpenUnsecuredInstallmentTradesInLast12Months:
          snap.total_open_unsecured_installment_trades_in_last_12_months,
        percentOfOpenUnsecuredInstallmentTradesGt75InLast12Months: new Prisma.Decimal(
          snap.percent_of_open_unsecured_installment_trades_greater_than_75_in_last_12_months,
        ),
        utilizationOfOpenUnsecuredVerifiedInstallmentTradesInLast12Months: new Prisma.Decimal(
          snap.utilization_of_open_unsecured_verified_installment_trades_in_last_12_months,
        ),

        // Adverse events
        numOfChargeOffs: snap.num_of_charge_offs,
        numOfRepos: snap.num_of_repos,
        numOfForeclosures: snap.num_of_foreclosures,

        // ML
        saleConfidenceScore: new Prisma.Decimal(snap.sale_confidence_score),

        // Demographics (protected-class)
        estimatedIncomeBand: snap.estimated_income ?? null,
        numberOfChildren: snap.number_of_children ?? null,
        maritalStatus: snap.marital_status ?? null,
        occupationGroup: snap.occupation_group ?? null,
        occupation: snap.occupation ?? null,
        education: snap.education ?? null,
        businessOwner: snap.business_owner ?? null,
        gender: snap.gender ?? null,
        netWorth: snap.net_worth ?? null,
        estimatedCurrentHomeValue: snap.estimated_current_home_value ?? null,
        ethnicity: snap.ethnicity ?? null,
        ethnicGroup: snap.ethnic_group ?? null,
        language: snap.language ?? null,

        // Forensic completeness
        rawPayload: snap as Prisma.InputJsonValue,
      },
      select: { id: true, vertical: true },
    });

    await writeAuditLog({
      req,
      userId: null,
      action: 'CREDIT_SNAPSHOT_RECEIVED',
      resourceType: 'credit_enrichment',
      resourceId: row.id,
      metadata: {
        vertical: env_.vertical,
        transactionId: snap.transaction_id,
        externalApplicationId: env_.external_application_id ?? null,
        isQualified: snap.is_qualified,
        isQualifiedBnpl: snap.is_qualified_bnpl,
      },
    });

    reply.status(202);
    return {
      accepted: true,
      snapshotId: row.id,
      vertical: row.vertical,
      replayed: false,
      isQualified: snap.is_qualified,
      isQualifiedBnpl: snap.is_qualified_bnpl,
      score: snap.score,
    };
  });

  // ─── List + aggregate read endpoints for the /highsale drill page ──────
  //
  // GET /highsale/snapshots  → list rows (filtered) + aggregates in one
  //                            round-trip. The UI needs both per page
  //                            render; splitting them doubles the
  //                            network cost for no win.

  const ListQuery = z.object({
    vertical: z.enum(['medpay', 'tradepay', 'coachpay']).optional(),
    isQualified: z.coerce.boolean().optional(),
    isQualifiedBnpl: z.coerce.boolean().optional(),
    scoreMin: z.coerce.number().int().optional(),
    scoreMax: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });

  app.get('/highsale/snapshots', { preHandler: requireAuth }, async (req) => {
    const prisma = getPrisma();
    const q = ListQuery.parse(req.query);
    const where: Prisma.CreditEnrichmentWhereInput = { deletedAt: null };
    if (q.vertical) where.vertical = q.vertical;
    if (q.isQualified !== undefined) where.isQualified = q.isQualified;
    if (q.isQualifiedBnpl !== undefined) where.isQualifiedBnpl = q.isQualifiedBnpl;
    if (q.scoreMin !== undefined || q.scoreMax !== undefined) {
      where.score = {};
      if (q.scoreMin !== undefined) where.score.gte = q.scoreMin;
      if (q.scoreMax !== undefined) where.score.lte = q.scoreMax;
    }

    const [rows, byVertical, byQualification, scoreAgg, recent24h] = await Promise.all([
      prisma.creditEnrichment.findMany({
        where,
        orderBy: { pulledAt: 'desc' },
        take: q.limit,
        select: {
          id: true,
          vertical: true,
          pulledAt: true,
          highsaleTransactionId: true,
          externalApplicationId: true,
          applicationId: true,
          consumerEmailHash: true,
          score: true,
          averageGrade: true,
          isQualified: true,
          isQualifiedBnpl: true,
          isQualifiedConsumerLoan: true,
          dqReasons: true,
          confidenceScoreBnpl: true,
          fundingEstimateBnplCents: true,
          availableCreditCents: true,
          utilization: true,
          numOfChargeOffs: true,
          numOfRepos: true,
          numOfForeclosures: true,
          saleConfidenceScore: true,
        },
      }),
      prisma.creditEnrichment.groupBy({
        by: ['vertical'],
        where: { deletedAt: null },
        _count: { _all: true },
        _avg: { score: true },
      }),
      prisma.creditEnrichment.groupBy({
        by: ['isQualifiedBnpl'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      prisma.creditEnrichment.aggregate({
        where: { deletedAt: null },
        _count: { _all: true },
        _avg: { score: true, saleConfidenceScore: true },
        _min: { score: true },
        _max: { score: true },
      }),
      prisma.creditEnrichment.count({
        where: { deletedAt: null, pulledAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      }),
    ]);

    // Top DQ reasons across the filtered set — emit raw counts; UI sorts.
    const dqCounts = new Map<string, number>();
    for (const r of rows) {
      for (const reason of r.dqReasons) {
        dqCounts.set(reason, (dqCounts.get(reason) ?? 0) + 1);
      }
    }
    const topDqReasons = Array.from(dqCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));

    return {
      data: rows.map((r) => ({
        ...r,
        consumerEmailHash: r.consumerEmailHash.toString('hex'),
      })),
      aggregates: {
        total: scoreAgg._count._all,
        last24h: recent24h,
        avgScore: scoreAgg._avg.score,
        minScore: scoreAgg._min.score,
        maxScore: scoreAgg._max.score,
        avgMlConfidence: scoreAgg._avg.saleConfidenceScore,
        byVertical: byVertical.map((v) => ({
          vertical: v.vertical,
          count: v._count._all,
          avgScore: v._avg.score,
        })),
        byQualification: {
          bnplQualified: byQualification.find((b) => b.isQualifiedBnpl === true)?._count._all ?? 0,
          bnplNotQualified:
            byQualification.find((b) => b.isQualifiedBnpl === false)?._count._all ?? 0,
        },
        topDqReasons,
      },
    };
  });
}
