# Architecture · EazePay Intelligence

> This file used to be a 570-line dump of architecture-plus-ADRs. It's
> been retired. The architecture lives in three current docs — read
> them in this order.

## Canonical sources

1. **The mental model.** What the warehouse is, where data comes from,
   how revenue is attributed:
   [`docs/architecture/data-warehouse-overview.md`](architecture/data-warehouse-overview.md)
2. **The phased roadmap.** What's built, what's queued, what's
   deferred, and the operating principles every PR is held against:
   [`docs/PLATFORM_V2.md`](PLATFORM_V2.md)
3. **The decisions that constrain everything else.** Numbered,
   immutable, decision-by-decision:
   [`docs/architecture/adr/`](architecture/adr/)

Cross-repo contracts live in [`docs/integration/`](integration/).
Step-by-step ops in [`docs/runbooks/`](runbooks/). PII / SOC 2 framing
in [`docs/governance/`](governance/). Queued removals (BuzzPay phase C,
PE-MIS, fx) in [`docs/cuts/`](cuts/).

For the per-app shape (Fastify on `apps/api`, Next.js on `apps/web`,
dbt on `data-warehouse/`), read the matching README:
[`apps/api/README.md`](../apps/api/README.md) ·
[`apps/web/README.md`](../apps/web/README.md) ·
[`data-warehouse/README.md`](../data-warehouse/README.md).

For the day-one orientation, read [`HANDOVER.md`](../HANDOVER.md).
