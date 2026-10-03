// T6 (issue #7): capability system + degradation policy.
//
// Each harness declares explicit capability flags; orchestration code never
// branches on harness NAME — every decision goes through capability/policy.
// When a capability is missing, a typed degradation policy tells the caller
// how to fall back (interrupt-and-restart, synthetic fork, synthetic user
// message, etc.) instead of failing opaquely.
import type { HarnessId } from "../src/features/sessions/model/session";

export type DegradationPolicy =
  | "supported"
  | "interrupt_and_restart"
  | "synthetic_fork"
  | "synthetic_user_message"
  | "unavailable";

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
  /** The provider emits stable native ids for correlation. */
  identity: boolean;
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
  identity: true,
};

const name = "DEFAULTS";

/** Per-harness capability overrides (only where a provider lacks something). */
export const DEFAULTS: Array<[HarnessId, CapabilityFlags]> = [
  ["claude", DEFAULT_CAPABILITIES],
  ["codex", DEFAULT_CAPABILITIES],
  ["cursor", DEFAULT_CAPABILITIES],
  ["grok", DEFAULT_CAPABILITIES],
  ["opencode", DEFAULT_CAPABILITIES],
  ["pi", DEFAULT_CAPABILITIES],
  ["omp", DEFAULT_CAPABILITIES],
  ["fx", DEFAULT_CAPABILITIES],
  ["hermes", DEFAULT_CAPABILITIES],
  ["antigravity", DEFAULT_CAPABILITIES],
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