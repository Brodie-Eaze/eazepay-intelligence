import type { Application } from '@prisma/client';
import type { ApplicationResponse } from './application.schemas.js';
import { decryptPII } from '../../shared/utils/encryption.js';
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

/** Decrypt PII once and emit a masked-by-default response. */
export function toApplicationResponse(a: Application): ApplicationResponse {
  let nameMasked = '*****';
  let emailMasked = '*****';
  let phoneMasked = '****';
  try {
    nameMasked = maskName(decryptPII(a.consumerNameCiphertext));
    emailMasked = maskEmail(decryptPII(a.consumerEmailCiphertext));
    phoneMasked = maskPhone(decryptPII(a.consumerPhoneCiphertext));
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

export function decryptApplicationPii(a: Application): {
  name: string;
  email: string;
  phone: string;
} {
  return {
    name: decryptPII(a.consumerNameCiphertext),
    email: decryptPII(a.consumerEmailCiphertext),
    phone: decryptPII(a.consumerPhoneCiphertext),
  };
}
