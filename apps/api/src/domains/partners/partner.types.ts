import type { Partner } from '@prisma/client';
import { createHash } from 'node:crypto';
import type {
  PartnerInvestorResponse,
  PartnerResponse,
} from './partner.schemas.js';

export function toPartnerResponse(p: Partner): PartnerResponse {
  return {
    id: p.id,
    externalId: p.externalId,
    name: p.name,
    industry: p.industry,
    onboardingDate: p.onboardingDate.toISOString(),
    status: p.status,
    tier: p.tier,
    contractValue: p.contractValue.toString(),
    buzzpayRevSharePct: p.buzzpayRevSharePct.toString(),
    pixieDataPullCost: p.pixieDataPullCost.toString(),
    pixieChargeRate: p.pixieChargeRate.toString(),
    pixieMargin: p.pixieMargin.toString(),
    metadata: (p.metadata ?? {}) as Record<string, unknown>,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Deterministic anonymized label for investor scope. */
export function partnerLabel(partnerId: string): string {
  const h = createHash('sha256').update(partnerId).digest('hex');
  return `PARTNER-${h.slice(0, 8).toUpperCase()}`;
}

export function toPartnerInvestorResponse(p: Partner): PartnerInvestorResponse {
  return {
    id: p.id,
    label: partnerLabel(p.id),
    industry: p.industry,
    tier: p.tier,
    status: p.status,
    onboardingDate: p.onboardingDate.toISOString(),
  };
}
