-- GAP-101 — lender_reporting_events
--
-- Append-only audit log of every interaction with a lender adapter:
-- submit, poll, error. Used by:
--   - the polling worker (`worker:lender-polling`) to back off on
--     repeated failures
--   - operators to debug an adapter integration
--   - the audit surface to demonstrate what data was sent to whom
--
-- Schema design:
--   - permanent flag distinguishes transient errors (retry) from
--     terminal ones (lender said "this application is permanently
--     ineligible"). The polling worker decays its interval based on this.
--   - payload is application-defined JSON; the application layer caps
--     to 8 KB at write time. No PII — the layer above the adapter
--     filters PII out of the payload before logging here.
--
-- Phase 1.6 RLS: the eazepay_app role gets standard tenant_isolation
-- on this table — included in the follow-up migration set when the
-- runtime role lands. Until then, table-owner reads/writes work.

CREATE TYPE "LenderReportingEventType" AS ENUM (
  'SUBMIT',
  'SUBMIT_FAILED',
  'POLL',
  'POLL_FAILED',
  'STATE_TRANSITION'
);

CREATE TABLE lender_reporting_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  application_id uuid,
  lender_slug text NOT NULL,
  external_decision_id text,
  type "LenderReportingEventType" NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  permanent boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lender_reporting_events_org_lender_observed_idx
  ON lender_reporting_events (org_id, lender_slug, observed_at DESC);
CREATE INDEX lender_reporting_events_application_observed_idx
  ON lender_reporting_events (application_id, observed_at DESC);
CREATE INDEX lender_reporting_events_external_decision_observed_idx
  ON lender_reporting_events (external_decision_id, observed_at DESC);

-- Phase 1.6 alignment: enable RLS + tenant_isolation policy. The same
-- pattern as the other Phase-1.6 tables — runtime role under
-- NOBYPASSRLS only sees its own org's rows; the sweeper escape GUC
-- isn't needed here because this table is never swept globally.
ALTER TABLE lender_reporting_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lender_reporting_events_tenant_isolation"
  ON lender_reporting_events
  FOR ALL
  USING (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  )
  WITH CHECK (
    org_id::text = current_setting('app.org_id', TRUE)
    OR current_setting('app.platform_staff', TRUE) = 'true'
  );
