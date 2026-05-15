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
import { encryptPII, hashPII, decryptPII } from '../../../shared/utils/encryption.js';
import { writeAuditLog } from '../../../shared/middleware/audit-log.middleware.js';
import { requireAuth } from '../../../shared/middleware/auth.middleware.js';
import { rowsToCsv, attachmentHeader } from '../../../shared/utils/csv.js';
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

    // P0 fix (SEC-004 / CR-104 / SEC-100): sign over the raw request bytes
    // not a re-serialised JSON form. See server.ts content-type parser and
    // webhook-signature.middleware.ts for the wider fix.
    const rawBody = req.rawBody;
    if (rawBody == null) throw errors.invalidSignature();
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

    const canRevealPii = req.auth?.role === 'ADMIN' || req.auth?.role === 'OPERATOR';

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
          // PII ciphertext — decrypted server-side for ADMIN/OPERATOR only
          consumerNameCiphertext: true,
          consumerEmailCiphertext: true,
          consumerPhoneCiphertext: true,
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

    // ─── PII reveal (gated) ───────────────────────────────────────────────
    // ADMIN + OPERATOR see decrypted consumer name / email / phone inline
    // so the internal team can scan the funnel without one-click reveals
    // per row. The access is batched-audited (one PII_ACCESSED row per
    // list call, with row count + filter context). Viewer/investor roles
    // get masks only.
    if (canRevealPii && rows.length > 0) {
      await writeAuditLog({
        req,
        action: 'PII_ACCESSED',
        resourceType: 'credit_enrichment',
        metadata: {
          via: 'highsale_list',
          rowCount: rows.length,
          fields: ['name', 'email', 'phone'],
          filters: {
            vertical: q.vertical ?? null,
            isQualified: q.isQualified ?? null,
            isQualifiedBnpl: q.isQualifiedBnpl ?? null,
            scoreMin: q.scoreMin ?? null,
            scoreMax: q.scoreMax ?? null,
          },
        },
      });
    }

    const safeDecrypt = (cipher: Buffer): string | null => {
      try {
        return decryptPII(cipher);
      } catch {
        return null;
      }
    };

    const maskEmail = (email: string): string => {
      const [local, domain] = email.split('@');
      if (!local || !domain) return '****';
      const visible = local.slice(0, 1);
      return `${visible}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
    };

    const maskPhone = (phone: string): string => {
      if (phone.length <= 4) return '****';
      return `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
    };

    return {
      data: rows.map((r) => {
        const nameClear = canRevealPii ? safeDecrypt(r.consumerNameCiphertext) : null;
        const emailClear = canRevealPii ? safeDecrypt(r.consumerEmailCiphertext) : null;
        const phoneClear = canRevealPii ? safeDecrypt(r.consumerPhoneCiphertext) : null;
        return {
          id: r.id,
          vertical: r.vertical,
          pulledAt: r.pulledAt,
          highsaleTransactionId: r.highsaleTransactionId,
          externalApplicationId: r.externalApplicationId,
          applicationId: r.applicationId,
          consumerEmailHash: r.consumerEmailHash.toString('hex'),
          consumerName: nameClear,
          consumerEmail: emailClear,
          consumerEmailMasked: emailClear ? maskEmail(emailClear) : null,
          consumerPhone: phoneClear,
          consumerPhoneMasked: phoneClear ? maskPhone(phoneClear) : null,
          score: r.score,
          averageGrade: r.averageGrade,
          isQualified: r.isQualified,
          isQualifiedBnpl: r.isQualifiedBnpl,
          isQualifiedConsumerLoan: r.isQualifiedConsumerLoan,
          dqReasons: r.dqReasons,
          confidenceScoreBnpl: r.confidenceScoreBnpl,
          fundingEstimateBnplCents: r.fundingEstimateBnplCents,
          availableCreditCents: r.availableCreditCents,
          utilization: r.utilization,
          numOfChargeOffs: r.numOfChargeOffs,
          numOfRepos: r.numOfRepos,
          numOfForeclosures: r.numOfForeclosures,
          saleConfidenceScore: r.saleConfidenceScore,
        };
      }),
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

  // ─── Single snapshot detail — the full 70-field mapping ─────────────
  //
  // GET /highsale/snapshots/:id  → every field HighSale sent for one
  // snapshot, grouped by logical block. Drives the /highsale/[id]
  // mapping view. PII fields (request_body.*) are NOT decrypted here;
  // we surface the hash + a placeholder. Use GET /customers/:hash/pii
  // for the auditable reveal.
  app.get('/highsale/snapshots/:id', { preHandler: requireAuth }, async (req) => {
    const prisma = getPrisma();
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await prisma.creditEnrichment.findUnique({
      where: { id: params.id },
    });
    if (!row || row.deletedAt) throw errors.notFound('CreditEnrichment', params.id);

    // Re-shape into the same logical blocks the JSON spec uses. The UI
    // renders one card per block.
    return {
      id: row.id,
      orgId: row.orgId,
      vertical: row.vertical,
      pulledAt: row.pulledAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
      highsaleTransactionId: row.highsaleTransactionId,
      applicationId: row.applicationId,
      externalApplicationId: row.externalApplicationId,
      consumerEmailHash: row.consumerEmailHash.toString('hex'),
      consumerPhoneHash: row.consumerPhoneHash.toString('hex'),
      dateOfBirthHash: row.dateOfBirthHash.toString('hex'),

      blocks: {
        pii: {
          // PII is encrypted at rest. Surface metadata only — no plaintext.
          first_name: null,
          last_name: null,
          email: null,
          phone: null,
          date_of_birth: null,
          street_address_1: null,
          street_address_2: null,
          city: null,
          state: null,
          zip_code: null,
          verifiable_income: row.verifiableIncomeCents,
          rent_payment: row.rentPaymentCents,
          _note:
            'PII fields encrypted under per-org DEK. Reveal via GET /customers/:hash/pii (audited).',
        },
        lookup_flags: {
          is_frozen: row.isFrozen,
          is_no_hit: row.isNoHit,
          is_address_append: row.isAddressAppend,
          is_address_no_hit: row.isAddressNoHit,
          is_insufficient_credit_data: row.isInsufficientCreditData,
        },
        grades: {
          score: row.score,
          credit_line_grade: row.creditLineGrade,
          revolving_lines_grade: row.revolvingLinesGrade,
          oldest_account_grade: row.oldestAccountGrade,
          late_payments_grade: row.latePaymentsGrade,
          collections_grade: row.collectionsGrade,
          new_lines_grade: row.newLinesGrade,
          utilization_grade: row.utilizationGrade,
          recent_inquiries_grade: row.recentInquiriesGrade,
          average_grade: row.averageGrade,
        },
        decision_rates: {
          decline_rate: row.declineRate.toString(),
          approval_rate: row.approvalRate.toString(),
        },
        inquiry_quotas: {
          personal_remaining_inquiries: row.personalRemainingInquiries,
          personal_loan_remaining_inquiries: row.personalLoanRemainingInquiries,
          business_remaining_inquiries: row.businessRemainingInquiries,
        },
        credit_profile: {
          total_lines: row.totalLines,
          total_revolving_lines: row.totalRevolvingLines,
          available_credit_cents: row.availableCreditCents,
          average_credit_limit_cents: row.averageCreditLimitCents,
          total_credit_limit_cents: row.totalCreditLimitCents,
          oldest_credit_age: row.oldestCreditAge,
          average_credit_age: row.averageCreditAge,
          total_inquiries: row.totalInquiries,
          utilization: row.utilization.toString(),
          late_payments: row.latePayments,
          collections: row.collections,
          trended_income_cents: row.trendedIncomeCents,
          trended_debt_cents: row.trendedDebtCents,
        },
        qualification: {
          is_qualified: row.isQualified,
          dq_reasons: row.dqReasons,
          confidence_score: row.confidenceScore.toString(),
          funding_estimate_cents: row.fundingEstimateCents,
          is_qualified_bnpl: row.isQualifiedBnpl,
          confidence_score_bnpl: row.confidenceScoreBnpl.toString(),
          funding_estimate_bnpl_cents: row.fundingEstimateBnplCents,
          is_qualified_consumer_loan: row.isQualifiedConsumerLoan,
          funding_estimate_consumer_loan_cents: row.fundingEstimateConsumerLoanCents,
        },
        tradeline_detail: {
          num_satisfactory_trade_lines: row.numSatisfactoryTradeLines,
          num_trade_lines_opened_in_last_6_months: row.numTradeLinesOpenedInLast6Months,
          months_since_most_recent_delinquency: row.monthsSinceMostRecentDelinquency,
          num_pr_bankruptcies_in_last_24_months: row.numPrBankruptciesInLast24Months,
          total_monthly_obligation_cents: row.totalMonthlyObligationCents,
          num_third_party_collections_with_balance: row.numThirdPartyCollectionsWithBalance,
          num_open_home_equity_loan_trades: row.numOpenHomeEquityLoanTrades,
          total_credit_union_credit_lines_in_last_12_months:
            row.totalCreditUnionCreditLinesInLast12Months,
          total_balance_of_open_credit_union_trade_lines_in_last_12_months_cents:
            row.totalBalanceOfOpenCreditUnionTradeLinesInLast12MonthsCents,
          months_since_most_recent_credit_union_trade_opened:
            row.monthsSinceMostRecentCreditUnionTradeOpened,
          total_balance_of_open_revolving_trades_in_last_12_months_cents:
            row.totalBalanceOfOpenRevolvingTradesInLast12MonthsCents,
          utilization_of_open_revolving_trades_in_last_12_months:
            row.utilizationOfOpenRevolvingTradesInLast12Months.toString(),
          num_of_repo_trades: row.numOfRepoTrades,
          total_balance_of_repo_trades_cents: row.totalBalanceOfRepoTradesCents,
          num_of_retail_trades: row.numOfRetailTrades,
          num_of_open_retail_trades: row.numOfOpenRetailTrades,
          num_of_third_party_collections: row.numOfThirdPartyCollections,
          num_of_non_medical_third_party_collections: row.numOfNonMedicalThirdPartyCollections,
          num_of_third_party_collections_in_the_last_36_months:
            row.numOfThirdPartyCollectionsInTheLast36Months,
          num_of_student_loan_trades: row.numOfStudentLoanTrades,
          num_of_open_student_loan_trades: row.numOfOpenStudentLoanTrades,
          num_of_satisfactory_open_student_loan_trades: row.numOfSatisfactoryOpenStudentLoanTrades,
          num_of_90_plus_days_past_due_student_loans: row.numOf90PlusDaysPastDueStudentLoans,
          num_of_auth_user_trades: row.numOfAuthUserTrades,
          num_open_unsecured_installment_trades: row.numOpenUnsecuredInstallmentTrades,
          total_open_unsecured_installment_trades_in_last_12_months:
            row.totalOpenUnsecuredInstallmentTradesInLast12Months,
          percent_of_open_unsecured_installment_trades_gt_75_in_last_12_months:
            row.percentOfOpenUnsecuredInstallmentTradesGt75InLast12Months.toString(),
          utilization_of_open_unsecured_verified_installment_trades_in_last_12_months:
            row.utilizationOfOpenUnsecuredVerifiedInstallmentTradesInLast12Months.toString(),
        },
        adverse_events: {
          num_of_charge_offs: row.numOfChargeOffs,
          num_of_repos: row.numOfRepos,
          num_of_foreclosures: row.numOfForeclosures,
        },
        ml_score: {
          sale_confidence_score: row.saleConfidenceScore.toString(),
        },
        demographics_protected: {
          // FCRA / fair-lending protected-class fields. Surfaced here for
          // audit / disparate-impact monitoring only — see the
          // protected-class governance policy in the architecture doc.
          estimated_income: row.estimatedIncomeBand,
          number_of_children: row.numberOfChildren,
          marital_status: row.maritalStatus,
          occupation_group: row.occupationGroup,
          occupation: row.occupation,
          education: row.education,
          business_owner: row.businessOwner,
          gender: row.gender,
          net_worth: row.netWorth,
          estimated_current_home_value: row.estimatedCurrentHomeValue,
          ethnicity: row.ethnicity,
          ethnic_group: row.ethnicGroup,
          language: row.language,
        },
      },

      rawPayload: row.rawPayload,
    };
  });

  // ─── Export — CSV or JSON, respects filters, audited ───────────────────
  //
  // GET /highsale/snapshots/export?format=csv&vertical=&isQualifiedBnpl=&
  //                                 scoreMin=&scoreMax=&includeProtected=
  // Returns up to 50k rows in one shot. PII columns export as hashes only
  // (never plaintext). The protected-class demographics block is OFF by
  // default; including it requires ADMIN role + flips on the
  // PROTECTED_CLASS_READ audit row alongside DATA_EXPORTED.
  const ExportQuery = ListQuery.extend({
    format: z.enum(['csv', 'json']).default('csv'),
    includeProtected: z.coerce.boolean().default(false),
  });

  app.get('/highsale/snapshots/export', { preHandler: requireAuth }, async (req, reply) => {
    const prisma = getPrisma();
    const q = ExportQuery.parse(req.query);

    if (q.includeProtected && req.auth?.role !== 'ADMIN') {
      throw errors.forbidden('Including protected-class demographics requires ADMIN role.');
    }

    const where: Prisma.CreditEnrichmentWhereInput = { deletedAt: null };
    if (q.vertical) where.vertical = q.vertical;
    if (q.isQualified !== undefined) where.isQualified = q.isQualified;
    if (q.isQualifiedBnpl !== undefined) where.isQualifiedBnpl = q.isQualifiedBnpl;
    if (q.scoreMin !== undefined || q.scoreMax !== undefined) {
      where.score = {};
      if (q.scoreMin !== undefined) where.score.gte = q.scoreMin;
      if (q.scoreMax !== undefined) where.score.lte = q.scoreMax;
    }

    const rows = await prisma.creditEnrichment.findMany({
      where,
      orderBy: { pulledAt: 'desc' },
      take: 50_000,
    });

    // Always audit. Protected-class inclusion gets a second row.
    await writeAuditLog({
      req,
      action: 'DATA_EXPORTED',
      resourceType: 'credit_enrichment',
      metadata: {
        source: 'highsale',
        format: q.format,
        rowCount: rows.length,
        filters: {
          vertical: q.vertical ?? null,
          isQualified: q.isQualified ?? null,
          isQualifiedBnpl: q.isQualifiedBnpl ?? null,
          scoreMin: q.scoreMin ?? null,
          scoreMax: q.scoreMax ?? null,
          includeProtected: q.includeProtected,
        },
      },
    });
    if (q.includeProtected) {
      await writeAuditLog({
        req,
        action: 'PROTECTED_CLASS_READ',
        resourceType: 'credit_enrichment',
        metadata: {
          via: 'export',
          rowCount: rows.length,
          format: q.format,
        },
      });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const verticalTag = q.vertical ? `_${q.vertical}` : '';
    const protectedTag = q.includeProtected ? '_protected' : '';
    const filename = `highsale_snapshots${verticalTag}${protectedTag}_${timestamp}.${q.format}`;

    // Columns intentionally explicit — order + naming matters for SQL
    // joins downstream. Money columns are integer cents (matches the
    // schema reference). Demographics columns only added when allowed.
    const columns: Array<{ key: string; pick?: (r: (typeof rows)[number]) => unknown }> = [
      { key: 'snapshot_id', pick: (r) => r.id },
      { key: 'highsale_transaction_id', pick: (r) => r.highsaleTransactionId },
      { key: 'external_application_id', pick: (r) => r.externalApplicationId },
      { key: 'application_id', pick: (r) => r.applicationId },
      { key: 'org_id', pick: (r) => r.orgId },
      { key: 'vertical', pick: (r) => r.vertical },
      { key: 'pulled_at', pick: (r) => r.pulledAt.toISOString() },
      { key: 'received_at', pick: (r) => r.receivedAt.toISOString() },
      // PII as hashes only
      { key: 'consumer_email_hash', pick: (r) => r.consumerEmailHash.toString('hex') },
      { key: 'consumer_phone_hash', pick: (r) => r.consumerPhoneHash.toString('hex') },
      { key: 'date_of_birth_hash', pick: (r) => r.dateOfBirthHash.toString('hex') },
      // Stated income (already plain — not bureau data)
      { key: 'verifiable_income_cents', pick: (r) => r.verifiableIncomeCents },
      { key: 'rent_payment_cents', pick: (r) => r.rentPaymentCents },
      // Lookup
      { key: 'is_frozen', pick: (r) => r.isFrozen },
      { key: 'is_no_hit', pick: (r) => r.isNoHit },
      { key: 'is_address_append', pick: (r) => r.isAddressAppend },
      { key: 'is_address_no_hit', pick: (r) => r.isAddressNoHit },
      { key: 'is_insufficient_credit_data', pick: (r) => r.isInsufficientCreditData },
      // Grades
      { key: 'score', pick: (r) => r.score },
      { key: 'credit_line_grade', pick: (r) => r.creditLineGrade },
      { key: 'revolving_lines_grade', pick: (r) => r.revolvingLinesGrade },
      { key: 'oldest_account_grade', pick: (r) => r.oldestAccountGrade },
      { key: 'late_payments_grade', pick: (r) => r.latePaymentsGrade },
      { key: 'collections_grade', pick: (r) => r.collectionsGrade },
      { key: 'new_lines_grade', pick: (r) => r.newLinesGrade },
      { key: 'utilization_grade', pick: (r) => r.utilizationGrade },
      { key: 'recent_inquiries_grade', pick: (r) => r.recentInquiriesGrade },
      { key: 'average_grade', pick: (r) => r.averageGrade },
      // Decision rates
      { key: 'decline_rate', pick: (r) => r.declineRate.toString() },
      { key: 'approval_rate', pick: (r) => r.approvalRate.toString() },
      // Inquiry quotas
      { key: 'personal_remaining_inquiries', pick: (r) => r.personalRemainingInquiries },
      { key: 'personal_loan_remaining_inquiries', pick: (r) => r.personalLoanRemainingInquiries },
      { key: 'business_remaining_inquiries', pick: (r) => r.businessRemainingInquiries },
      // Credit profile
      { key: 'total_lines', pick: (r) => r.totalLines },
      { key: 'total_revolving_lines', pick: (r) => r.totalRevolvingLines },
      { key: 'available_credit_cents', pick: (r) => r.availableCreditCents },
      { key: 'average_credit_limit_cents', pick: (r) => r.averageCreditLimitCents },
      { key: 'total_credit_limit_cents', pick: (r) => r.totalCreditLimitCents },
      { key: 'oldest_credit_age', pick: (r) => r.oldestCreditAge },
      { key: 'average_credit_age', pick: (r) => r.averageCreditAge },
      { key: 'total_inquiries', pick: (r) => r.totalInquiries },
      { key: 'utilization', pick: (r) => r.utilization.toString() },
      { key: 'late_payments', pick: (r) => r.latePayments },
      { key: 'collections', pick: (r) => r.collections },
      { key: 'trended_income_cents', pick: (r) => r.trendedIncomeCents },
      { key: 'trended_debt_cents', pick: (r) => r.trendedDebtCents },
      // Qualification
      { key: 'is_qualified', pick: (r) => r.isQualified },
      { key: 'dq_reasons', pick: (r) => r.dqReasons.join(';') },
      { key: 'confidence_score', pick: (r) => r.confidenceScore.toString() },
      { key: 'funding_estimate_cents', pick: (r) => r.fundingEstimateCents },
      { key: 'is_qualified_bnpl', pick: (r) => r.isQualifiedBnpl },
      { key: 'confidence_score_bnpl', pick: (r) => r.confidenceScoreBnpl.toString() },
      { key: 'funding_estimate_bnpl_cents', pick: (r) => r.fundingEstimateBnplCents },
      { key: 'is_qualified_consumer_loan', pick: (r) => r.isQualifiedConsumerLoan },
      {
        key: 'funding_estimate_consumer_loan_cents',
        pick: (r) => r.fundingEstimateConsumerLoanCents,
      },
      // Tradeline detail
      { key: 'num_satisfactory_trade_lines', pick: (r) => r.numSatisfactoryTradeLines },
      {
        key: 'num_trade_lines_opened_in_last_6_months',
        pick: (r) => r.numTradeLinesOpenedInLast6Months,
      },
      {
        key: 'months_since_most_recent_delinquency',
        pick: (r) => r.monthsSinceMostRecentDelinquency,
      },
      {
        key: 'num_pr_bankruptcies_in_last_24_months',
        pick: (r) => r.numPrBankruptciesInLast24Months,
      },
      { key: 'total_monthly_obligation_cents', pick: (r) => r.totalMonthlyObligationCents },
      {
        key: 'num_third_party_collections_with_balance',
        pick: (r) => r.numThirdPartyCollectionsWithBalance,
      },
      { key: 'num_open_home_equity_loan_trades', pick: (r) => r.numOpenHomeEquityLoanTrades },
      {
        key: 'total_credit_union_credit_lines_in_last_12_months',
        pick: (r) => r.totalCreditUnionCreditLinesInLast12Months,
      },
      {
        key: 'total_balance_of_open_credit_union_trade_lines_in_last_12_months_cents',
        pick: (r) => r.totalBalanceOfOpenCreditUnionTradeLinesInLast12MonthsCents,
      },
      {
        key: 'months_since_most_recent_credit_union_trade_opened',
        pick: (r) => r.monthsSinceMostRecentCreditUnionTradeOpened,
      },
      {
        key: 'total_balance_of_open_revolving_trades_in_last_12_months_cents',
        pick: (r) => r.totalBalanceOfOpenRevolvingTradesInLast12MonthsCents,
      },
      {
        key: 'utilization_of_open_revolving_trades_in_last_12_months',
        pick: (r) => r.utilizationOfOpenRevolvingTradesInLast12Months.toString(),
      },
      { key: 'num_of_repo_trades', pick: (r) => r.numOfRepoTrades },
      { key: 'total_balance_of_repo_trades_cents', pick: (r) => r.totalBalanceOfRepoTradesCents },
      { key: 'num_of_retail_trades', pick: (r) => r.numOfRetailTrades },
      { key: 'num_of_open_retail_trades', pick: (r) => r.numOfOpenRetailTrades },
      { key: 'num_of_third_party_collections', pick: (r) => r.numOfThirdPartyCollections },
      {
        key: 'num_of_non_medical_third_party_collections',
        pick: (r) => r.numOfNonMedicalThirdPartyCollections,
      },
      {
        key: 'num_of_third_party_collections_in_the_last_36_months',
        pick: (r) => r.numOfThirdPartyCollectionsInTheLast36Months,
      },
      { key: 'num_of_student_loan_trades', pick: (r) => r.numOfStudentLoanTrades },
      { key: 'num_of_open_student_loan_trades', pick: (r) => r.numOfOpenStudentLoanTrades },
      {
        key: 'num_of_satisfactory_open_student_loan_trades',
        pick: (r) => r.numOfSatisfactoryOpenStudentLoanTrades,
      },
      {
        key: 'num_of_90_plus_days_past_due_student_loans',
        pick: (r) => r.numOf90PlusDaysPastDueStudentLoans,
      },
      { key: 'num_of_auth_user_trades', pick: (r) => r.numOfAuthUserTrades },
      {
        key: 'num_open_unsecured_installment_trades',
        pick: (r) => r.numOpenUnsecuredInstallmentTrades,
      },
      {
        key: 'total_open_unsecured_installment_trades_in_last_12_months',
        pick: (r) => r.totalOpenUnsecuredInstallmentTradesInLast12Months,
      },
      {
        key: 'percent_of_open_unsecured_installment_trades_gt_75_in_last_12_months',
        pick: (r) => r.percentOfOpenUnsecuredInstallmentTradesGt75InLast12Months.toString(),
      },
      {
        key: 'utilization_of_open_unsecured_verified_installment_trades_in_last_12_months',
        pick: (r) => r.utilizationOfOpenUnsecuredVerifiedInstallmentTradesInLast12Months.toString(),
      },
      // Adverse events
      { key: 'num_of_charge_offs', pick: (r) => r.numOfChargeOffs },
      { key: 'num_of_repos', pick: (r) => r.numOfRepos },
      { key: 'num_of_foreclosures', pick: (r) => r.numOfForeclosures },
      // ML
      { key: 'sale_confidence_score', pick: (r) => r.saleConfidenceScore.toString() },
    ];

    if (q.includeProtected) {
      columns.push(
        ...([
          { key: 'estimated_income_band', pick: (r) => r.estimatedIncomeBand },
          { key: 'number_of_children', pick: (r) => r.numberOfChildren },
          { key: 'marital_status', pick: (r) => r.maritalStatus },
          { key: 'occupation_group', pick: (r) => r.occupationGroup },
          { key: 'occupation', pick: (r) => r.occupation },
          { key: 'education', pick: (r) => r.education },
          { key: 'business_owner', pick: (r) => r.businessOwner },
          { key: 'gender', pick: (r) => r.gender },
          { key: 'net_worth', pick: (r) => r.netWorth },
          { key: 'estimated_current_home_value', pick: (r) => r.estimatedCurrentHomeValue },
          { key: 'ethnicity', pick: (r) => r.ethnicity },
          { key: 'ethnic_group', pick: (r) => r.ethnicGroup },
          { key: 'language', pick: (r) => r.language },
        ] as Array<{ key: string; pick: (r: (typeof rows)[number]) => unknown }>),
      );
    }

    if (q.format === 'json') {
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', attachmentHeader(filename));
      return rows.map((r) => {
        const obj: Record<string, unknown> = {};
        for (const c of columns) obj[c.key] = c.pick ? c.pick(r) : null;
        return obj;
      });
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', attachmentHeader(filename));
    return rowsToCsv(rows, columns);
  });
}
