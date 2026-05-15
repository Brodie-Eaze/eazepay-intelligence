/**
 * KMS bootstrap factory.
 *
 * Picks the right `KmsClient` implementation based on environment, registers
 * it via `setKmsClient` so the rest of the app never imports a concrete
 * client. Call once at process bootstrap (api server, worker, seed script).
 *
 * Selection rules (first match wins):
 *   1. `process.env.KMS_DRIVER === 'aws'`     → AwsKmsClient
 *   2. `process.env.KMS_DRIVER === 'local'`   → LocalKmsClient
 *   3. NODE_ENV === 'production'              → AwsKmsClient (fail-fast if
 *                                                AWS_KMS_KEY_ARN unset)
 *   4. otherwise                              → LocalKmsClient (dev/test)
 *
 * The explicit KMS_DRIVER env override is the operational escape hatch:
 *   - dev wants to test the AWS integration → KMS_DRIVER=aws
 *   - staging is in production NODE_ENV but using a separate KMS account →
 *     credentials handle it; KMS_DRIVER not needed
 *   - CI runs with NODE_ENV=test and the local in-process KEK; KMS_DRIVER
 *     not needed
 *
 * The factory does NOT memoise — registering twice in the same process is
 * a programming error (whoever called `setKmsClient` first owns the
 * lifetime). The factory is a one-shot bootstrap helper.
 */
import { setKmsClient } from './tenant-dek.js';
import type { KmsClient } from './kms-client.interface.js';

export type KmsDriver = 'aws' | 'local';

/**
 * Resolve the driver to use without instantiating it. Useful for log-once
 * bootstrap messages.
 */
export function resolveKmsDriver(): KmsDriver {
  const explicit = process.env.KMS_DRIVER;
  if (explicit === 'aws') return 'aws';
  if (explicit === 'local') return 'local';
  if (process.env.NODE_ENV === 'production') return 'aws';
  return 'local';
}

/**
 * Construct + register the KMS client according to the driver rules.
 * Returns the constructed client for callers that want to inspect it
 * (e.g. structured-log the chosen driver at boot).
 */
export async function bootstrapKms(): Promise<{ driver: KmsDriver; client: KmsClient }> {
  const driver = resolveKmsDriver();
  let client: KmsClient;
  if (driver === 'aws') {
    if (!process.env.AWS_KMS_KEY_ARN) {
      throw new Error(
        'bootstrapKms: AWS_KMS_KEY_ARN is required when KMS driver is aws (NODE_ENV=production or KMS_DRIVER=aws)',
      );
    }
    const { AwsKmsClient } = await import('./aws-kms-client.js');
    client = new AwsKmsClient();
  } else {
    if (!process.env.KMS_DEV_SECRET) {
      throw new Error(
        'bootstrapKms: KMS_DEV_SECRET is required for the local KMS driver (must be ≥32 chars)',
      );
    }
    const { LocalKmsClient } = await import('./local-kms-client.js');
    client = new LocalKmsClient();
  }
  setKmsClient(client);
  return { driver, client };
}
