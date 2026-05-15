-- Phase 1 tenant-table retrofit — add `org_id` to every tenant-scoped table.
--
-- WHY:
--   The architecture (ADR-001 §3 + docs/architecture/data-warehouse-overview.md)
--   says every tenant-owned table carries `org_id` so:
--     1. The application layer can `where: { orgId }` filter at the ORM,
--     2. Postgres RLS (migration 20260508220000) can enforce isolation at
--        the DB,
--     3. Cryptoshred / RTBF can locate every row belonging to one org.
--
--   In reality ~25 tables carry no `org_id` column at all today, which means
--   none of those three guarantees hold for them. Application, LenderDecision,
--   RevenueEvent, PixieMetric, Partner, every Portfolio* table, Note, Tag,
--   SavedView, ScheduledReport, ReportRun, Case, Alert, AlertRule,
--   NotificationChannel, RtbfRequest, WebhookEvent, OutboxEvent, Export,
--   WebhookSubscription, WebhookDelivery, RefreshToken — none are tenant-
--   scoped at the storage layer. Until a non-Brodie user joins a second org,
--   the bug is latent. The moment one does, it's a cross-tenant data leak.
--
-- WHAT THIS MIGRATION DOES:
--   1. Add `org_id uuid` column (nullable initially, NOT NULL after backfill).
--   2. Backfill from the partner relationship where possible (Application
--      via partner_id, LenderDecision via partner_id, RevenueEvent via
--      partner_id, PixieMetric via partner_id). Otherwise default to the
--      bootstrap default org (slug='default', seeded by migration 20260508145000).
--   3. Set NOT NULL.
--   4. Add foreign key to organizations(id).
--   5. Add composite indexes `(org_id, created_at DESC)` for list-paginated
--      tables.
--   6. Drop global unique constraints that should have been per-org
--      (Partner.external_id, RevenueEvent.(source, idempotency_key),
--      WebhookEvent.(source, idempotency_key), Tag.name,
--      CreditEnrichment.highsale_transaction_id) and replace with per-org
--      composite uniques.
--
-- WHAT THIS MIGRATION DOES NOT DO (deliberately separate):
--   - Does NOT create a postgres role or alter grants/revokes.
--   - Does NOT enable RLS on the retrofitted tables.
--   - Does NOT switch from ENABLE to FORCE RLS.
--   Those steps require explicit operator approval because they change
--   the active runtime privilege model. They live in subsequent migrations
--   (20260515130000_eazepay_app_role and 20260515140000_phase1_rls_extend).

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Resolve bootstrap org id (used as backfill default for tables that
--    don't reference a partner). The bootstrap org was created by migration
--    20260508145000_bootstrap_default_org_row with slug='default'.
-- ───────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  bootstrap_org_id uuid;
BEGIN
  SELECT id INTO bootstrap_org_id FROM organizations WHERE slug = 'default';
  IF bootstrap_org_id IS NULL THEN
    RAISE EXCEPTION 'Phase 1 retrofit requires bootstrap org with slug=default (see migration 20260508145000)';
  END IF;
  -- Stash it in a temp config so subsequent statements can reference it.
  PERFORM set_config('eazepay.bootstrap_org_id', bootstrap_org_id::text, false);
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Partner — add org_id, backfill from bootstrap, then NOT NULL + FK.
--    Partner is the root of the application/revenue tree; every downstream
--    table backfills from Partner.org_id.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE partners ADD COLUMN org_id uuid;
UPDATE partners SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE partners ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE partners ADD CONSTRAINT partners_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX partners_org_id_created_at_idx ON partners (org_id, created_at DESC);

-- Drop global unique on external_id; add per-org composite. A vendor's
-- externalId is unique within their tenant, not across all tenants.
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_external_id_key;
CREATE UNIQUE INDEX partners_org_external_id_uniq ON partners (org_id, external_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Application — backfill from Partner.org_id (every Application has a
--    partner_id, NOT NULL).
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE applications ADD COLUMN org_id uuid;
UPDATE applications a SET org_id = p.org_id FROM partners p WHERE a.partner_id = p.id AND a.org_id IS NULL;
ALTER TABLE applications ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE applications ADD CONSTRAINT applications_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX applications_org_id_created_at_idx ON applications (org_id, created_at DESC);
CREATE INDEX applications_org_id_status_idx ON applications (org_id, status);
CREATE INDEX applications_org_id_email_hash_idx ON applications (org_id, consumer_email_hash);

-- External application id is unique within a partner's namespace; across
-- tenants the same externalId can legitimately collide.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_external_application_id_key;
CREATE UNIQUE INDEX applications_org_external_id_uniq ON applications (org_id, external_application_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. LenderDecision — backfill via partner_id.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE lender_decisions ADD COLUMN org_id uuid;
UPDATE lender_decisions ld SET org_id = p.org_id FROM partners p WHERE ld.partner_id = p.id AND ld.org_id IS NULL;
ALTER TABLE lender_decisions ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE lender_decisions ADD CONSTRAINT lender_decisions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX lender_decisions_org_id_created_at_idx ON lender_decisions (org_id, created_at DESC);
CREATE INDEX lender_decisions_org_id_funding_status_idx ON lender_decisions (org_id, funding_status, funding_timestamp);

-- Per-org external_decision_id
ALTER TABLE lender_decisions DROP CONSTRAINT IF EXISTS lender_decisions_external_decision_id_key;
CREATE UNIQUE INDEX lender_decisions_org_external_decision_id_uniq ON lender_decisions (org_id, external_decision_id) WHERE external_decision_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. RevenueEvent — append-only ledger, backfill via partner_id.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE revenue_events ADD COLUMN org_id uuid;
UPDATE revenue_events re SET org_id = p.org_id FROM partners p WHERE re.partner_id = p.id AND re.org_id IS NULL;
ALTER TABLE revenue_events ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE revenue_events ADD CONSTRAINT revenue_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX revenue_events_org_id_effective_at_idx ON revenue_events (org_id, effective_at DESC);

-- Drop global unique on (source, idempotency_key); add per-org variant.
ALTER TABLE revenue_events DROP CONSTRAINT IF EXISTS revenue_events_source_idemp_key;
CREATE UNIQUE INDEX revenue_events_org_source_idemp_key ON revenue_events (org_id, source, idempotency_key);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. PixieMetric — backfill via partner_id.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE pixie_metrics ADD COLUMN org_id uuid;
UPDATE pixie_metrics pm SET org_id = p.org_id FROM partners p WHERE pm.partner_id = p.id AND pm.org_id IS NULL;
ALTER TABLE pixie_metrics ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE pixie_metrics ADD CONSTRAINT pixie_metrics_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX pixie_metrics_org_id_period_start_idx ON pixie_metrics (org_id, period_start DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. RevenueAggregation — backfill bootstrap; add org_id for per-tenant rollups.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE revenue_aggregations ADD COLUMN org_id uuid;
UPDATE revenue_aggregations SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE revenue_aggregations ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE revenue_aggregations ADD CONSTRAINT revenue_aggregations_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX revenue_aggregations_org_period_idx ON revenue_aggregations (org_id, period_start DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 8. WebhookEvent — backfill from active WebhookCredential per source.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE webhook_events ADD COLUMN org_id uuid;
WITH active_cred AS (
  SELECT DISTINCT ON (source) source, org_id
  FROM webhook_credentials
  WHERE is_active
  ORDER BY source, created_at DESC
)
UPDATE webhook_events we SET org_id = c.org_id FROM active_cred c WHERE we.source = c.source AND we.org_id IS NULL;
UPDATE webhook_events SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE webhook_events ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX webhook_events_org_received_at_idx ON webhook_events (org_id, received_at DESC);

ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_source_idempotency_key_key;
CREATE UNIQUE INDEX webhook_events_org_source_idemp_key_uniq ON webhook_events (org_id, source, idempotency_key);

-- ───────────────────────────────────────────────────────────────────────────
-- 9. CreditEnrichment already has org_id. Adjust the highsale_transaction_id
--    unique constraint to be per-org.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE credit_enrichments DROP CONSTRAINT IF EXISTS credit_enrichments_highsale_transaction_id_key;
CREATE UNIQUE INDEX credit_enrichments_org_highsale_tx_uniq ON credit_enrichments (org_id, highsale_transaction_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 10. WebhookCredential — partial unique on (source, signing_secret_hash)
--     WHERE is_active = true.
-- ───────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX webhook_credentials_source_active_secret_uniq
  ON webhook_credentials (source, signing_secret_hash)
  WHERE is_active = true;

-- ───────────────────────────────────────────────────────────────────────────
-- 11-13. OutboxEvent, Export, WebhookSubscription, WebhookDelivery
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE outbox_events ADD COLUMN org_id uuid;
UPDATE outbox_events SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE outbox_events ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX outbox_events_org_published_at_idx ON outbox_events (org_id, published_at, created_at);

ALTER TABLE exports ADD COLUMN org_id uuid;
UPDATE exports SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE exports ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE exports ADD CONSTRAINT exports_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX exports_org_id_created_at_idx ON exports (org_id, created_at DESC);

ALTER TABLE webhook_subscriptions ADD COLUMN org_id uuid;
UPDATE webhook_subscriptions SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE webhook_subscriptions ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE webhook_subscriptions ADD CONSTRAINT webhook_subscriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX webhook_subscriptions_org_active_idx ON webhook_subscriptions (org_id, is_active);

ALTER TABLE webhook_deliveries ADD COLUMN org_id uuid;
UPDATE webhook_deliveries wd SET org_id = ws.org_id FROM webhook_subscriptions ws WHERE wd.subscription_id = ws.id AND wd.org_id IS NULL;
UPDATE webhook_deliveries SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE webhook_deliveries ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX webhook_deliveries_org_status_idx ON webhook_deliveries (org_id, status, scheduled_for);

-- ───────────────────────────────────────────────────────────────────────────
-- 14. Note / Tag / TagAssignment / SavedView
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE notes ADD COLUMN org_id uuid;
UPDATE notes SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE notes ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE notes ADD CONSTRAINT notes_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX notes_org_resource_idx ON notes (org_id, resource_type, resource_id, created_at DESC);

ALTER TABLE tags ADD COLUMN org_id uuid;
UPDATE tags SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE tags ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE tags ADD CONSTRAINT tags_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_name_key;
CREATE UNIQUE INDEX tags_org_name_uniq ON tags (org_id, name);

ALTER TABLE tag_assignments ADD COLUMN org_id uuid;
UPDATE tag_assignments ta SET org_id = t.org_id FROM tags t WHERE ta.tag_id = t.id AND ta.org_id IS NULL;
ALTER TABLE tag_assignments ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE tag_assignments ADD CONSTRAINT tag_assignments_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX tag_assignments_org_resource_idx ON tag_assignments (org_id, resource_type, resource_id);

ALTER TABLE saved_views ADD COLUMN org_id uuid;
UPDATE saved_views SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE saved_views ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE saved_views ADD CONSTRAINT saved_views_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX saved_views_org_resource_idx ON saved_views (org_id, resource_type);

-- ───────────────────────────────────────────────────────────────────────────
-- 15. ScheduledReport / ReportRun
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE scheduled_reports ADD COLUMN org_id uuid;
UPDATE scheduled_reports SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE scheduled_reports ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE scheduled_reports ADD CONSTRAINT scheduled_reports_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX scheduled_reports_org_next_run_idx ON scheduled_reports (org_id, next_run_at, is_active);

ALTER TABLE report_runs ADD COLUMN org_id uuid;
UPDATE report_runs rr SET org_id = sr.org_id FROM scheduled_reports sr WHERE rr.scheduled_report_id = sr.id AND rr.org_id IS NULL;
ALTER TABLE report_runs ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX report_runs_org_created_at_idx ON report_runs (org_id, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 16. Alerts subsystem
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE notification_channels ADD COLUMN org_id uuid;
UPDATE notification_channels SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE notification_channels ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX notification_channels_org_active_idx ON notification_channels (org_id, is_active);

ALTER TABLE alert_rules ADD COLUMN org_id uuid;
UPDATE alert_rules SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE alert_rules ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX alert_rules_org_active_idx ON alert_rules (org_id, is_active);

ALTER TABLE alerts ADD COLUMN org_id uuid;
UPDATE alerts a SET org_id = ar.org_id FROM alert_rules ar WHERE a.rule_id = ar.id AND a.org_id IS NULL;
ALTER TABLE alerts ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE alerts ADD CONSTRAINT alerts_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX alerts_org_fired_at_idx ON alerts (org_id, fired_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 17. Case
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE cases ADD COLUMN org_id uuid;
UPDATE cases SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE cases ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE cases ADD CONSTRAINT cases_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX cases_org_status_idx ON cases (org_id, status, opened_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 18. RtbfRequest
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE rtbf_requests ADD COLUMN org_id uuid;
UPDATE rtbf_requests SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE rtbf_requests ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE rtbf_requests ADD CONSTRAINT rtbf_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX rtbf_requests_org_status_idx ON rtbf_requests (org_id, status, requested_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 19. RefreshToken
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE refresh_tokens ADD COLUMN org_id uuid;
WITH first_member AS (
  SELECT DISTINCT ON (user_id) user_id, org_id
  FROM memberships
  ORDER BY user_id, created_at ASC
)
UPDATE refresh_tokens rt SET org_id = fm.org_id FROM first_member fm WHERE rt.user_id = fm.user_id AND rt.org_id IS NULL;
UPDATE refresh_tokens SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE refresh_tokens ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX refresh_tokens_org_user_revoked_idx ON refresh_tokens (org_id, user_id, revoked_at);

-- ───────────────────────────────────────────────────────────────────────────
-- 20. Portfolio* tables
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE portfolio_verticals ADD COLUMN org_id uuid;
UPDATE portfolio_verticals SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE portfolio_verticals ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE portfolio_verticals ADD CONSTRAINT portfolio_verticals_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX portfolio_verticals_org_idx ON portfolio_verticals (org_id);

ALTER TABLE portfolio_businesses ADD COLUMN org_id uuid;
UPDATE portfolio_businesses SET org_id = current_setting('eazepay.bootstrap_org_id')::uuid WHERE org_id IS NULL;
ALTER TABLE portfolio_businesses ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE portfolio_businesses ADD CONSTRAINT portfolio_businesses_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX portfolio_businesses_org_status_idx ON portfolio_businesses (org_id, status);

ALTER TABLE portfolio_financial_periods ADD COLUMN org_id uuid;
UPDATE portfolio_financial_periods pfp SET org_id = pb.org_id FROM portfolio_businesses pb WHERE pfp.business_slug = pb.slug AND pfp.org_id IS NULL;
ALTER TABLE portfolio_financial_periods ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE portfolio_financial_periods ADD CONSTRAINT portfolio_financial_periods_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX portfolio_financial_periods_org_period_idx ON portfolio_financial_periods (org_id, period_start DESC);

ALTER TABLE portfolio_revenue_channels ADD COLUMN org_id uuid;
UPDATE portfolio_revenue_channels prc SET org_id = pb.org_id FROM portfolio_businesses pb WHERE prc.business_slug = pb.slug AND prc.org_id IS NULL;
ALTER TABLE portfolio_revenue_channels ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE portfolio_revenue_channels ADD CONSTRAINT portfolio_revenue_channels_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX portfolio_revenue_channels_org_idx ON portfolio_revenue_channels (org_id, as_of DESC);

ALTER TABLE portfolio_product_lines ADD COLUMN org_id uuid;
UPDATE portfolio_product_lines ppl SET org_id = pb.org_id FROM portfolio_businesses pb WHERE ppl.business_slug = pb.slug AND ppl.org_id IS NULL;
ALTER TABLE portfolio_product_lines ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE portfolio_product_lines ADD CONSTRAINT portfolio_product_lines_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX portfolio_product_lines_org_idx ON portfolio_product_lines (org_id, as_of DESC);

ALTER TABLE portfolio_unit_economics ADD COLUMN org_id uuid;
UPDATE portfolio_unit_economics pue SET org_id = pb.org_id FROM portfolio_businesses pb WHERE pue.business_slug = pb.slug AND pue.org_id IS NULL;
ALTER TABLE portfolio_unit_economics ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE portfolio_unit_economics ADD CONSTRAINT portfolio_unit_economics_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX portfolio_unit_economics_org_idx ON portfolio_unit_economics (org_id);

ALTER TABLE portfolio_cohorts ADD COLUMN org_id uuid;
UPDATE portfolio_cohorts pc SET org_id = pb.org_id FROM portfolio_businesses pb WHERE pc.business_slug = pb.slug AND pc.org_id IS NULL;
ALTER TABLE portfolio_cohorts ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE portfolio_cohorts ADD CONSTRAINT portfolio_cohorts_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX portfolio_cohorts_org_idx ON portfolio_cohorts (org_id, cohort_month DESC);

ALTER TABLE portfolio_headcount ADD COLUMN org_id uuid;
UPDATE portfolio_headcount ph SET org_id = pb.org_id FROM portfolio_businesses pb WHERE ph.business_slug = pb.slug AND ph.org_id IS NULL;
ALTER TABLE portfolio_headcount ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE portfolio_headcount ADD CONSTRAINT portfolio_headcount_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id);
CREATE INDEX portfolio_headcount_org_idx ON portfolio_headcount (org_id, as_of DESC);
