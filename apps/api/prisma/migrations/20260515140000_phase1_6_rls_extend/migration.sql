-- Phase 1.6 — extend RLS policies to all tables retrofitted in Phase 1.
--
-- Migration 20260508220000 enabled RLS on 6 tenant tables (memberships,
-- user_invitations, api_tokens, audit_logs, webhook_credentials,
-- tenant_encryption_keys). Phase 1 (20260515120000) added org_id to ~20
-- more tables but didn't extend the RLS coverage. This migration:
--
--   1. ENABLE ROW LEVEL SECURITY on every Phase-1-retrofitted table.
--   2. Create a uniform policy on each: rows pass if either
--      `org_id = current_setting('app.org_id', TRUE)` OR
--      `current_setting('app.platform_staff', TRUE) = 'true'`.
--      Application sets the GUC at the start of every tenant-scoped
--      transaction via `withTenantSession`; platform-staff routes set
--      the bypass GUC and write a PLATFORM_CROSS_TENANT_ACCESS audit row.
--   3. Stay on ENABLE (not FORCE) so the table owner / migration role
--      still bypasses — ENABLE applies to non-BYPASSRLS roles only. The
--      separate 20260515150000_phase1_6_eazepay_app_role migration creates
--      the eazepay_app runtime role with NOBYPASSRLS so production reads
--      are subject to these policies.

-- ─── partners ──────────────────────────────────────────────────────────────
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
CREATE POLICY "partners_tenant_isolation" ON partners
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── applications ──────────────────────────────────────────────────────────
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "applications_tenant_isolation" ON applications
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── lender_decisions ──────────────────────────────────────────────────────
ALTER TABLE lender_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lender_decisions_tenant_isolation" ON lender_decisions
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── revenue_events ────────────────────────────────────────────────────────
ALTER TABLE revenue_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "revenue_events_tenant_isolation" ON revenue_events
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── pixie_metrics ─────────────────────────────────────────────────────────
ALTER TABLE pixie_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pixie_metrics_tenant_isolation" ON pixie_metrics
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── revenue_aggregations ──────────────────────────────────────────────────
ALTER TABLE revenue_aggregations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "revenue_aggregations_tenant_isolation" ON revenue_aggregations
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── webhook_events ────────────────────────────────────────────────────────
-- Webhook signature middleware needs to read the (orgId, source, key)
-- compound unique BEFORE setting the tenant GUC (the lookup IS what
-- resolves orgId). The webhook-signature-lookup escape hatch covers that.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "webhook_events_tenant_isolation" ON webhook_events
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
    OR current_setting('app.webhook_signature_lookup', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
    OR current_setting('app.webhook_signature_lookup', TRUE) = 'true'
  );

-- ─── outbox_events ─────────────────────────────────────────────────────────
-- The outbox SWEEPER worker has no per-request tenant context; it batches
-- across orgs. Allow rows without enforcing tenancy on the sweeper path
-- via a dedicated GUC; tenant-scoped writes still must match org_id.
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "outbox_events_tenant_isolation" ON outbox_events
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
    OR current_setting('app.outbox_sweeper', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
    OR current_setting('app.outbox_sweeper', TRUE) = 'true'
  );

-- ─── exports ───────────────────────────────────────────────────────────────
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "exports_tenant_isolation" ON exports
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── webhook_subscriptions + webhook_deliveries ────────────────────────────
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "webhook_subscriptions_tenant_isolation" ON webhook_subscriptions
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "webhook_deliveries_tenant_isolation" ON webhook_deliveries
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── refresh_tokens ────────────────────────────────────────────────────────
-- Bearer-auth/cookie-auth flows look these up BEFORE any tenant context
-- exists. The bearer_lookup escape hatch covers that.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "refresh_tokens_tenant_isolation" ON refresh_tokens
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
    OR current_setting('app.bearer_lookup', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
    OR current_setting('app.bearer_lookup', TRUE) = 'true'
  );

-- ─── notification_channels + alert_rules + alerts ──────────────────────────
ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification_channels_tenant_isolation" ON notification_channels
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alert_rules_tenant_isolation" ON alert_rules
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alerts_tenant_isolation" ON alerts
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── notes + tags + tag_assignments + saved_views ──────────────────────────
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notes_tenant_isolation" ON notes
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tags_tenant_isolation" ON tags
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE tag_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tag_assignments_tenant_isolation" ON tag_assignments
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY "saved_views_tenant_isolation" ON saved_views
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── scheduled_reports + report_runs ───────────────────────────────────────
ALTER TABLE scheduled_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scheduled_reports_tenant_isolation" ON scheduled_reports
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "report_runs_tenant_isolation" ON report_runs
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── cases + rtbf_requests ─────────────────────────────────────────────────
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cases_tenant_isolation" ON cases
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE rtbf_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rtbf_requests_tenant_isolation" ON rtbf_requests
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── credit_enrichments ────────────────────────────────────────────────────
ALTER TABLE credit_enrichments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "credit_enrichments_tenant_isolation" ON credit_enrichments
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

-- ─── portfolio_* ───────────────────────────────────────────────────────────
ALTER TABLE portfolio_verticals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_verticals_tenant_isolation" ON portfolio_verticals
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE portfolio_businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_businesses_tenant_isolation" ON portfolio_businesses
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE portfolio_financial_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_financial_periods_tenant_isolation" ON portfolio_financial_periods
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE portfolio_revenue_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_revenue_channels_tenant_isolation" ON portfolio_revenue_channels
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE portfolio_product_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_product_lines_tenant_isolation" ON portfolio_product_lines
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE portfolio_unit_economics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_unit_economics_tenant_isolation" ON portfolio_unit_economics
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE portfolio_cohorts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_cohorts_tenant_isolation" ON portfolio_cohorts
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );

ALTER TABLE portfolio_headcount ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portfolio_headcount_tenant_isolation" ON portfolio_headcount
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );
