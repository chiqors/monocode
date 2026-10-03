# Remaining Gaps

> **Status: every gap has landed — the G-series (G1a/G1b/G2/G3/G4/G5/G6,
> #15–#21) AND the S-series stability tail (S1–S8, #22–#29) are closed.** Each
> section below records the shipped implementation and what remains; the only
> work still open relative to t3code V2 is the additive, harness-boundary
> **Later Adaptations** at the bottom (no open G/S tickets; the rework is
> complete).

The rework is shipped (T1–T7, F1–F6, G1a/G1b/G2/G3/G4/G5/G6, S1–S8). This
document records what landed and the small tail that remains; every gap gated
behind [issue #1](https://github.com/chiqors/monocode/issues/1) is closed.

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

**Remaining same-shape work — LANDED (S5 #26, closed):** `providerThreadId` is
a durable Run/session graph field (`runs.provider_thread_id` +
`Session.providerThreadId`, not a thin optional string), and the engine has an
explicit `thread/resume` command beyond `bind` that is the one
switch-back/fork/recovery resume path (restart-safe, no duplicate native
thread). The frontend transcript rendering of a switch-back delta still uses
the existing handoff-block mechanism; nothing provider-side remains here.

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

**Remaining same-shape work — LANDED (S2 #23 + S3 #24, closed):** native fork
is wired through the engine + adapters — the fork's first dispatch now prefers
the provider's native fork RPC when available (OpenCode `forkSession` first,
`native_fork` resolution recorded on the pending `ContextTransfer`), falling
back to portable context otherwise; stable source points now include captured
checkpoint scopes (S3), not just terminal runs / idle threads.

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

**Remaining same-shape work — LANDED (S4 #25 + S3 #24, closed):** checkpoint
capture is now engine-driven — a root `CheckpointScope` + pre-run baseline is
auto-created at run start and auto-captured at run terminal (completed /
interrupted), idempotent and deterministic under replay; and provider-native
rollback is wired through the capability gate — a `rollback` command probes
`historyMode` + the native revert RPC (`OpenCode revertSession` at the target
run's user message; `thread/turns/list` / `thread/revert` handled explicitly
or a typed capability error), reconciling the provider snapshot into durable
state via `rollbackThread`; paginated/no-RPC harnesses degrade through the
policy (host reconcile still runs).

**t3code V2:** nested `CheckpointScope`s with `advancesAppRunCount`; pre-run
baseline + post-run capture; provider rollback returns a snapshot that is
reconciled (probe `historyMode`, page `thread/turns/list`, `thread/revert`).

## 4. Replay-first deterministic time / ids

**Landed (G4 #21, closed).** `host/determinism.ts` is the testable
clock/id seam (the Effect `TestClock`/`Random` analogue): `now()`/`uuid()`
(real `Date.now`/`crypto.randomUUID` by default), `setClock`/`setIdAllocator`,
`resetDeterminism`. The deterministic core (`store.ts`, `engine.ts`,
`execution-node.ts`) and the G-series modules (`checkpoint.ts`,
`context-transfer.ts`, `correlation.ts`, `fork-merge.ts`, `handoff-summary.ts`,
`provider-effects.ts`, `provider-thread.ts`, `rollback.ts`,
`delegate-task.ts`) read time/ids through the seam. A replay test proves the
same transcript twice yields identical durable state; the existing correlation
replay tests were migrated off `setTimeout` to the injected clock +
`vi.waitFor`.

**Deliberate non-goal (no open work):** genuinely time-based paths stay real
(`delegate-task` wait-mode deadline, `server.ts`/`workspace-commands.ts`/
`sync-transfer.ts` cache TTLs, `orchestration-graph.ts` default) — those are
wait/UX paths, not replay state, and changing them would be wrong.

**t3code V2:** production reads time through a testable clock and allocates
ids through a testable random layer (Effect `TestClock`/`Random`), so replay
assertions are stable.

## 5. Structural delegation results

**Landed (G5 #20, closed).** `host/delegate-task.ts` returns the t3code
`DelegateTaskResult` shape (`taskId`, `childThreadId`, `childRunId`,
`childNodeId`, `status`, `workState`, `summary`, `resultContextTransferId`,
`latestTerminal*`, `waitTimedOut`) with durable `delegated_tasks` rows,
`task_status`/`task_cancel`, and `mode: async | wait` (async returns the
durable state immediately — no 3s bounded poll; wait honors `timeoutMs`
without cancelling the child). Results still integrate into the Lead via the
`handler: "delegate_task"` Handoff (F4 one-graph) + child subagent node;
capability degradation (`policy: native|synthetic`) preserved. The agent-app
surface forwards `mode`/`timeoutMs` and exposes `task_status`/`task_cancel`.

**Remaining same-shape work — LANDED (S8 #29, closed):** `task.status` /
`task.cancel` now work for local AND remote through the host RPC + the same
durable `delegated_tasks` store (taskId-scoped, structured result, idempotent
cancel); the remote bridge allowlist (`src-tauri/src/remote.rs`) permits
`delegate.task` / `task.status` / `task.cancel`; `App.tsx` errors name the
real constraint when a host connection is absent (Rust-native local sessions
have no delegated-task store).

**t3code V2:** a delegated task returns a structured `subagent_result`
context transfer (durable task state: `taskId`, `childThreadId`,
`childRunId`, `childNodeId`, `workState`, `latestTerminal*`, wait timeout,
etc.), with `task_status`/`task_cancel` and `mode: async | wait`.

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

**Remaining same-shape work — LANDED (S6 #27, closed):** the picker now returns
`ordinal` for the ordinal-addressable mid tier (`IdentityTier "ordinal"`,
`pickCorrelationStrategy("ordinal") → "ordinal"` — no longer dead code), and
per-adapter tiers are set in `DEFAULTS` from observed behavior
(`pi`/`omp`/`fx`/`hermes`/`antigravity` → ordinal + estimated; strong/terminal
kept for codex/claude/cursor/grok/opencode), so `degradePolicy` /
`pickCorrelationStrategy` no longer overclaim on weak providers.

**t3code V2:** versioned per-adapter capability reports with quality tiers
(`terminalStatusQuality`, `identity: strong|weak|none`) and scoped
correlation keys (native exact → scoped → ordinal → fingerprint, with
`nativeKind` + scope on each binding).

**MonoCode shipped (G6 + S6):** versioned + tiered `CapabilityFlags` with
per-adapter verified tiers (`host/capabilities.ts` `DEFAULTS`) and scoped
`provider_bindings` with the full native exact → scoped → ordinal → fingerprint
strategy set (`host/correlation.ts`). No deferred richer shape remains.

## Landed status

Every gap in this document has landed. The S-series closed the last same-shape
tails on top of the G-series:

| Gap | Root ticket | Stability tail | S-ticket |
|---|---|---|---|
| 1. ProviderThread + delta-handoff resume | #15/#16 (G1a/G1b) | `providerThreadId` durable + engine `thread/resume` | #26 (S5) |
| 2. Lazy fork + stable source points | #17 (G2) | native-fork wiring through engine/adapters; checkpoint stable points | #23/#24 (S2/S3) |
| 3. CheckpointScope + rollback reconciliation | #19 (G3) | engine auto-capture at run boundaries; provider-native rollback + capability gate | #24/#25 (S3/S4) |
| 4. Replay-first deterministic time/ids | #21 (G4) | — (no tail) | — |
| 5. Structural delegation results | #20 (G5) | local + remote `task.status`/`task.cancel` parity | #29 (S8) |
| 6. Rich capability shape + scoped correlation | #18 (G6) | per-adapter tiers + `ordinal` picker | #27 (S6) |

Headline S-series evidence: `host/checkpoint-auto.test.ts`, `host/thread-resume.test.ts`,
`host/rollback-native.test.ts`, `host/capability-tiers.test.ts`, `host/replay-corpus.test.ts`,
`host/task-bridge.test.ts`; full host suite **210 passed / 5 skipped**; commits
`287f83f`..`c416b36` on `refactor/orchestrator-v2`.

## Later Adaptations (the only work still open — additive, harness-boundary)

Matching the spec ticket's Out of Scope, the remaining work relative to t3code
V2 is additive and sits at the adapter/transport edge. Kit the host graph; each
is its own ticket stack and can land in parallel:

- **ACP (Agent Client Protocol).** `src/integrations/harness/core/acp.ts` is a
   thin JSON-RPC client; there is no ACP-powered harness adapter yet (cursor
   uses `cursorAdapter`). Add an ACP adapter + registry entry, session/thread
   bind, approvals/questions, replays, and catalog. **~5–8 tickets.**
- **MCP server for agents to drive MonoCode.** The host functions exist
   (`delegateTask`/`taskStatus`/`taskCancel`) and the `/operator` CLI surface
   exists; a real authenticated MCP/HTTP ingress with command receipts +
   idempotency (`clientRequestId`) and `create_threads`/`thread_launch`/list/
   read/send/wait/interrupt is not built. Mostly transport + auth + receipts.
   **~3–5 tickets.**
- **OpenCode 2.** The adapter pins `MINIMUM_OPENCODE_VERSION = "1.14.19"` and
   uses the v1 HTTP client. OpenCode 2 changes the protocol (server streaming,
   session API, security); needs a protocol bump, normalizer adjustments, new
   replay fixtures, and resume-correlation re-verification. **~4–6 tickets.**
- **New harnesses / providers.** `registerBuiltinHarnesses()` in
   `src/integrations/harness/core/register.ts` is the explicit registry (claude,
   cursor, codex, grok, opencode, pi, omp, fx, hermes, antigravity). Each new
   harness = one `HarnessAdapter` + catalog + replay fixture + capability
   defaults. **~3–5 tickets per harness.**