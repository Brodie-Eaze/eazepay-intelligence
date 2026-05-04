import type { Application } from '@prisma/client';
import type { ApplicationResponse } from './application.schemas.js';
import { decryptPII } from '../../shared/utils/encryption.js';

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
    .map((part) => (part.length === 0 ? part : `${part[0]}${'*'.repeat(Math.max(0, part.length - 1))}`))
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
  } catch {
    // If decryption fails (rotation gap, corruption), surface masked placeholders;
    // never throw — the dashboard's read path must remain available.
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

export function decryptApplicationPii(a: Application): { name: string; email: string; phone: string } {
  return {
    name: decryptPII(a.consumerNameCiphertext),
    email: decryptPII(a.consumerEmailCiphertext),
    phone: decryptPII(a.consumerPhoneCiphertext),
  };
}
