'use client';

/**
 * Returns the className string for the hover-lift utility. Defined in
 * `motion.css` — on hover the element translates up 2px and gains a
 * soft shadow built from the Eaze `line` token. 150ms ease-out.
 *
 * Reduced-motion: the CSS rule itself removes the transition + hover
 * state, so this hook needs no JS branching.
 *
 * Most callers can just write `className="hover-lift"` directly; the
 * hook exists so consumers composing many utility classes have a
 * typed, discoverable handle on the motion-system identifier (and so
 * the barrel export from `motion/` covers it).
 *
 * @example
 *   const lift = useHoverLift();
 *   return <div className={`card ${lift}`}>{...}</div>;
 *
 * @example
 *   // Equivalent direct form:
 *   <div className="card hover-lift">{...}</div>
 */
export function useHoverLift(): string {
  return 'hover-lift';
}
