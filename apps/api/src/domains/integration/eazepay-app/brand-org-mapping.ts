/**
 * Resolve EazePay App's `Merchant.brand` (ProductBrand enum) to an
 * EazePay Intelligence `Organization.slug` (and from there to its id).
 *
 * App's brand vocabulary (apps/api/prisma/schema.prisma lines 133–138):
 *   medpay, tradepay, coachpay, direct
 *
 * Intelligence's launch-business slugs (data-warehouse/models/staging/
 * stg_organizations.sql + dbt_project.yml vars.active_org_slugs):
 *   aurean-os, aurean-recruitment, coachpay, tradepay, medpay
 *
 * Three brands map 1:1. `direct` has no current home — quarantine until
 * product decides which holdco org owns "direct" revenue.
 *
 * Aurean OS + Aurean Recruitment have no representation in App; they
 * never appear on this codepath. They ingest via their own native
 * adapters (TBD).
 *
 * See docs/integration/eazepay-app-contract.md § Brand → Org resolution.
 */

export type AppBrandCode = 'medpay' | 'tradepay' | 'coachpay' | 'direct';

/**
 * Static mapping — kept in code (not in a DB table) for now because:
 *   a) the universe of brands is tiny + slow-changing,
 *   b) version-controlling the mapping is more auditable than DB rows,
 *   c) deploys are coordinated with App's enum changes anyway.
 *
 * When the mapping becomes dynamic (e.g. self-serve onboarding adds new
 * brands), promote this to a `brand_org_map` table with a seed.
 */
const BRAND_TO_ORG_SLUG: Record<AppBrandCode, string | null> = {
  medpay: 'medpay',
  tradepay: 'tradepay',
  coachpay: 'coachpay',
  // No mapping yet — events quarantine to the default org until product
  // decides. Throwing here would mean dropping every `direct` event,
  // which is worse than landing them in a holding pen.
  direct: null,
};

export interface BrandResolution {
  /** The Intelligence org slug, or null if the brand should quarantine. */
  orgSlug: string | null;
  /** True if the mapping is intentional (medpay/tradepay/coachpay).
   *  False if we quarantined (direct) or didn't recognise the brand. */
  resolved: boolean;
  /** Echoed back for audit + observability. */
  brand: string;
}

export function resolveBrandToOrgSlug(brand: string): BrandResolution {
  if (brand in BRAND_TO_ORG_SLUG) {
    const slug = BRAND_TO_ORG_SLUG[brand as AppBrandCode];
    return { orgSlug: slug, resolved: slug !== null, brand };
  }
  // Unknown brand — fail open (quarantine) but flag for audit. An
  // unknown brand means App added a brand we don't know about yet;
  // dropping the event silently is worse than holding it for triage.
  return { orgSlug: null, resolved: false, brand };
}
