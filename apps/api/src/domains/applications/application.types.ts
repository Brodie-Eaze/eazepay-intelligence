import type { Application, PrismaClient } from '@prisma/client';
import type { ApplicationResponse } from './application.schemas.js';
import { decryptPII } from '../../shared/utils/encryption.js';
import { decryptEnvelopeAuto } from '../../shared/kms/tenant-dek.js';
import { getLogger } from '../../config/logger.js';

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '*****';
  const head = user.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, user.length - 1))}@${domain}`;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function maskName(name: string): string {
  return name
    .split(/\s+/)
    .map((part) =>
      part.length === 0 ? part : `${part[0]}${'*'.repeat(Math.max(0, part.length - 1))}`,
    )
    .join(' ');
}

/**
 * Decrypt PII once and emit a masked-by-default response.
 *
 * Phase 3 continued: uses `decryptEnvelopeAuto` so both v1 (global key)
 * and v2 (per-org DEK) ciphertexts read correctly. Existing rows written
 * before per-org DEK rollout decode via the legacy path; new rows decode
 * via the per-tenant path. The Phase 3 background re-encryption worker
 * eventually flips every row to v2 — once it's drained, the v1 branch
 * dead-ends and can be removed.
 */
export async function toApplicationResponse(
  a: Application,
  prisma: PrismaClient,
): Promise<ApplicationResponse> {
  let nameMasked = '*****';
  let emailMasked = '*****';
  let phoneMasked = '****';
  try {
    const [n, e, p] = await Promise.all([
      decryptEnvelopeAuto(prisma, a.consumerNameCiphertext, decryptPII),
      decryptEnvelopeAuto(prisma, a.consumerEmailCiphertext, decryptPII),
      decryptEnvelopeAuto(prisma, a.consumerPhoneCiphertext, decryptPII),
    ]);
    nameMasked = maskName(n);
    emailMasked = maskEmail(e);
    phoneMasked = maskPhone(p);
  } catch (err) {
    // Decryption failure on the dashboard hot path. Surface masked
    // placeholders so the read path stays available — but ALWAYS log,
    // because "all customers show *****" with no signal is the
    // worst-class incident (KMS outage, DEK rotation regression,
    // ciphertext corruption). A per-org rate on this errorId in alerting
    // surfaces tenant-wide decrypt failures within minutes instead of
    // via customer ticket.
    getLogger().error(
      {
        err,
        errorId: 'PII_DECRYPT_FAILURE',
        applicationId: a.id,
        partnerId: a.partnerId,
      },
      'application.pii.decrypt_failed',
    );
  }
  return {
    id: a.id,
    partnerId: a.partnerId,
    externalApplicationId: a.externalApplicationId,
    consumerNameMasked: nameMasked,
    consumerEmailMasked: emailMasked,
    consumerPhoneMasked: phoneMasked,
    creditScore: a.creditScore,
    availableCredit: a.availableCredit?.toString() ?? null,
    notedAnnualIncome: a.notedAnnualIncome?.toString() ?? null,
    bankStatementsProvided: a.bankStatementsProvided,
    merchantPreapproval: a.merchantPreapproval,
    merchantPreapprovalAmount: a.merchantPreapprovalAmount?.toString() ?? null,
    consumerPreapproval: a.consumerPreapproval,
    consumerPreapprovalAmount: a.consumerPreapprovalAmount?.toString() ?? null,
    fundingEstimate: a.fundingEstimate?.toString() ?? null,
    propensityScore: a.propensityScore?.toString() ?? null,
    openLinesOfCredit: a.openLinesOfCredit,
    status: a.status,
    submittedAt: a.submittedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/**
 * Reveal-path Application PII (admin/operator only). Phase 3 continued:
 * uses `decryptEnvelopeAuto` so v1 + v2 ciphertexts both decrypt.
 */
export async function decryptApplicationPii(
  a: Application,
  prisma: PrismaClient,
): Promise<{ name: string; email: string; phone: string }> {
  const [name, email, phone] = await Promise.all([
    decryptEnvelopeAuto(prisma, a.consumerNameCiphertext, decryptPII),
    decryptEnvelopeAuto(prisma, a.consumerEmailCiphertext, decryptPII),
    decryptEnvelopeAuto(prisma, a.consumerPhoneCiphertext, decryptPII),
  ]);
  return { name, email, phone };
}
