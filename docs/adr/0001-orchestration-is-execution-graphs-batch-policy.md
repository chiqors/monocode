# ADR-0001: Orchestration is the execution graph's batch policy

We are reworking orchestrations so that the lead/worker feature and the new
app-thread/run/execution-node execution graph are **one model**: a lead run is a
root execution node and its workers are child nodes, orchestration being a
policy on top of the graph rather than a separate state store.

**Context.** MonoCode currently has two competing state shapes: ordinary
sessions (one tab per harness conversation, per-turn `runId`) and the
orchestration feature (`OrchestrationRun` with a lead plus worker tasks stored
in `orchestration_runs`). We are adopting the t3code-style graph (app thread →
run → execution node tree) to gain provider switching with context handoff,
forks, and subagent-style workers. Keeping two sources of truth — one for
conversations and one for orchestration — would force every new capability
(switching, forking, recovery) to be built twice.

**Decision.** Adopt a single canonical graph. `OrchestrationRun`/tasks become
*projections* over that graph: a lead run is a root execution node whose workers
are child nodes linked by handoff relationships. The `orchestration_runs`
surface and `control.rs` lead/worker semantics are reworked onto it.

**Consequences.**
- Breaking change to `OrchestrationRun` persistence and the `control_*` commands;
  staged via migration, preserving history (`version` field already supports
  forward migration).
- The lead/worker feature temporarily depends on graph semantics that already
  exist in simpler form; the graph milestone must land before the orchestration
  rework completes.
- Future features (provider switch, fork, merge-back, cross-provider subagents)
  all share the same graph shape — the payoff that justifies the rework.
- Rejected alternatives: keeping two models (simpler now, two stores forever);
  keeping orchestration as a separate concern on top (fails Q6's one-store
  principle). Chosen after the Q10 grilling round; documented in
  `docs/agent-notes/orchestration-design-tree.md`.