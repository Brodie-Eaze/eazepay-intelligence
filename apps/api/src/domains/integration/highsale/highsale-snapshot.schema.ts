/**
 * Wire envelope for HighSale credit-data snapshots.
 *
 * HighSale ("EZ Check") is built into every application form on
 * medpay/tradepay/coachpay. On submit, HighSale pulls 12 data points
 * per applicant and pushes them here so the warehouse can see the
 * credit profile of every applicant in the funnel.
 *
 * **This schema is v0.1** — only the 4 fields Brodie confirmed are
 * typed today. The remaining 8 fields land in `rawPayload` until the
 * HighSale API docs are in the repo, at which point we promote each
 * additional field to a typed column.
 *
 * See: docs/architecture/data-warehouse-overview.md § Plane 2
 *      docs/integration/highsale-snapshot-contract.md (forthcoming)
 */
import { z } from 'zod';

/**
 * Vertical the application came from. Resolved from the merchant's
 * `ProductBrand` enum on the App side and stamped onto the snapshot
 * so we don't need a second join to attribute later.
 */
export const HighsaleVerticalSchema = z.enum(['medpay', 'tradepay', 'coachpay']);
export type HighsaleVertical = z.infer<typeof HighsaleVerticalSchema>;

/**
 * The 12 data points pulled per applicant. Four typed; eight reserved.
 *
 * Numbers ride as numbers (not strings) — keep them in the API contract
 * if HighSale's JSON spec emits them stringly; convert at the boundary.
 * Money fields are integer cents to avoid float arithmetic anywhere
 * downstream (consistent with how `RevenueEvent.amount` is stored).
 */
export const HighsaleSnapshotPayloadSchema = z
  .object({
    // The 4 fields Brodie confirmed today. Names are best-guess until
    // the API spec is in the repo — rename without ceremony when it is.
    creditScore: z.number().int().min(0).max(999),
    availableCreditCents: z.number().int().nonnegative(),
    tradelineCount: z.number().int().nonnegative(),
    annualIncomeCents: z.number().int().nonnegative(),

    // Catch-all for the other 8 data points until the spec lands. Keep
    // the raw bytes so we never lose information; reconcile to typed
    // columns once we know what's coming.
    rawPayload: z.record(z.unknown()).default({}),
  })
  .strict();

export type HighsaleSnapshotPayload = z.infer<typeof HighsaleSnapshotPayloadSchema>;

/**
 * Outer envelope wrapping the payload. Same shape pattern as the
 * EazePay App envelope so a Stripe-style signed POST can carry both
 * over the same plumbing.
 */
export const HighsaleSnapshotEnvelopeSchema = z
  .object({
    /** Delivery row uuidv7 from the HighSale side. */
    id: z.string().uuid(),
    /** Stable per-snapshot id. Idempotency key for the warehouse. */
    snapshotId: z.string().uuid(),
    /** The application this snapshot was pulled for. Must match an
     *  `applications.external_application_id` already in the warehouse,
     *  OR will be reconciled when the App `application.*` event lands. */
    externalApplicationId: z.string().min(1).max(128),
    /** Which BNPL brand the application came from. */
    vertical: HighsaleVerticalSchema,
    /** When HighSale pulled the snapshot. */
    pulledAt: z.string().datetime(),
    /** The 12 data points. */
    data: HighsaleSnapshotPayloadSchema,
  })
  .strict();

export type HighsaleSnapshotEnvelope = z.infer<typeof HighsaleSnapshotEnvelopeSchema>;
