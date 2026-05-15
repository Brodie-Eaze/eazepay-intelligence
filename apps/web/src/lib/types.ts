// Shared response types — mirrors the backend Zod schemas.
// Will be replaced by `openapi-typescript` generated `packages/shared-types/api.ts`
// once the OpenAPI emission pipeline runs in CI.

export type UserRole = 'ADMIN' | 'OPERATOR' | 'INVESTOR' | 'VIEWER';
export type AuthScope = 'standard' | 'investor';

export interface UserResponse {
  id: string;
  email: string;
  role: UserRole;
  scope: AuthScope;
  mfaEnabled: boolean;
}

export interface SessionResponse {
  user: UserResponse;
  csrfToken: string;
  accessTokenExpiresAt: string;
}

export interface OverviewResponse {
  totalRevenue: string;
  approvalRate: string;
  fundingRate: string;
  activePartnerCount: number;
  pixiePullsLast24h: number;
  momRevenueDelta: string;
  windowFrom: string;
  windowTo: string;
  generatedAt: string;
}

export interface PartnerResponse {
  id: string;
  externalId: string;
  name: string;
  industry: string;
  onboardingDate: string;
  status: 'ACTIVE' | 'INACTIVE' | 'CHURNED';
  tier: 'BRONZE' | 'SILVER' | 'GOLD';
  contractValue: string;
  pixieMargin: string;
  createdAt: string;
}
export interface PartnerInvestorResponse {
  id: string;
  label: string;
  industry: string;
  tier: 'BRONZE' | 'SILVER' | 'GOLD';
  status: 'ACTIVE' | 'INACTIVE' | 'CHURNED';
  onboardingDate: string;
}

export interface RevenueByStreamRow {
  bucket: string;
  stream: 'PIXIE' | 'MICAMP';
  amount: string;
}

export interface WaterfallRow {
  lenderName: string;
  lenderTier: 'PRIME' | 'NEAR_PRIME' | 'SUBPRIME' | 'CARD_LINKED';
  submitted: number;
  approved: number;
  declined: number;
  funded: number;
  approvalRate: string;
  fundingRate: string;
  avgApr: string | null;
  totalFunded: string;
}

export type WsEvent =
  | {
      type: 'application.created';
      at: string;
      partnerId: string;
      partnerLabel: string;
      applicationId: string;
    }
  | {
      type: 'application.status_changed';
      at: string;
      partnerId: string;
      partnerLabel: string;
      applicationId: string;
      from: string;
      to: string;
    }
  | {
      type: 'lender.decision';
      at: string;
      partnerId: string;
      partnerLabel: string;
      lender: string;
      outcome: 'APPROVED' | 'DECLINED';
      amount: string | null;
    }
  | {
      type: 'funding.completed';
      at: string;
      partnerId: string;
      partnerLabel: string;
      amount: string;
    }
  | { type: 'funding.failed'; at: string; partnerId: string; partnerLabel: string; reason: string }
  | {
      type: 'revenue.event';
      at: string;
      partnerId: string;
      partnerLabel: string;
      stream: 'PIXIE' | 'MICAMP';
      eventType: string;
      amount: string;
    }
  | {
      type: 'pixie.usage_reported';
      at: string;
      partnerId: string;
      partnerLabel: string;
      pulls: number;
    }
  | { type: 'partner.onboarded'; at: string; partnerId: string; partnerLabel: string; tier: string }
  | {
      type: 'partner.tier_changed';
      at: string;
      partnerId: string;
      partnerLabel: string;
      from: string;
      to: string;
    }
  | { type: 'system.heartbeat'; at: string; serverTime: string };
