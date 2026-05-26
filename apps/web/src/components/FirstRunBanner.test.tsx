import { describe, expect, it } from 'vitest';
import { FirstRunBanner } from './FirstRunBanner';

/**
 * Smoke coverage for the FirstRunBanner. There is no jsdom in this
 * workspace so we don't mount it — we just guard that the module loads
 * and the export is the component function. Hydration/visibility logic
 * is intentionally covered manually (and by the typecheck) until we
 * adopt @testing-library/react in a later sprint.
 */
describe('FirstRunBanner', () => {
  it('exports a function component', () => {
    expect(typeof FirstRunBanner).toBe('function');
  });
});
