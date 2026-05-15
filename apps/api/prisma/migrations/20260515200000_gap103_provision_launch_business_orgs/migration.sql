-- GAP-103/104/105 — provision the 7 launch-business orgs (production-safe).
--
-- The Aurean AI, Aurean Recruitment, and HighSale business-events
-- ingest paths fail-closed when the receiving org slug isn't in the
-- DB (see apps/api/src/shared/integration/business-webhook-ingest.ts).
-- Without this migration, every webhook from those sources returns
-- 401 on first prod deploy until someone manually upserts the rows —
-- a quiet 24-hour outage from a known issue.
--
-- Each org is idempotent (ON CONFLICT DO NOTHING) so this migration
-- re-runs safely (the dev seed used to do the same upserts but
-- prisma migrate deploy is the only path that runs in prod).
--
-- gen_random_uuid() vs uuid_generate_v7():
--   The schema's Organization.id uses gen_random_uuid() as default
--   (apps/api/prisma/migrations/20260508145000... · uuid_default()).
--   We mirror that here for consistency.

INSERT INTO organizations (id, slug, name, data_region, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'medpay',             'medpay',             'au', now(), now()),
  (gen_random_uuid(), 'tradepay',           'tradepay',           'au', now(), now()),
  (gen_random_uuid(), 'coachpay',           'coachpay',           'au', now(), now()),
  (gen_random_uuid(), 'aurean-ai',          'Aurean AI',          'au', now(), now()),
  (gen_random_uuid(), 'aurean-recruitment', 'Aurean Recruitment', 'au', now(), now()),
  (gen_random_uuid(), 'micamp-processing',  'MiCamp Processing',  'au', now(), now()),
  (gen_random_uuid(), 'highsale',           'HighSale',           'au', now(), now())
ON CONFLICT (slug) DO NOTHING;
