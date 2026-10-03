# Remaining Gaps

The rework is shipped (T1–T7, F1–F6); this document lists what is **not**
implemented yet compared with the t3code V2 reference
(`t3code/docs/orchestration-v2/`), verified against the current codebase. Each
gap is a candidate for the next round of tracer-bullet tickets under
[issue #1](https://github.com/chiqors/monocode/issues/1).

## 1. ProviderThread as a first-class durable entity (the biggest gap)

**t3code V2:** `ProviderThread` is a durable object with a resume cursor
(`nativeThreadRef`), per-provider coverage (`coveredRunRange`,
`firstRunOrdinal`/`lastRunOrdinal`, `handoffIds`). Switching **back** to a
prior provider defaults to **resuming that provider's previous provider
thread** and injecting a **delta handoff** covering the off-provider runs;
a fresh provider thread with a full summary is only the fallback.

**MonoCode: the durable entity half has landed (#15, closed).** `host/provider-thread.ts`
now records one `provider_threads` row per (session, provider) with
`nativeThreadRef` as evidence, `firstRunOrdinal`/`lastRunOrdinal` coverage
(derived from the run store, so a delta is derivable), and `handoffIds`,
written at the provider-bound / switch-handoff / send seams.

**Still to do (G1b, #16 — blocked by #15):** switching **back** to a provider
still creates a **new target session** instead of **resuming** its prior
provider thread with a **delta handoff** covering the off-provider runs.
`providerThreadId` remains a thin optional field on the session snapshot
(`src/features/sessions/model/session.ts`); `pendingSwitch` records
`fromProviderSessionId`/`fromProviderAccountId` for revert; there is still no
resume-cursor-driven `thread/resume` flow.

**Why it matters:** it is t3code V2's default strategy for returning to a
provider, preserves native continuity, and avoids repeatedly re-summarizing.

## 2. Lazy fork resolution + stable source points

**t3code V2:** forking is cheap — create the target thread + a pending
`ContextTransfer`; no provider session/thread/context handoff until the fork's
**first dispatch**, which resolves the transfer (native fork when possible,
else portable context). Forks only from **stable source points** (completed
runs, checkpoints, idle threads).

**MonoCode today:** `forkThread` eagerly copies blocks and records a Handoff
at fork time (`host/fork-merge.ts`); no source-point policy.

## 3. CheckpointScope + rollback reconciliation

**t3code V2:** nested `CheckpointScope`s with `advancesAppRunCount`; pre-run
baseline + post-run capture; provider rollback returns a snapshot that is
reconciled (probe `historyMode`, page `thread/turns/list`, `thread/revert`).

**MonoCode today:** `rollback` is only a capability flag
(`host/capabilities.ts`); there is no host checkpoint table or rollback flow.
Node `content` (F5) gives per-tool status, not checkpoints.

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