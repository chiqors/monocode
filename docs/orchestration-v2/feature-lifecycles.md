# Feature Lifecycles

This document describes how the core user-facing flows behave in the shipped
implementation (T2–T7, F1–F5), as exercised by `host/*.test.ts`. Where the
current behavior differs from the t3code V2 reference, it is flagged.

## Creating a session

A session (App thread) is created by `engine.command({ type: "create", ... })`
(`host/engine.ts`): it allocates an app `sessionId`, registers the project, and
keeps the session snapshot. No provider process is started eagerly; the first
`send` starts the turn (the model does not have t3code V2's lazy
provider-thread creation distinction — see remaining gaps).

## Starting a run

When a `send` command is accepted (`engine.command({ type: "send", ... })`):

1. A durable `Run` is upserted (`store.upsertRun`) with a fresh ordinal,
   status `running`, and the prompt text.
2. The run's root `ExecutionNode` (kind `root_turn`, `parentId: null`) is
   created via `freshRootNode`.
3. A `turn.start` provider effect is enqueued in the durable effect outbox
   (F1) before dispatch.
4. The harness `send` is invoked; as raw harness events arrive
   (`message.delta`, `tool.started`, `approval.requested`, …), the normalizers
   (`normalizeRunEvent`, `applyNodeEvent`) reduce lifecycle + nodes.

The run stays `running` until a terminal event:

- `message.completed` → root node `completed`, run `completed` (and only then).
- `session.error` / `session.ended` → root (+ open children) `interrupted`,
  run `interrupted`.

**Root-only completion** (T4) means: a child `tool` / `approval` /
`subagent` node completing never completes the run. `applyNodeEvent` returns
`rootCompleted: true` only when the root completes.

On send, the outbox `turn.start` effect is marked in-flight, then unmarked
(`markEffectDone`) once the run settles — see F1.

## Steering and run attempts

MonoCode's steering model is capability-driven: a `steer` capability decides
whether an active turn can be redirected (`host/capabilities.ts`). When the
harness lacks steering, the degradation policy is `interrupt_and_restart`.

Run attempts are represented by the `attempts` counter on `Run`
(the `runs.attempts` column): a steering restart or provider recovery
increments `attempts` under the same run instead of starting a new run.
(Most runs have exactly one attempt.)

## Provider switching (the Handoff vertical)

T5 + `src/features/sessions/model/handoff.ts` are the shipped vertical;
see [provider-switching-and-context.md](provider-switching-and-context.md) for
the full flow. Summary:

- The composer records `pendingSwitch` (`PendingHarnessSwitch: from, fromModel,
  fromSettings, fromProviderSessionId?, fromProviderAccountId?`).
- On the next send, a Handoff block (role `handoff`) is prepared/ready and the
  deterministic local summarizer (`buildDeterministicHandoff` in the frontend
  model; `buildRunHandoffSummary` in the host) produces the delta summary.
- The summary is an auditable transcript artifact, reviewable by the user —
  never hidden prompt concatenation.

## Forking and merge-back (F3)

`host/fork-merge.ts`:

```text
forkThread(store, sourceSessionId, runOrdinal)
  -> new session (fork) borrowing the source's Blocks up to the fork point
  -> references the source's runs (history shared, one model)
  -> records a Handoff summary (the delta) on the fork

mergeBack(store, forkSessionId, sourceSessionId)
  -> appends the fork's new Blocks (those not already in source) to the source
  -> records a Handoff summary from the fork to the source
```

Capability-driven: harnesses without native fork use the `synthetic_fork`
degradation policy.

**Difference from t3code V2:** MonoCode forks eagerly (copies blocks +
records a Handoff at fork time). V2 defers provider/context work to the fork's
first dispatch (pending `ContextTransfer`, lazy resolution, stable source
points). See [remaining-gaps.md](remaining-gaps.md).

## Delegation (F4)

`host/delegate-task.ts` is the app-owned `delegate_task` tool:

1. A lead session running a turn delegates a task to another harness
   (`provider` + `model` + `task` + `runtimeMode`).
2. The app spawns a **worker session** (a third session) and sends the task.
3. The worker's result (its last assistant reply) is recorded as a Handoff
   artifact on the lead.
4. A child `subagent` execution node is upserted under the lead run's root —
   **one graph**.
5. Capability-gated: weak providers degrade through `degradePolicy`.

The current result integration is the worker's last assistant block; t3code
V2 transports a structured `subagent_result` context transfer instead (see
remaining gaps). See
[orchestration-mcp-surface.md](orchestration-mcp-surface.md) for the tool
shape.

## Recovery / restart (F1 + F2)

- **Durable effect outbox (F1):** provider effects (`turn.start` /
  `interrupt` / `rollback` / `fork`) persist with status
  (`pending` / `in-flight` / `done`) + attempts BEFORE dispatch. On restart the
  reactor reads pending effects and resumes them — no lost or
  double-dispatched effects (`host/provider-effects.ts`, `provider_effects`
  table). `markEffectDone` is idempotent.
- **Restart recovery (F2):** on a fresh engine over the same DB, a session
  whose run was interrupted mid-flight is settled to `interrupted`; only the
  affected run is marked; completed runs stay intact; no duplicate durable
  state (idempotent settle). A harness process crash marks only the affected
  run failed and keeps the thread recoverable.

Recovery is proved by `host/recovery.test.ts` using a hanging provider
(`send` that never resolves) + outbox assertions.

## Orchestration run lifecycle (T7)

`host/orchestration-graph.ts` + control:

- A lead run is a root execution node; worker dispatches are child `subagent`
  nodes (`projectOrchestration`).
- Legacy orchestration history is forward-migrated (`migrateOrchestrationGraph`)
  with the graph link; legacy fields stay intact.
- Worker durable state is read from the node tree
  (`readOrchestrationFromGraph`) when a graph link exists, else falls back to
  the legacy dispatch state.

## Interruption

Interruption is a capability: `cancel`/steering degrades to
`interrupt_and_restart` when the harness lacks native steer. The terminal
state arrives from provider lifecycle events; the app does not mark a run
terminal just because an interrupt request returned (`applyNodeEvent` only
completes on `message.completed`, and only the root).