/**
 * Motion system barrel.
 *
 * Every primitive here:
 *   - respects `prefers-reduced-motion: reduce` (short-circuits to instant)
 *   - uses transform + opacity only (no layout-shifting animation)
 *   - is SSR-safe (no hydration mismatch)
 *   - keeps Eaze accent reserved for state, not animation color
 *
 * Import `./motion.css` once at the app root (already wired in
 * `src/app/globals.css`) so the keyframes + utilities are available.
 */
export { PageTransition } from './PageTransition';
export { StaggerList } from './StaggerList';
export { RevealOnScroll } from './RevealOnScroll';
export { MetricNumber } from './MetricNumber';
export { useHoverLift } from './useHoverLift';
export { usePrefersReducedMotion } from './usePrefersReducedMotion';
