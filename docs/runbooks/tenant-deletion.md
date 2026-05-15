# Runbook — Tenant deletion (RTBF Mode B)

**Audience:** platform staff (`PlatformRole = SUPER`).
**Authority:** ADR-001 §9, ADR-002 §9, GDPR Art. 17, AU APP 11.
**Reversibility:** within `pendingDays` (default 7) — irreversible after.

This runbook covers org-level cryptoshred — destroying every DEK that
protects an organisation's PII, rendering all that data permanently
unrecoverable. Use it when an organisation churns, exercises a contractual
right of erasure, or must be cryptoshredded for incident-response reasons.

For individual consumer RTBF (one person, multiple orgs), use the existing
`/admin/rtbf` flow (Mode A — row-level cryptoshred).

---

## Pre-flight checklist

Before running ANY of the steps below:

- [ ] Confirm the request is authorised in writing (contract clause, board
      decision, regulator order, or signed customer instruction).
- [ ] Confirm legal hold is NOT in effect for this org's data. Once the
      KMS keys are destroyed, no legal hold can recover the data.
- [ ] Confirm financial-records retention obligations (AU AFS 7-year rule
      etc.) have been satisfied or are stored in a separate, non-tenant-keyed
      system. Cryptoshred destroys the entire org's encrypted state.
- [ ] Take a Postgres snapshot tagged with the org slug + timestamp. The
      snapshot is itself only useful with KMS access; once the keys are
      destroyed the snapshot is useless. Preserve it anyway as belt-and-
      braces.
- [ ] Notify the on-call engineer + the org's primary contact.

---

## The flow

### Step 1 — Soft-delete the org

Performs the workflow gate. The cryptoshred endpoint refuses to act on
an active org, so this step is a deliberate "are you sure" milestone.

```bash
curl -X DELETE "$API/api/v1/platform/orgs/$ORG_ID" \
  -H "Cookie: $SUPER_USER_COOKIE" \
  -H "X-CSRF-Token: $CSRF"
```

Effect: `organizations.deleted_at = now()`. The org disappears from
`/platform/orgs` lists and from member dashboards. No data destroyed yet.

### Step 2 — Wait + double-check

Take at least one full business day. Confirm no users have raised "I lost
access" tickets. Confirm the snapshot from pre-flight exists. Confirm
nobody has started using the org's data downstream (Phase 2 warehouse,
Phase 4 identity graph) since the soft-delete.

### Step 3 — Cryptoshred

The destructive call. **Triple-check the org slug** before running.

```bash
ORG_SLUG="acme-corp"  # use the actual slug — must match exactly

curl -X POST "$API/api/v1/platform/orgs/$ORG_ID/cryptoshred" \
  -H "Cookie: $SUPER_USER_COOKIE" \
  -H "X-CSRF-Token: $CSRF" \
  -H "X-Cryptoshred-Confirm: $ORG_SLUG" \
  -H "Content-Type: application/json" \
  -d '{"pendingDays": 7}'
```

What this does (atomically per ADR-002 §9):

1. Marks every `tenant_encryption_keys` row for the org `isActive=false`,
   `retiredAt=now()`. New encrypts can no longer use these DEKs.
2. Calls `kms:DisableKey` for each unique KMS KEK referenced by those
   rows — immediate effect: existing ciphertext can no longer be
   unwrapped. Decrypts start failing within seconds.
3. Calls `kms:ScheduleKeyDeletion` with `pendingDays` (default 7, max
   30). After the window, the KMS keys are permanently destroyed.
4. Evicts every matching keyId from the in-process `DekCache`. No cached
   plaintext lingers.
5. Revokes every `refresh_token` whose owning user has a membership in
   this org. Active sessions are forcibly logged out.
6. Writes a `PLATFORM_ORG_CRYPTOSHRED` audit row with:
   - `pendingDays`
   - count of DEKs deactivated
   - list of KMS KEK ARNs scheduled for deletion
   - any per-KEK errors (KMS failures, retry needed)

The audit row is itself protected: Postgres role-level REVOKE UPDATE/DELETE
on `audit_logs` makes the cryptoshred event permanently traceable.

### Step 4 — Verify

```sql
-- All DEKs for the org should be inactive + retired.
SELECT id, purpose, version, is_active, retired_at
  FROM tenant_encryption_keys
 WHERE org_id = '$ORG_ID';

-- No active sessions for any of the org's members.
SELECT COUNT(*) FROM refresh_tokens rt
  JOIN memberships m ON m.user_id = rt.user_id
 WHERE m.org_id = '$ORG_ID' AND rt.revoked_at IS NULL;

-- The cryptoshred audit row is present + immutable.
SELECT id, action, created_at, metadata
  FROM audit_logs
 WHERE action = 'PLATFORM_ORG_CRYPTOSHRED'
   AND org_id = '$ORG_ID'
 ORDER BY created_at DESC LIMIT 1;
```

In AWS Console (or via `aws kms list-keys`), confirm each scheduled KMS
key shows `KeyState = PendingDeletion` with the expected
`DeletionDate`.

### Step 5 — During the pending window (cancel-ability)

If the customer reverses the decision within `pendingDays`:

```bash
aws kms cancel-key-deletion --key-id $KEK_ARN
aws kms enable-key --key-id $KEK_ARN
```

Then re-activate the latest DEK row in `tenant_encryption_keys`:

```sql
UPDATE tenant_encryption_keys
   SET is_active = true, retired_at = NULL
 WHERE id = (
   SELECT id FROM tenant_encryption_keys
    WHERE org_id = '$ORG_ID' AND purpose = 'PII'
    ORDER BY version DESC LIMIT 1
 );
```

Lift the org's soft-delete:

```sql
UPDATE organizations SET deleted_at = NULL WHERE id = '$ORG_ID';
```

Manually re-issue refresh tokens or have users sign in again. Existing
sessions remain revoked.

After the window elapses, none of the above is possible.

### Step 6 — Final cleanup (optional, after KMS deletion completes)

Ciphertext rows in `applications`, `audit_logs.metadata`, etc. are now
permanently unreadable. They can remain for foreign-key integrity, or
you can hard-delete them. The choice is policy:

- **Keep:** application + revenue rows preserve referential integrity
  for cross-tenant analytics (Phase 2 warehouse). The PII columns are
  unreadable bytes so no privacy concern.
- **Delete:** if storage cost or audit posture demands it, run a
  one-shot script that truncates the tenant's rows after a quarantine
  period. Document in this runbook.

---

## Failure modes + recovery

| Failure                                          | Likely cause                                                                                                     | Action                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Endpoint returns 400 with "must be soft-deleted" | Forgot Step 1                                                                                                    | DELETE first, retry                                                                                       |
| Endpoint returns 400 with "confirmation header"  | Slug typo                                                                                                        | Triple-check, retry                                                                                       |
| `disableKey` errors in audit metadata            | IAM denied / key in unexpected state                                                                             | Check the row's `kek_key_id`, retry the KMS calls manually via AWS CLI; the DB row is already deactivated |
| `scheduleKeyDeletion` errors                     | Same                                                                                                             | As above. The DEK is unreadable (disabled) but not yet scheduled — schedule manually in AWS Console       |
| Sessions still active after cryptoshred          | Revoke happens at Postgres `refresh_tokens` level — JWT access tokens persist for up to `JWT_ACCESS_TTL_SECONDS` | Wait the access TTL (15 min default), or push a Redis deny-list entry per blast-radius §3.5               |

---

## What this runbook does NOT cover

- Per-consumer RTBF (use Mode A: `/admin/rtbf`)
- Cross-region replica cryptoshred (multi-region is Phase 7)
- Backup destruction in S3/Glacier (production-deploy runbook)
- Customer notification / regulator filing — handled separately
