# Capability System

T6 (host) + F6 (UI). The rule:

> **Behavior is capability-driven, not harness-name-driven.**

Shared orchestration code never branches on `harness === "claude"` etc.
Every decision goes through capability flags / degradation policy.

## Host-side flags (`host/capabilities.ts`)

```ts
type CapabilityFlags = {
  sessions: boolean;  // stable sessions across turns
  threads: boolean;   // provider threads can be resumed by id
  steer: boolean;     // turns can be steered / interrupted mid-turn
  fork: boolean;      // conversations can be forked
  rollback: boolean;  // context can be rolled back / rewound
  handoff: boolean;   // a handoff summary can be injected / accepted
  identity: boolean;  // provider emits stable native ids for correlation
};

type DegradationPolicy =
  | "supported"
  | "interrupt_and_restart"
  | "synthetic_fork"
  | "synthetic_user_message"
  | "unavailable";
```

- `capabilitiesFor(harness, overrides?)` — per-harness flags. Every harness
  has an entry in `DEFAULTS`; the default is optimistic support, overridden
  where a provider lacks something.
- `degradePolicy(caps, action)` — the policy for a requested action:

| Action | Policy when unsupported |
|---|---|
| `steer` / `rollback` | `interrupt_and_restart` |
| `fork` | `synthetic_fork` |
| `handoff` | `synthetic_user_message` |
| anything else | `unavailable` |

`host/capabilities.test.ts` covers the mapping and proves the engine never
branches on harness name.

## UI affordances (F6, `src/features/sessions/model/capabilityAffordances.ts`)

The UI consumes capabilities, with safe app-owned fallbacks — never a hidden
"unavailable", never a name-branch:

```ts
type InterruptAffordance = "available" | "destructive" | "unavailable";
type ForkAffordance = "shown" | "hidden";
type HandoffAffordance = "available" | "synthetic" | "unavailable";

type CapabilityAffordances = {
  interrupt: InterruptAffordance;
  fork: ForkAffordance;
  handoff: HandoffAffordance;
};
```

`capabilityAffordances(declared, harness?)` maps a harness's declared
capabilities to the affordance set:

- `canSteer: true` → interrupt `available`; `canSteer: false` →
  `destructive`; undeclared → app-owned default `available`.
- `canFork: false` → fork `hidden`; otherwise `shown`.
- `canHandoff: false` → handoff `synthetic`; otherwise `available`.

`capabilityAffordancesForHarness(harness)` reads the live adapter's
declared capabilities via the harness registry (`getHarness(harness)`) —
the UI always reads capabilities, never the harness name.

## Where capabilities drive behavior

- **Handoff acceptance:** a harness without `handoff` receives context via a
  synthetic user message (`degradePolicy`), and the UI shows the handoff
  affordance as `synthetic`.
- **Interrupt/steering:** a harness without `steer` degrades to
  interrupt-and-restart (run attempts under the same run).
- **Fork:** a harness without native `fork` degrades to the synthetic fork
  from the app projection (`host/fork-merge.ts`).
- **Delegation:** `delegate-task.ts` gates the worker path on the target
  harness's capabilities and reports `policy: "native" | "synthetic"`
  (F4).

## Difference from t3code V2

t3code V2's capability system is richer: versioned per-adapter capability
reports, quality tiers (`terminalStatusQuality: strong|weak|none`,
`identity: strong|weak|none`), and policy for many more verbs (streaming,
approvals, planning, subagents, checkpointing, context handoff shapes).
MonoCode's boolean flags + degradation policy cover the shipped verticals;
the richer shape is deferred (see [remaining-gaps.md](remaining-gaps.md)).