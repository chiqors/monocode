// G4 (issue #21): deterministic clock + id allocator seam.
//
// The host reads time through `now()` and allocates ids through `uuid()`
// instead of direct `Date.now()`/`crypto.randomUUID()` in the deterministic
// core (normalizer, node reducer, store) and the G-series host modules.
// Production uses the real providers by default; tests inject a fixed clock /
// id allocator (the Effect `TestClock`/`Random` analogue) so replaying the
// same transcript twice produces IDENTICAL durable state without real timers
// or waits.
import { randomUUID } from "node:crypto";

let clock: () => number = () => Date.now();
let ids: () => string = () => randomUUID();

/** Current host time (real by default; injectable in tests). */
export function now(): number {
  return clock();
}

/** Allocate an id (real UUID by default; injectable in tests). */
export function uuid(): string {
  return ids();
}

/** Replace the clock (no-op restore via resetDeterminism). */
export function setClock(next: () => number): void {
  clock = next;
}

/** Replace the id allocator (no-op restore via resetDeterminism). */
export function setIdAllocator(next: () => string): void {
  ids = next;
}

/** Restore the real clock / uuid providers (production behavior). */
export function resetDeterminism(): void {
  clock = () => Date.now();
  ids = () => randomUUID();
}