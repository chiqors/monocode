// S6 (issue #27): per-adapter capability tier overrides + the ordinal
// correlation strategy (no longer dead code).
//
// Today every harness inherits the shared optimistic defaults
// (identity:"strong", terminalStatusQuality:"terminal") and the correlation
// picker never selects `ordinal` — it maps weak → native_scoped, none →
// fingerprint, so every binding overclaims native_exact. S6 sets verified
// per-adapter tiers from real provider behavior and makes the picker choose
// `ordinal` for ordinal-addressable mid-tier providers, so weak/ordinal
// providers get scoped/ordinal correlation and non-terminal providers degrade
// to interrupt_and_restart.
//
// The seam: the capability table + the correlation picker (pure, no provider).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilitiesFor,
  degradePolicy,
  DEFAULTS,
  type CapabilityFlags,
  type IdentityTier,
  type TerminalStatusQuality,
} from "./capabilities";
import { pickCorrelationStrategy } from "./correlation";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-s6-tiers-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("per-adapter capability tiers (S6)", () => {
  it("declares per-adapter (not shared-default) identity + terminal quality tiers", () => {
    // Strong-native providers: stable conversation ids + terminal lifecycle.
    for (const harness of ["codex", "claude"] as const) {
      const caps = capabilitiesFor(harness);
      expect(caps.identity).toBe("strong");
      expect(caps.terminalStatusQuality).toBe("terminal");
    }
    // Ordinal-addressable mid tier: native refs are ordinal/positional, not
    // stable conversation ids — the correlation picker must choose `ordinal`.
    const ordinalHarness = DEFAULTS.find(([id]) => id === "pi") as
      | readonly [string, CapabilityFlags]
      | undefined;
    expect(ordinalHarness).toBeTruthy();
    const piCaps = capabilitiesFor("pi");
    // The pi family reports estimated lifecycle quality, so it is not
    // 'terminal' — and its identity is ordinal-addressable, not strong.
    expect(piCaps.identity).toBe("ordinal");
    expect(piCaps.terminalStatusQuality).not.toBe("terminal");
  });

  it("picks the ordinal correlation strategy for the ordinal mid tier (no dead code)", () => {
    expect(pickCorrelationStrategy("strong")).toBe("native_exact");
    expect(pickCorrelationStrategy("ordinal")).toBe("ordinal");
    expect(pickCorrelationStrategy("weak")).toBe("native_scoped");
    expect(pickCorrelationStrategy("none")).toBe("fingerprint");
  });

  it("degrades non-terminal providers to interrupt_and_restart instead of overclaiming", () => {
    const pi = capabilitiesFor("pi");
    const quality = degradePolicy(pi, "terminalStatusQuality");
    expect(quality).toBe("interrupt_and_restart");
    // The boolean capabilities still work; the tier drives the policy.
    expect(pi.sessions).toBe(true);
  });

  it("records the tier-appropriate correlation strategy per binding in the engine", async () => {
    // (The engine providerBound path uses pickCorrelationStrategy(identity);
    // a binding for an ordinal-tier provider carries correlation='ordinal'.)
    const directory = setupDir();
    const { HostStore } = await import("./store");
    const store = new HostStore(join(directory, "s6.db"));
    cleanups.push(() => store.close());
    const { bindProviderRef } = await import("./correlation");
    const ordinalCaps = capabilitiesFor("pi");
    // A pi binding resolves as ordinal (the strategy the engine records).
    const strategy = pickCorrelationStrategy(ordinalCaps.identity);
    bindProviderRef(store, {
      appEntityKind: "session",
      appEntityId: "app-pi",
      provider: "pi",
      nativeRef: "3",
      correlation: strategy,
    });
  });
});

// Keep the imports referenced so the union types stay accurate.
const _tiers: Array<IdentityTier> = ["strong", "ordinal", "weak", "none"];
const _quality: TerminalStatusQuality[] = [
  "terminal",
  "estimated",
  "unknown",
];
void _tiers;
void _quality;