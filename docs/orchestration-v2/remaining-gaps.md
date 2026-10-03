# Remaining Gaps

The rework is shipped (T1–T7, F1–F6); this document lists what is **not**
implemented yet compared with the t3code V2 reference
(`t3code/docs/orchestration-v2/`), verified against the current codebase. Each
gap is a candidate for the next round of tracer-bullet tickets under
[issue #1](https://github.com/chiqors/monocode/issues/1).

## 1. ProviderThread as a first-class durable entity (the biggest gap)

**Landed (G1a #15 + G1b #16, closed).** `host/provider-thread.ts` records one
`provider_threads` row per (session, provider) with `nativeThreadRef` as
evidence, `firstRunOrdinal`/`lastRunOrdinal` coverage, and `handoffIds`;
`host/engine.ts` writes it at the provider-bound / switch-handoff / send
seams. Switching **back** to a provider with a prior thread now **resumes** it
via its `nativeThreadRef` (`providerSessionId` restored + `provider.bind`),
and `buildRunHandoffSummary` derives a **delta handoff** for only the
off-provider runs (`handler: "switch-back"`, linked into the resumed thread);
weak providers without a native cursor fall back to a full summary + fresh
thread.

**Remaining same-shape work (not ticketed):** `providerThreadId` on the session
snapshot is still a thin optional field (`src/features/sessions/model/session.ts`);
the frontend transcript rendering of a switch-back delta uses the existing
handoff-block mechanism, and a future `thread/resume` call beyond `bind` is
still on the provider side.

**t3code V2:** `ProviderThread` is a durable object with a resume cursor
(`nativeThreadRef`), per-provider coverage (`coveredRunRange`,
`firstRunOrdinal`/`lastRunOrdinal`, `handoffIds`). Switching **back** to a
prior provider defaults to **resuming that provider's previous provider
thread** and injecting a **delta handoff** covering the off-provider runs;
a fresh provider thread with a full summary is only the fallback.

**Why it matters:** it is t3code V2's default strategy for returning to a
provider, preserves native continuity, and avoids repeatedly re-summarizing.

## 2. Lazy fork resolution + stable source points

**Landed (G2 #17, closed).** `host/context-transfer.ts` records a pending
`ContextTransfer` (type `fork`) at fork time; `host/fork-merge.ts` `forkThread`
creates the target App thread + the transfer with **zero** provider work / no
eager handoff, and rejects forking from a running/queued source (stable source
points: terminal runs or an idle thread; checkpoints arrive with G3). The
fork's first dispatch (`host/engine.ts`) resolves the transfer via
`resolveForkOnFirstDispatch` — materializing the portable context (a
reviewable Handoff summary derived from the run store) exactly once.

**Remaining same-shape work (not ticketed):** a provider-native fork RPC
(beyond OpenCode's client-side `forkSession`) is still the preferred
resolution path when a harness exposes one; G3 will extend the stable-point
policy to checkpoints.

**t3code V2:** forking is cheap — create the target thread + a pending
`ContextTransfer`; no provider session/thread/context handoff until the fork's
**first dispatch**, which resolves the transfer (native fork when possible,
else portable context). Forks only from **stable source points** (completed
runs, checkpoints, idle threads).

**MonoCode today:** `forkThread` eagerly copies blocks and records a Handoff
at fork time (`host/fork-merge.ts`); no source-point policy.

## 3. CheckpointScope + rollback reconciliation

**Landed (G3 #19, closed).** `host/checkpoint.ts` + `checkpoint_scopes` table
carry nested `CheckpointScope`s (`advancesAppRunCount`, pre-run baseline +
post-run capture, status, parent id). `host/rollback.ts` `rollbackThread` is
the durable reconcile: marks later runs `rolled_back` (never deletes, no
duplicate runs), truncates each ProviderThread's covered range back to the
target, marks later checkpoints rolled back (target stays captured), and
records a `handler: "rollback"` handoff so the next switch-back delta covers
exactly the post-rollback runs.

**Remaining same-shape work (not ticketed):** the provider-native revert
(probe `historyMode` / page `thread/turns/list` / `thread/revert`) is still
behind the capability policy in the harness layer; checkpoint capture is
explicit via the module API (the engine does not yet auto-capture at run
boundaries), and G2's stable fork points can now extend to checkpoints.

**t3code V2:** nested `CheckpointScope`s with `advancesAppRunCount`; pre-run
baseline + post-run capture; provider rollback returns a snapshot that is
reconciled (probe `historyMode`, page `thread/turns/list`, `thread/revert`).

## 4. Replay-first deterministic time / ids

**t3code V2:** production reads time through a testable clock and allocates
ids through a testable random layer (Effect `TestClock`/`Random`), so replay
assertions are stable.

**MonoCode today:** the normalizer, node reducer, and store use `Date.now()`
and `crypto.randomUUID()` directly; tests use real timers and small waits.
Adding a deterministic clock/id layer would strengthen replay determinism.

## 5. Structural delegation results

**t3code V2:** a delegated task returns a structured `subagent_result`
context transfer (durable task state: `taskId`, `childThreadId`,
`childRunId`, `childNodeId`, `workState`, `latestTerminal*`, wait timeout,
etc.), with `task_status`/`task_cancel` and `mode: async | wait`.

**MonoCode today:** `delegateTask` waits with a bounded synchronous poll (3s
deadline) and uses the worker's **last assistant reply** as the result
(`host/delegate-task.ts`).

## 6. Rich capability shape + scoped correlation

**Landed (G6 #18, closed).** `host/capabilities.ts` `CapabilityFlags` is
versioned + tiered (`version: 1`, `identity: strong|weak|none`,
`terminalStatusQuality: terminal|estimated|unknown`), with tier-aware
`degradePolicy`; `host/correlation.ts` `provider_bindings` carries
`native_kind` + `scope` per binding and `CorrelationStrategy` covers
native exact → scoped → ordinal → fingerprint, with
`pickCorrelationStrategy(identityTier)` used by the engine's
`session.providerBound`. Existing boolean capability consumers and the
original degradation policies are untouched.

**Remaining same-shape work (not ticketed):** ordinal-tier correlation is a
stored strategy (tested) but the current picker maps weak→native_scoped;
per-adapter tier values beyond the optimistic defaults are set via
`capabilitiesFor` overrides.

**t3code V2:** versioned per-adapter capability reports with quality tiers
(`terminalStatusQuality`, `identity: strong|weak|none`) and scoped
correlation keys (native exact → scoped → ordinal → fingerprint, with
`nativeKind` + scope on each binding).

**MonoCode today:** boolean `CapabilityFlags` with optimistic defaults
(`host/capabilities.ts`) and a flat `provider_bindings(kind, id, provider) →
ref` map with a single strategy (`host/correlation.ts`). Sufficient for the
shipped verticals; the richer shape is deferred.

## Suggested priority

1. **ProviderThread + delta-handoff resume** (gap 1) — the closest to the
   shipped `pendingSwitch` work, biggest user-visible win.
2. **Stable source points + lazy fork** (gap 2) — cheap to add to
   `host/fork-merge.ts`.
3. **Scoped correlation tiers** (gap 6) — extend `provider_bindings`.
4. **Checkpoint scopes** (gap 3) and **structural delegation** (gap 5) —
   larger; t3code V2 itself treats nested checkpoints as a later concern.
5. **Deterministic clock/id layer** (gap 4) — infrastructure that unlocks
   stronger replay tests for all of the above.