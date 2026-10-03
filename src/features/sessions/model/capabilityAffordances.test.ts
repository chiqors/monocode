// F6 (issue #14): capability-informed UI affordances.
//
// The UI consumes capability flags, never branches on harness name. This model
// maps the live adapter's declared capabilities (canSteer, rewind, etc.) plus
// per-harness fallback flags into the affordances the UI renders: fork shown/
// hidden, interrupt labeled available/destructive/unavailable, handoff
// affordance surfaced.

import { describe, expect, it } from "vitest";
import {
  capabilityAffordances,
  capabilityAffordancesForHarness,
  type CapabilityAffordances,
  DEFAULT_FALLBACK,
} from "./capabilityAffordances";

describe("capability affordances (UI reads capabilities, not names)", () => {
  it("maps an adapter that can steer to available interrupt + fork affordances", () => {
    const affordances = capabilityAffordances({ canSteer: true, canFork: true });
    expect(affordances.interrupt).toBe("available");
    expect(affordances.fork).toBe("shown");
    expect(affordances.handoff).toBe("available");
  });

  it("labels interrupt destructive when steering is unsupported", () => {
    const affordances = capabilityAffordances({ canSteer: false, canFork: true });
    expect(affordances.interrupt).toBe("destructive");
    expect(affordances.fork).toBe("shown");
  });

  it("hides fork when the harness cannot fork", () => {
    const affordances = capabilityAffordances({ canSteer: true, canFork: false });
    expect(affordances.fork).toBe("hidden");
  });

  it("falls back to app-owned affordances (synthetic) when capabilities are unknown", () => {
    const affordances = capabilityAffordances({});
    // Unknown capabilities degrade to the safe app-owned defaults — never
    // silently unavailable, and never a name-branch.
    expect(affordances.fork).toBe(DEFAULT_FALLBACK.fork);
    expect(affordances.interrupt).toBe(DEFAULT_FALLBACK.interrupt);
    expect(affordances.handoff).toBe(DEFAULT_FALLBACK.handoff);
  });

  it("surfaces the synthetic handoff affordance (user message injected)", () => {
    const affordances = capabilityAffordances({ canHandoff: false });
    expect(affordances.handoff).toBe("synthetic");
  });

  it("reads a registered harness adapter (antigravity canSteer=false -> destructive)", async () => {
    // Register the real antigravity adapter (canSteer: false) and ensure the
    // UI mapping consumes the declared capability, never a name-branch.
    const { ensureAntigravityRegistered } = await import(
      "../../../integrations/harness/providers/antigravity/antigravityAdapter"
    );
    ensureAntigravityRegistered();
    const affordances = capabilityAffordancesForHarness("antigravity");
    expect(affordances.interrupt).toBe("destructive");
  });
});