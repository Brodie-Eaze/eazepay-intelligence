import { describe, expect, it } from 'vitest';
import { partnerLabel } from '../../src/domains/partners/partner.types.js';

describe('partnerLabel', () => {
  it('produces a deterministic anonymized code', () => {
    const a = partnerLabel('00000000-0000-0000-0000-000000000001');
    const b = partnerLabel('00000000-0000-0000-0000-000000000001');
    expect(a).toBe(b);
    expect(a).toMatch(/^PARTNER-[A-F0-9]{8}$/);
  });

  it('produces different codes for different ids', () => {
    const a = partnerLabel('00000000-0000-0000-0000-000000000001');
    const b = partnerLabel('00000000-0000-0000-0000-000000000002');
    expect(a).not.toBe(b);
  });
});
