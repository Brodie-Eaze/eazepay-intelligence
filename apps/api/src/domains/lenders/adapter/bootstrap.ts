/**
 * Lender adapter boot wiring (GAP-101).
 *
 * Registers every adapter the running process knows about. Called once
 * at boot from src/index.ts (API) + each worker that touches the
 * registry.
 *
 * Today only the `MockLenderAdapter` ships. When a real lender
 * integration lands, add its `register*Adapter(...)` call here and
 * supply credentials via env.
 */
import { registerLenderAdapter } from './lender-adapter-registry.js';
import { MockLenderAdapter } from './mock-lender-adapter.js';

let booted = false;

export function bootstrapLenderAdapters(): void {
  if (booted) return;
  booted = true;
  // Mock adapter is always-on in dev + test + prod (until at least one
  // real adapter ships). Keeps `/lenders/waterfall` non-empty out-of-
  // the-box and gives integration tests a deterministic fixture.
  registerLenderAdapter(new MockLenderAdapter());
}
