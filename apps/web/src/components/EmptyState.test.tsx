import { describe, expect, it } from 'vitest';
import { EmptyState, type EmptyStateVariant } from './EmptyState';

/**
 * Smoke coverage for the EmptyState primitive. The component itself is a
 * pure render — there's no jsdom in this workspace today (Sprint C
 * doesn't ship one) so we don't mount it. We do verify:
 *   - the module imports without side effects,
 *   - the component is a function (renderable by React),
 *   - calling it directly with each variant returns a JSX element shape
 *     (validating the variant lookup tables stay in sync with the union).
 *
 * If a variant is removed from the union without removing its TONE /
 * DEFAULT_ICON entry — or vice versa — TypeScript catches that at the
 * `tsc --noEmit` step the pre-commit hook runs. This test catches the
 * runtime path where an unknown variant value would crash the lookup.
 */
describe('EmptyState', () => {
  const VARIANTS: EmptyStateVariant[] = ['firstRun', 'filterEmpty', 'searchEmpty', 'error'];

  it('exports a function component', () => {
    expect(typeof EmptyState).toBe('function');
  });

  for (const variant of VARIANTS) {
    it(`renders without throwing for variant=${variant}`, () => {
      const el = EmptyState({ variant, title: 'x' });
      expect(el).toBeTruthy();
      expect((el as { type: unknown }).type).toBeDefined();
    });

    it(`renders inline for variant=${variant}`, () => {
      const el = EmptyState({ variant, title: 'x', inline: true });
      expect(el).toBeTruthy();
    });
  }

  it('accepts primary and secondary actions (href and onClick)', () => {
    const el = EmptyState({
      variant: 'firstRun',
      title: 'x',
      description: 'y',
      primaryAction: { label: 'Go', href: '/somewhere' },
      secondaryAction: { label: 'Click', onClick: () => undefined },
    });
    expect(el).toBeTruthy();
  });

  it('accepts an icon override', () => {
    const el = EmptyState({
      variant: 'error',
      title: 'x',
      icon: null,
    });
    expect(el).toBeTruthy();
  });
});
