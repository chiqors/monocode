# MonoCode Orchestration V2

This document set describes the orchestration architecture that MonoCode built
over the T1–T7 milestone and the F1–F6 follow-on series ([issue #1 →
T1–T7 / F1–F6](https://github.com/chiqors/monocode/issues/1)). It is written
against the delivered implementation, not a target design: every concept below
maps to a shipped module and its tests.

The design intent (the "t3code treatment", decision tree, and ADR) lives in:

- [`docs/agent-notes/orchestration-design-tree.md`](../agent-notes/orchestration-design-tree.md) — the design interview that settled the architecture (Q1–Q15).
- [`docs/adr/0001-orchestration-is-execution-graphs-batch-policy.md`](../../docs/adr/0001-orchestration-is-execution-graphs-batch-policy.md) — the hard-to-reverse decision: orchestration is the execution graph's batch policy.
- [`CONTEXT.md`](../../CONTEXT.md) — the domain glossary (Session, Run, Run attempt, App thread, Execution node, Harness, Lead, Worker, Scope, Workspace, Handoff, Handoff summary, Normalizer, Block). **Use that vocabulary; it deliberately avoids t3code's "context transfer" terms.**

## Why this exists

MonoCode drives ten harness CLIs (claude, codex, cursor, grok, opencode, pi,
omp, fx, hermes, antigravity). Before this rework, each conversation was a
single `Session` whose identity depended partly on provider-native ids, a `Run`
was only an ad-hoc `runId` (not a durable entity), and orchestration (Lead →
Workers) was a separate state store (`orchestration_runs` + `control.rs`). Every
new capability — provider switching, forking, worker delegation, restart
recovery — would have had to be built twice.

The rework made **one model**:

```text
Project
  AppThread (a "Session" tab)
    Run            — a counted user-visible turn (durable)
      ExecutionNode tree — root_turn, tool, approval, subagent
    Handoff records — the auditable context artifact that crosses providers
```

Orchestration is a **policy on top of that graph**: a Lead run is a root
execution node, its Workers are child `subagent` nodes. There is no second state
store.

## Architecture at a glance

```text
Native harness CLI (claude, codex, …)
  -> HostChildBackend / provider transport (spawns, speaks each protocol)
  -> Normalizer (host/run-normalizer.ts, host/execution-node.ts)
       lifecycle + identity only; content stays in Blocks
  -> HostStore (SQLite: events, runs, execution_nodes, provider_bindings,
       handoffs, provider_effects)
  -> projections / UI (src/features/sessions, src/features/orchestration)
```

## Documents

| Doc | What it covers |
|---|---|
| [core-graph-and-data-model.md](core-graph-and-data-model.md) | The entity shapes: Session / Run / Run attempt / ExecutionNode, the SQLite tables, and root-only completion. |
| [entity-ids-and-correlation.md](entity-ids-and-correlation.md) | App ids are primary, provider ids are refs; correlation strategies and idempotent replay. |
| [feature-lifecycles.md](feature-lifecycles.md) | Run lifecycle, steering/restart, forks + merge-back, delegation, recovery, resumption. |
| [provider-switching-and-context.md](provider-switching-and-context.md) | The Handoff summary, `pendingSwitch`, delta-vs-full summaries, and the switch flow. |
| [capability-system.md](capability-system.md) | Per-harness capability flags, degradation policy, and the UI affordance mapping. |
| [orchestration-mcp-surface.md](orchestration-mcp-surface.md) | The app-owned `delegate_task`/MCP tool surface for cross-provider workers. |
| [testing-strategy.md](testing-strategy.md) | The one-seam replay harness and the test suite that protects the invariants. |
| [remaining-gaps.md](remaining-gaps.md) | What is *not* built yet vs t3code's orchestrator-v2 reference — the next round of tickets. |

## Implemented ticket map

All shipped. Trace-through commits `b1b4caf` → `8c8bfae` (plus F4/F6 wiring in
`84da52b` / `b252ffa`).

| Ticket | Issue | Module(s) |
|---|---|---|
| T1 Replay harness at the provider boundary | [#2](https://github.com/chiqors/monocode/issues/2) | `host/replay.ts`, `host/replay.test.ts` |
| T2 Durable Run entity + content-agnostic normalizer | [#3](https://github.com/chiqors/monocode/issues/3) | `host/run-normalizer.ts`, `runs` table |
| T3 App-owned identity + provider-ref correlation | [#4](https://github.com/chiqors/monocode/issues/4) | `host/correlation.ts`, `provider_bindings` table |
| T4 Execution graph (nodes, root-only completion, run attempts) | [#5](https://github.com/chiqors/monocode/issues/5) | `host/execution-node.ts` |
| T5 Handoff + provider-switch vertical | [#6](https://github.com/chiqors/monocode/issues/6) | `host/handoff-summary.ts`, `src/features/sessions/model/handoff.ts` |
| T6 Capability system + degradation policy | [#7](https://github.com/chiqors/monocode/issues/7) | `host/capabilities.ts` |
| T7 Orchestration rework onto the graph (one model) | [#8](https://github.com/chiqors/monocode/issues/8) | `host/orchestration-graph.ts`, ADR-0001 |
| F1 Durable effect outbox | [#9](https://github.com/chiqors/monocode/issues/9) | `host/provider-effects.ts`, `provider_effects` table |
| F2 Runtime / restart recovery | [#10](https://github.com/chiqors/monocode/issues/10) | `host/recovery.test.ts` behavior in `HostEngine` |
| F3 Forks + merge-back through Handoff primitives | [#11](https://github.com/chiqors/monocode/issues/11) | `host/fork-merge.ts` |
| F4 MCP orchestration surface (delegate_task) | [#12](https://github.com/chiqors/monocode/issues/12) | `host/delegate-task.ts` |
| F5 Typed execution nodes (plan/tool/approval content) | [#13](https://github.com/chiqors/monocode/issues/13) | `host/execution-node.ts` (`content`) |
| F6 Capability-informed UI affordances | [#14](https://github.com/chiqors/monocode/issues/14) | `src/features/sessions/model/capabilityAffordances.ts` |

## Where the code lives

- **Host** (`host/`): the engine, store, normalizer, correlation, capabilities,
  handoff summarizer, provider-effects outbox, forks, delegation, replay.
  The host owns the store + normalizer; the frontend owns the projection/UI
  (decision Q6c).
- **Frontend model** (`src/features/sessions/model/`): `handoff.ts` (the
  `pendingSwitch` / Handoff block flow), `capabilityAffordances.ts` (F6).
- **Orchestration feature** (`src/features/orchestration/`): the Lead/Worker UI
  and catalog — now a projection over the same graph (T7).

## Hard rules (invariants)

1. App ids are primary. Provider ids are refs.
2. Provider events are never rewritten to look like another provider event.
3. **Child execution completion never closes the parent run.** Only the root
   node's completion completes the run.
4. Handoff summaries are derived, deterministic, reviewable app artifacts —
   never hidden prompt concatenation.
5. Behavior is capability-driven, not harness-name-driven.
6. Orchestration is one model: a policy on the execution graph, not a separate
   store.

## Reading order

1. `core-graph-and-data-model.md` — the shapes.
2. `feature-lifecycles.md` — how the shapes move.
3. `testing-strategy.md` — the seam that proves the invariants.
4. The rest on demand.