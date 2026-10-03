// F6 (issue #14): capability-informed UI affordances.
//
// The UI consumes capability flags, never branches on harness name. Providers
// declare what they can do (canSteer, rewind, fork, handoff…); this model maps
// those into the affordances the UI renders, with safe app-owned fallback when
// a provider declares nothing — never a silent "unavailable" and never a
// name-branch.
import { getHarness } from "../../../integrations/harness/core/registry";
import type { HarnessId } from "./session";

export type InterruptAffordance =
  | "available"
  | "destructive"
  | "unavailable";

export type ForkAffordance = "shown" | "hidden";

export type HandoffAffordance =
  | "available"
  | "synthetic"
  | "unavailable";

export type CapabilityAffordances = {
  interrupt: InterruptAffordance;
  fork: ForkAffordance;
  handoff: HandoffAffordance;
};

/** The capabilities a harness may declare at the adapter surface. */
export type DeclaredCapabilities = {
  canSteer?: boolean;
  canFork?: boolean;
  canHandoff?: boolean;
};

/** Safe app-owned defaults when a harness declares nothing. */
export const DEFAULT_FALLBACK: CapabilityAffordances = {
  interrupt: "available",
  fork: "shown",
  handoff: "available",
};

/** Per-harness fallback overrides for known weak providers (empty = default). */
export const FALLBACKS: Record<string, Partial<CapabilityAffordances>> = {};

/**
 * Map declared capabilities to UI affordances. Always returns a typed, safe
 * affordance set — unknown capabilities degrade to the app-owned defaults.
 */
export function capabilityAffordances(
  declared: DeclaredCapabilities,
  harness?: string,
): CapabilityAffordances {
  const fallback = (harness
    ? FALLBACKS[harness]
    : undefined) as Partial<CapabilityAffordances> | undefined;
  const interrupt = declared.canSteer
    ? ("available" as const)
    : declared.canSteer === false
      ? ("destructive" as const)
      : (fallback?.interrupt ?? DEFAULT_FALLBACK.interrupt);
  const fork =
    declared.canFork === false
      ? ("hidden" as const)
      : (fallback?.fork ?? DEFAULT_FALLBACK.fork);
  const handoff =
    declared.canHandoff === false
      ? ("synthetic" as const)
      : (fallback?.handoff ?? DEFAULT_FALLBACK.handoff);
  return { interrupt, fork, handoff };
}

/**
 * The affordances for a registered harness, from its live adapter's declared
 * capabilities. The UI reads this — never a harness-name branch.
 */
export function capabilityAffordancesForHarness(
  harness: HarnessId,
): CapabilityAffordances {
  const adapter = getHarness(harness);
  return capabilityAffordances(
    adapter
      ? { canSteer: adapter.canSteer }
      : {},
    harness,
  );
}