# data-warehouse

dbt project for the EazePay Intelligence warehouse.

This is the **analytics** layer. It reads from the operational Postgres
(`eazepay_platform`, written by the Fastify API + Prisma) and builds:

- **staging** views — light renaming + PII-stripping + JSON parsing over
  the raw operational tables. Materialised as views in
  `analytics_staging`.
- **marts** tables — denormalised, query-optimised rollups that power
  the Overview page and per-business drill-downs. Materialised as
  tables in `analytics_marts` (rebuilt by the nightly dbt run).

The warehouse **never decrypts PII**. The staging layer drops encrypted
PII columns and keeps only HMAC hashes for joins. Flows that need
decrypted PII must call the operational API behind its auth + audit +
KMS boundary — not query the warehouse.

## Layout

```
data-warehouse/
├── dbt_project.yml
├── profiles.example.yml          ← copy to ~/.dbt/profiles.yml
├── models/
│   ├── sources.yml               ← declares the operational tables
│   ├── staging/
│   │   ├── schema.yml
│   │   ├── stg_organizations.sql
│   │   ├── stg_partners.sql
│   │   ├── stg_applications.sql
│   │   ├── stg_lender_decisions.sql
│   │   └── stg_revenue_events.sql
│   └── marts/
│       ├── schema.yml
│       ├── mart_group_revenue.sql        ← holdco MTD/TTM
│       ├── mart_per_business_revenue.sql ← per-business monthly
│       └── mart_business_funnel.sql      ← per-business funnel
└── README.md
```

## Local setup

```bash
# 1. install dbt (Postgres adapter)
pipx install dbt-postgres   # or: pip install dbt-postgres

# 2. copy profile
cp profiles.example.yml ~/.dbt/profiles.yml
# edit ~/.dbt/profiles.yml — set password + (for prod) the replica host

# 3. verify connection + sources
cd data-warehouse
dbt debug
dbt source freshness

# 4. build everything
dbt build         # = run + test
```

## Production target

Production should point dbt at the **read replica**, never the primary,
to keep analytics load off the operational write path.

The dbt service account needs:

- `SELECT` on `public.*` (the operational schema)
- `CREATE` on `analytics_staging` and `analytics_marts`
- `USAGE` on both schemas

It does **not** need `eazepay_app` role membership — it reads as a
warehouse-only role that bypasses RLS, because mart queries cross orgs.

## Launch-business scoping

The 7 launch businesses are flagged via `stg_organizations.is_launch_business`:

| Slug                 | Group                   | Notes                          |
| -------------------- | ----------------------- | ------------------------------ |
| `medpay`             | Point-of-sale BNPL      | Medical / dental               |
| `tradepay`           | Point-of-sale BNPL      | Trade services                 |
| `coachpay`           | Point-of-sale BNPL      | Coaching                       |
| `aurean-ai`          | Aurean Holdings         | AI operations layer            |
| `aurean-recruitment` | Aurean Holdings         | Talent placement               |
| `micamp-processing`  | Payments infrastructure | Card-processing rail           |
| `highsale`           | Payments infrastructure | Credit-data scoring (EZ Check) |

All marts filter on this flag so sandbox/test tenants don't pollute
portfolio numbers.

To onboard a new launch business: add the slug in two places —
`models/staging/stg_organizations.sql` and the `active_org_slugs` var
in `dbt_project.yml`.

## Schedule

Nightly via cron / Airflow / GitHub Actions (TBD — see PLATFORM_V2
Phase 11). Until then, run `dbt build` manually before reviewing the
Overview page.
