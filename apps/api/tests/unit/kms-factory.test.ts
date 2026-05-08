/**
 * KMS factory selection rules — pure unit tests, no AWS connection
 * actually opened. The factory's `bootstrapKms` is only run in the
 * "local" branch here; the "aws" branch is exercised by checking
 * `resolveKmsDriver` and the AWS_KMS_KEY_ARN guard separately so we
 * don't need real AWS credentials in CI.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveKmsDriver, bootstrapKms } from '../../src/shared/kms/kms-factory.js';
import { __resetKmsClientForTests } from '../../src/shared/kms/tenant-dek.js';

const ORIGINAL = { ...process.env };

beforeAll(() => {
  process.env.KMS_DEV_SECRET = 'a'.repeat(32);
});

beforeEach(() => {
  __resetKmsClientForTests();
});

afterEach(() => {
  for (const key of ['KMS_DRIVER', 'NODE_ENV', 'AWS_KMS_KEY_ARN']) {
    if (ORIGINAL[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL[key];
    }
  }
});

describe('resolveKmsDriver', () => {
  it('explicit KMS_DRIVER=aws wins', () => {
    process.env.KMS_DRIVER = 'aws';
    process.env.NODE_ENV = 'development';
    expect(resolveKmsDriver()).toBe('aws');
  });

  it('explicit KMS_DRIVER=local wins even in production', () => {
    process.env.KMS_DRIVER = 'local';
    process.env.NODE_ENV = 'production';
    expect(resolveKmsDriver()).toBe('local');
  });

  it('NODE_ENV=production with no override → aws', () => {
    delete process.env.KMS_DRIVER;
    process.env.NODE_ENV = 'production';
    expect(resolveKmsDriver()).toBe('aws');
  });

  it('default in dev/test → local', () => {
    delete process.env.KMS_DRIVER;
    process.env.NODE_ENV = 'development';
    expect(resolveKmsDriver()).toBe('local');
  });
});

describe('bootstrapKms', () => {
  it('registers LocalKmsClient when local driver is selected', async () => {
    process.env.KMS_DRIVER = 'local';
    const { driver, client } = await bootstrapKms();
    expect(driver).toBe('local');
    expect(client).toBeDefined();
    // Sanity check: LocalKmsClient implements all KmsClient methods.
    expect(typeof client.generateDataKey).toBe('function');
    expect(typeof client.unwrapDataKey).toBe('function');
    expect(typeof client.scheduleKeyDeletion).toBe('function');
  });

  it('throws when KMS_DEV_SECRET is unset for local driver', async () => {
    process.env.KMS_DRIVER = 'local';
    const saved = process.env.KMS_DEV_SECRET;
    delete process.env.KMS_DEV_SECRET;
    try {
      await expect(bootstrapKms()).rejects.toThrow(/KMS_DEV_SECRET/);
    } finally {
      process.env.KMS_DEV_SECRET = saved;
    }
  });

  it('throws when AWS_KMS_KEY_ARN is unset for aws driver', async () => {
    process.env.KMS_DRIVER = 'aws';
    delete process.env.AWS_KMS_KEY_ARN;
    await expect(bootstrapKms()).rejects.toThrow(/AWS_KMS_KEY_ARN/);
  });
});
