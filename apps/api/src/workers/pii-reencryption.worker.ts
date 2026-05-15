import { startTelemetry } from '../config/telemetry.js';
startTelemetry({ serviceName: 'eazepay-intelligence-worker-pii-reencryption' });

/**
 * v1 → v2 PII re-encryption worker (Phase 3 continued).
 *
 * What this does
 *   For every Application row whose `consumerNameCiphertext[0]` is the v1
 *   envelope version byte (0x01), this worker:
 *     1. Decrypts the three PII envelopes (name, email, phone) under the
 *        legacy global PII_ENCRYPTION_KEY.
 *     2. Re-encrypts each plaintext under the row's org-specific DEK via
 *        `encryptForOrg(orgId)`.
 *     3. Writes all three columns back in a single UPDATE.
 *   Then it moves to the next batch. Idempotent — already-v2 rows are
 *   skipped because we filter on version byte.
 *
 * Why this is necessary
 *   Cryptoshred can only delete a tenant's data when their PII is wrapped
 *   under their per-tenant DEK. Under v1 the cipher key is global, so
 *   tenant-scoped data destruction is impossible — DELETE FROM applications
 *   leaves all backups recoverable with the global key. Once every row
 *   is v2, dropping the tenant's DEK in tenant_encryption_keys actually
 *   makes the data unrecoverable. This is the technical foundation for
 *   the cryptoshred-on-RTBF guarantee.
 *
 * Operating envelope
 *   Default: batches of 100, sleep 5s between batches. At those rates a
 *   million-row table drains in ~15h. Tune via env:
 *     - PII_REENCRYPT_BATCH_SIZE (default 100)
 *     - PII_REENCRYPT_SLEEP_MS (default 5000)
 *     - PII_REENCRYPT_MAX_PARALLEL (default 8)
 *
 * Idempotence + crash safety
 *   The version byte check makes restarts safe — partially-processed
 *   batches just resume from the next v1 row. Failures within a batch
 *   are logged with the application id; one bad row never blocks the
 *   queue (the bad row is skipped and the worker proceeds).
 *
 * Run as a separate process: `pnpm --filter api worker:pii-reencryption`.
 * Run it once after Phase 3 lands, monitor, then turn off when the v1
 * residual count is zero (admin query: SELECT count(*) FROM applications
 * WHERE substring(consumer_name_ciphertext from 1 for 1) = '\\x01';).
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getLogger } from '../config/logger.js';
import { getPrisma } from '../config/database.js';
import { decryptPII } from '../shared/utils/encryption.js';
import { encryptForOrg, ENVELOPE_VERSION_V2 } from '../shared/kms/tenant-dek.js';

const BATCH_SIZE = Number(process.env.PII_REENCRYPT_BATCH_SIZE ?? 100);
const SLEEP_MS = Number(process.env.PII_REENCRYPT_SLEEP_MS ?? 5_000);
const MAX_PARALLEL = Number(process.env.PII_REENCRYPT_MAX_PARALLEL ?? 8);

interface V1Row {
  id: string;
  org_id: string;
  consumer_name_ciphertext: Buffer;
  consumer_email_ciphertext: Buffer;
  consumer_phone_ciphertext: Buffer;
}

async function processBatch(prisma: PrismaClient): Promise<number> {
  const log = getLogger();
  // Pull a batch of v1 rows. We compare the first byte to the v2 sentinel
  // — anything not v2 is candidate. Postgres bytea substring is 1-indexed.
  const rows = await prisma.$queryRaw<V1Row[]>(Prisma.sql`
    SELECT id, org_id, consumer_name_ciphertext, consumer_email_ciphertext,
           consumer_phone_ciphertext
    FROM applications
    WHERE substring(consumer_name_ciphertext from 1 for 1) <> ${Buffer.from([ENVELOPE_VERSION_V2])}::bytea
    ORDER BY created_at ASC
    LIMIT ${BATCH_SIZE}
  `);

  if (rows.length === 0) return 0;

  let upgraded = 0;
  let skipped = 0;
  // Process up to MAX_PARALLEL rows concurrently. Each row makes ~3 KMS
  // calls on first encrypt (DEK cache miss); subsequent same-org rows
  // hit the cache and skip KMS.
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) return;
        try {
          // Decrypt under v1 (global key).
          const name = decryptPII(row.consumer_name_ciphertext);
          const email = decryptPII(row.consumer_email_ciphertext);
          const phone = decryptPII(row.consumer_phone_ciphertext);
          // Re-encrypt under per-org DEK (v2).
          const [nameCt, emailCt, phoneCt] = await Promise.all([
            encryptForOrg(prisma, name, row.org_id),
            encryptForOrg(prisma, email, row.org_id),
            encryptForOrg(prisma, phone, row.org_id),
          ]);
          await prisma.application.update({
            where: { id: row.id },
            data: {
              consumerNameCiphertext: nameCt,
              consumerEmailCiphertext: emailCt,
              consumerPhoneCiphertext: phoneCt,
            },
          });
          upgraded++;
        } catch (err) {
          // Bad row — log loudly with a stable errorId and skip. Common
          // causes: corrupted ciphertext, missing DEK for org (which
          // shouldn't happen post-Phase 1, but defensive).
          skipped++;
          log.error(
            {
              err: err instanceof Error ? err.message : String(err),
              errorId: 'pii_reencrypt.row_failed',
              applicationId: row.id,
              orgId: row.org_id,
            },
            'pii_reencrypt.row_failed — manual investigation needed',
          );
        }
      }
    }),
  );

  log.info({ upgraded, skipped, batch: rows.length }, 'pii_reencrypt.batch.done');
  return rows.length;
}

async function main(): Promise<void> {
  const log = getLogger();
  log.info(
    { batch: BATCH_SIZE, sleepMs: SLEEP_MS, parallel: MAX_PARALLEL },
    'pii_reencrypt.worker.start',
  );
  const prisma = getPrisma();
  let running = true;
  const stop = (signal: NodeJS.Signals): void => {
    log.info({ signal }, 'pii_reencrypt.worker.shutdown');
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (running) {
    try {
      const processed = await processBatch(prisma);
      if (processed === 0) {
        // Drained — sleep longer and recheck. Operators can stop the
        // worker when the v1 residual count is zero.
        log.info({}, 'pii_reencrypt.idle');
        await new Promise((r) => setTimeout(r, SLEEP_MS * 6));
      } else {
        await new Promise((r) => setTimeout(r, SLEEP_MS));
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'pii_reencrypt.loop_error',
      );
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

void main();
