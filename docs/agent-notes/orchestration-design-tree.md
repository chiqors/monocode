# MonoCode orchestration: the "t3code treatment" — design tree

State of the interview. **Uncommitted**: none of this is implemented yet. Settled
decisions are recorded; open questions are listed last. This is a decision tree,
not a spec — implementation detail lives in issues/specs downstream.

## What we're designing

Bring MonoCode's orchestration up to the t3code orchestration-v2 shaped model:
app-owned thread/run/execution-node identity, provider-native refs kept as
evidence, capability-driven behavior, context handoff for provider switches,
and replay-backed test tooling. Facts gathered from both codebases are on the
table (monocode `host/`, `src/features/orchestration/`, `src-tauri/src/control.rs`;
t3code `apps/server/src/orchestration-v2/` + `docs/orchestration-v2/`).

## Settled decisions

- **Q1 Scope: full treatment.** Bring MonoCode's orchestration to t3code's orchestrator-v2
  shaped model, not just selected slices.
- **Q2 Motivation: still exploring** — the interview itself is sharpening what
  "the treatment" means; no single symptom yet.
- **Q3 Ideas wanted: everything.** App-owned identity + correlation, root-only
  run completion, context handoff, capability system, replay-backed tests, MCP
  orchestration surface — all wanted.
- **Q4 Appetite: ASAP**, including closing the feature gap t3code has that
  MonoCode lacks (provider switch with real context handoff).
- **Q5 Constraint: rework orchestration is acceptable.** Breaking changes to
  `orchestration_runs` / `control.rs` are on the table.
- **Q6 Where the graph lives: (c) both.** Host owns the store + normalizer;
  frontend owns the projection/UI. (`HostStore` already is an event store with
  per-session revisions — this is the pattern you already built, extended.)
- **Q7 Decomposition: (c) middle taxonomy.** `AppThread` + `Run` +
  `ExecutionNode`; `ProviderThread`/`ProviderTurn` stay thin refs on the
  existing session, not full entities. Not minimal (a), not full t3code (b).
- **Q8 First shipped feature: (a) provider switch with real handoff.**
  `pendingSwitch` already exists as a stub; closing that gap is the smallest
  user-visible win. Fork/merge-back, cross-provider subagents, runtime recovery
  are follow-ons the same graph enables.
- **Q9 Vocabulary: keep "Handoff".** Already in the UI/codebase (`handoffCard`,
  `pendingSwitch`, handoff block role). Not adopting t3code's "context transfer"
  jargon.
- **Q10 One model: (a) yes.** Orchestration's lead/worker feature becomes the
  graph's "batch policy": a lead run is a root execution node, workers are child
  nodes (t3code subagent shape). One canonical state store, orchestration is a
  policy on top.
- **Q6 sequencing: (a) Run entity + normalizer first.** Promote `runId` to a
  durable `Run` entity with status/ordinal; a normalizer turns harness events
  into normalized run lifecycle events. Invisible to users; foundation for
  everything. Milestone 2 wires the handoff through it.
- **Q12 Handoff generation: (b) deterministic local summarizer.** MonoCode
  builds the handoff summary itself from the normalized event store. Provider
  being left (a) is a later optional upgrade; target provider on first send (c)
  rejected.
- **Q13 Handoff granularity: (a) per-run, delta derived.** Each run carries one
  handoff summary consumed at dispatch; delta content is computed from the
  normalized event store (b's fidelity without b's chain bookkeeping).
- **Q14 Normalizer depth: (a) content-agnostic.** Normalize lifecycle +
  identity (run start/terminal, node created/completed, request resolved); store
  raw content in blocks as today. Upgrade to typed nodes (plans/tools/approvals)
  only when a feature demands it.
- **Q15 Effect outbox: (b) not yet.** Keep in-memory reactor + retry. Durable
  effect outbox is a restart-recovery milestone, not the first one.

## Facts gathered (not decisions)

- `host/engine.ts` already allocates a `runId` per turn; the "running" map and
  live streams are keyed by `(sessionId, runId)`. A `Run` concept exists as an
  ID, not as a durable entity.
- `host/store.ts` has an event log (`events (session_id, revision, payload)`)
  plus `sessions` snapshot, `projects`, `receipts`, `devices`. Per-block change
  revisions; events not independently replayable today (snapshot + revision log).
- `src/features/sessions/model/session.ts`: `Session` is the tab; has `blocks`,
  `busy`, `queuedMessages`, `pendingSwitch`/`PendingHarnessSwitch` (provider
  switch stub), `runtimeMode`, `providerSessionId` (provider-native id used as
  app identity today).
- `host/providers.ts`: a `HostProvider` interface w/ optional methods
  (`compact?`, `generateTitle?`, `generateBranchName?`) — a proto-capability
  shape already exists.
- `host/engine.ts` commands: create, send, compact, draft/removeDraft, cancel,
  approve, answer — no "steer" (redirect) today; orchestration steering exists
  only via `src/features/orchestration/model` `steer()`.
- `src-tauri/src/control.rs`: control namespace (loopback auth), grants,
  active-turn authorization, lead/worker attach, save/load `orchestration_runs`,
  scopes, path resolution. Orchestration = lead plans + workers in isolated
  checkouts, integrated back.
- Orchestration data model: `OrchestrationRun` (lead + tasks + dispatches),
  `OrchestrationTask` (dependsOn, scopes, workspace), `OrchestrationWorkspace`
  (main or worktree), statuses, proposal flow (`orchestrationPlan.ts`).
- No replay/transcript infrastructure today: fixtures are hand-written stubs
  (e.g. `host/provider-transport.test.ts` in-process ACP fixture), not recorded
  provider transcripts. Replay-backed testing is greenfield.
- Provider-native ids (e.g. `providerSessionId`) are currently stored on
  `Session` as identity — the "app ids primary, provider refs as evidence"
  principle is not yet applied.

## Open questions

(none — frontier empty)

## Vocabulary

See `CONTEXT.md` for the glossary (Session, Run, Run attempt, App thread,
Execution node, Harness, Lead, Worker, Scope, Workspace, Handoff, Handoff
summary, Normalizer, Block).