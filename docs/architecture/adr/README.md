# Architecture Decision Records

Every load-bearing technical decision in EazePay Intelligence is recorded here. ADRs are immutable once `Status: ACCEPTED`. A new decision that overrides an older one creates a new ADR and links to the predecessor with `Supersedes: ADR-NNN`.

## Why ADRs

A codebase without ADRs is a codebase that drifts. Six months from now, no one — including the original author — will remember why we picked AWS KMS over GCP KMS, why we used path-based org routing instead of subdomains, why the consumer email hash uses HMAC instead of SHA-256. ADRs are the institutional memory.

The rule: if a future engineer might reasonably ask "why did they do it _this_ way?" — there must be an ADR they can find.

## Lifecycle

```
PROPOSED → ACCEPTED → (superseded by ADR-NNN) → SUPERSEDED
        ↘ REJECTED
```

Once `ACCEPTED`, an ADR is never edited except for typos and adding a `Supersedes` link. Don't go back and "update" an ADR with new context — write a new one.

## Format

```markdown
# ADR-NNN — Short noun phrase

**Status:** PROPOSED | ACCEPTED | REJECTED | SUPERSEDED
**Date:** YYYY-MM-DD
**Deciders:** Brodie (and any co-authors)
**Supersedes:** ADR-MMM (only if applicable)

## Context

What's the situation? What's the problem? What constraints are we working under?

## Decision

We will do X. State it crisply.

## Reasoning

Why X over the alternatives? What trade-offs are we accepting?

## Consequences

What changes because of this decision? What new work does it create? What does it foreclose?

## Alternatives considered

What did we look at and reject? Why?

## Open questions

(Optional) Things we deferred. Each should have an owner or a "decide-by" date.
```

## Index

| #   | Title                                            | Status   | Date       | Phase |
| --- | ------------------------------------------------ | -------- | ---------- | ----- |
| 000 | This process                                     | ACCEPTED | 2026-05-08 | —     |
| 001 | Multi-tenancy model (Organization + Membership)  | PROPOSED | 2026-05-08 | 1     |
| 002 | Per-tenant envelope encryption (KMS-wrapped DEK) | PROPOSED | 2026-05-08 | 1     |
| 003 | Outbox sweeper RLS carve-out (SOC2 PI-019)       | ACCEPTED | 2026-05-31 | 1.6   |
| 004 | CDC + warehouse architecture                     | DRAFT    | —          | 2     |

(More to follow as decisions land.)
