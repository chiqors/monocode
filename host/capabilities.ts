// T6 (issue #7) + G6 (issue #18): capability system + degradation policy.
//
// Each harness declares explicit capability flags; orchestration code never
// branches on harness NAME — every decision goes through capability/policy.
// When a capability is missing, a typed degradation policy tells the caller
// how to fall back (interrupt-and-restart, synthetic fork, synthetic user
// message, etc.) instead of failing opaquely.
//
// G6 adds the versioned, tiered shape: each adapter report carries a version,
// an `identity` tier (strong | weak | none — how reliable its native ids are
// for correlation), and a `terminalStatusQuality` tier (terminal | estimated |
// unknown — how reliably it reports run completion). The boolean capability
// flags are retained and keep driving the existing degradation policy; the
// tiers only ADD the richer shape so consumers can stop overclaiming on weak
// providers (e.g. terminal-quality optimizations, correlation strategy).
import type { HarnessId } from "../src/features/sessions/model/session";

export type DegradationPolicy =
  | "supported"
  | "interrupt_and_restart"
  | "synthetic_fork"
  | "synthetic_user_message"
  | "unavailable";

/** How reliably a provider's native ids can be correlated to app entities. */
export type IdentityTier = "strong" | "ordinal" | "weak" | "none";

/** How reliably a provider reports terminal run status. */
export type TerminalStatusQuality = "terminal" | "estimated" | "unknown";

/** The capability flags a harness may declare. */
export type CapabilityFlags = {
  /** Stable sessions across turns. */
  sessions: boolean;
  /** Provider threads can be resumed by id. */
  threads: boolean;
  /** Turns can be steered / interrupted mid-turn. */
  steer: boolean;
  /** Conversations can be forked. */
  fork: boolean;
  /** Context can be rolled back / rewound. */
  rollback: boolean;
  /** A handoff summary can be injected / accepted. */
  handoff: boolean;
  /**
   * G6: how reliable the provider's native ids are for correlation
   * (replaces the old optimistic boolean; no consumer reads it as a boolean).
   */
  identity: IdentityTier;
  /** G6: adapter report version (increments on shape change). */
  version: number;
  /** G6: how reliably the provider reports terminal run status. */
  terminalStatusQuality: TerminalStatusQuality;
};

export const CAPABILITY_KEYS = [
  "sessions",
  "threads",
  "steer",
  "fork",
  "rollback",
  "handoff",
  "identity",
] as const;

/** Default flags: optimistic support; providers override what they lack. */
export const DEFAULT_CAPABILITIES: CapabilityFlags = {
  sessions: true,
  threads: true,
  steer: true,
  fork: true,
  rollback: true,
  handoff: true,
  identity: "strong",
  version: 1,
  terminalStatusQuality: "terminal",
};

const name = "DEFAULTS";

/**
 * Per-harness capability overrides (only where a provider differs from the
 * optimistic strong/terminal default). S6 sets VERIFIED tiers from observed
 * provider behavior:
 * - codex / claude / opencode / cursor / grok: stable native conversation ids
 *   + a terminal lifecycle event → strong identity + terminal quality.
 * - fx / hermes / antigravity (ACP/other): native ids exist but are
 *   ordinal/positional, and terminal status is estimated → ordinal identity +
 *   estimated terminal quality (never overclaim native_exact / terminal).
 * - pi / omp: RPC-based, ids are ordinal, lifecycle is estimated.
 */
export const DEFAULTS: Array<[HarnessId, CapabilityFlags]> = [
  ["claude", DEFAULT_CAPABILITIES],
  ["codex", DEFAULT_CAPABILITIES],
  ["cursor", DEFAULT_CAPABILITIES],
  ["grok", DEFAULT_CAPABILITIES],
  ["opencode", DEFAULT_CAPABILITIES],
  ["pi", {
    ...DEFAULT_CAPABILITIES,
    identity: "ordinal",
    terminalStatusQuality: "estimated",
  }],
  ["omp", {
    ...DEFAULT_CAPABILITIES,
    identity: "ordinal",
    terminalStatusQuality: "estimated",
  }],
  ["fx", {
    ...DEFAULT_CAPABILITIES,
    identity: "ordinal",
    terminalStatusQuality: "estimated",
  }],
  ["hermes", {
    ...DEFAULT_CAPABILITIES,
    identity: "ordinal",
    terminalStatusQuality: "estimated",
  }],
  ["antigravity", {
    ...DEFAULT_CAPABILITIES,
    identity: "ordinal",
    terminalStatusQuality: "estimated",
  }],
];

/** Look up capability flags for a harness, with optional per-provider overrides. */
export function capabilitiesFor(
  harness: HarnessId,
  overrides: Partial<CapabilityFlags> = {},
): CapabilityFlags {
  const base =
    DEFAULTS.find(([id]) => id === harness)?.[1] ?? DEFAULT_CAPABILITIES;
  return { ...base, ...overrides };
}

/** The policy for a requested action, given the harness's declared capabilities. */
export function degradePolicy(
  caps: CapabilityFlags,
  action: keyof CapabilityFlags,
): DegradationPolicy {
  // G6: tiered capabilities are only "supported" at their strongest tier.
  // `identity` is a tier (strong|weak|none): only strong identity is fully
  // supported (native_exact correlation); ordinal/weak/none degrade to
  // synthetic/ordinal correlation. `terminalStatusQuality` is a tier
  // (terminal|estimated|unknown): only terminal quality is supported;
  // estimated/unknown mean the provider cannot be trusted to drive
  // terminal-only optimizations.
  if (action === "identity") {
    return caps.identity === "strong" ? "supported" : "synthetic_user_message";
  }
  if (action === "terminalStatusQuality") {
    return caps.terminalStatusQuality === "terminal"
      ? "supported"
      : "interrupt_and_restart";
  }
  if (action === "version") return "supported";
  if (caps[action]) return "supported";
  switch (action) {
    case "steer":
    case "rollback":
      return "interrupt_and_restart";
    case "fork":
      return "synthetic_fork";
    case "handoff":
      return "synthetic_user_message";
    default:
      return "unavailable";
  }
}

export { name };