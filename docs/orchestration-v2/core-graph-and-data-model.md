# Core Graph And Data Model

This document describes the entity shapes of MonoCode's orchestration model as
they are implemented (T2, T4, T7, F5). It is the "what exists" reference:
types come from the host modules, tables come from `host/store.ts`.

## The mental model

```text
Project
  Session  (the tab — "App thread" in the glossary)
    Run 1                 (durable, ordinal 1)
      root ExecutionNode  (kind: root_turn)
        tool ExecutionNode      (child)
        approval ExecutionNode  (child)
        subagent ExecutionNode  (child, e.g. an orchestration Worker)
    Run 2                 (ordinal 2, same session)
      root ExecutionNode
```

Key separation (from CONTEXT.md):

- **Session** — the tab in the composer; one user-visible conversation backed
  by one harness. Owns the message Blocks and per-session state.
- **Run** — the counted user-visible turn. A session's live turn is keyed by
  its run. The atomic unit of "agent working".
- **Run attempt** — one provider execution attempt under a run. Most runs have
  exactly one; steering restart or provider recovery adds another under the
  same run.
- **Execution node** — a unit of provider/runtime work inside a run (root
  turn, tool, approval, worker). **Only the root node's completion completes
  the run.**
- **App thread** — the canonical user-visible conversation, stable across runs
  and providers; MonoCode's tab (Session) is its current manifestation.

## Run

`host/run-normalizer.ts` defines the durable entity:

```ts
type Run = {
  id: string;              // app-owned
  sessionId: string;
  ordinal: number;         // counted user-visible turn order
  status:
    | "queued" | "running" | "completed"
    | "interrupted" | "failed" | "cancelled";
  startedAt: number;
  endedAt: number | null;
  attempts: number;        // steering/restart increments
  message: string | null;  // the user prompt; null for compaction turns
};
```

The normalizer is **content-agnostic**: it turns raw harness events into
lifecycle transitions (run started/terminal, request resolved) and does not
touch message content — content stays in Blocks. `normalizeRunEvent` maps
terminal events:

| Harness event | Run status transition |
|---|---|
| `message.completed` | `running` → `completed` |
| `session.error` | → `interrupted` (message recorded) |
| `session.ended` | → `interrupted` |

## ExecutionNode

`host/execution-node.ts` models the tree inside a run:

```ts
type NodeKind =
  | "root_turn"   // the user turn; only this completes the run
  | "tool"        // a tool call child
  | "approval"    // a pending approval child
  | "subagent";   // a worker / delegated child

type NodeStatus =
  | "pending" | "running" | "completed"
  | "interrupted" | "failed";

type ExecutionNode = {
  id: string;
  sessionId: string;
  runId: string;
  parentId: string | null;   // null for the root
  kind: NodeKind;
  status: NodeStatus;
  startedAt: number;
  endedAt: number | null;
  /** F5: optional typed substance for projections (per-tool status). */
  content?: {
    kind?: string;        // tool kind (read/edit/…)
    title?: string;
    detail?: string;
    requestId?: number;   // approval request id
    decision?: "allow" | "deny" | "cancelled";
  };
};
```

The reducer `applyNodeEvent` implements **root-only completion**:

- `message.delta` / non-lifecycle events → no structural change.
- `tool.started` → create a child `tool` node under the root.
- `tool.updated` → complete the matching child tool node (never the root).
- `approval.requested` → create a child `approval` node.
- `approval.resolved` → settle the matching approval node (`decision`).
- `message.completed` → **only the root** completes → `rootCompleted = true`.
- `session.error` / `session.ended` → root (and open children) interrupted.

F5 (typed nodes) keeps legacy content-agnostic runs readable: `content` is
optional, and a run with no typed content still reduces identically.

## The SQLite store (`host/store.ts`)

The store is SQLite (Node `DatabaseSync`) with WAL. Tables added by the rework:

```text
runs(
  id, session_id, ordinal, status,
  started_at, ended_at, message, attempts,
  PRIMARY KEY (session_id, id)
)

execution_nodes(
  id, session_id, run_id, parent_id, kind, status,
  started_at, ended_at,
  PRIMARY KEY (session_id, id)
)

provider_bindings(               -- T3 correlation
  app_entity_kind, app_entity_id, provider,
  native_ref, correlation, created_at,
  PRIMARY KEY (app_entity_kind, app_entity_id, provider)
)

handoffs(                        -- T5 handoff artifact
  id, session_id, provider, run_ordinal,
  handler, summary, created_at
)

provider_effects(                -- F1 outbox
  session_id, run_id, kind, payload,
  status, attempts, created_at,
  PRIMARY KEY (session_id, run_id, kind)
)
```

Pre-existing tables (`sessions`, `projects`, `events`, `receipts`, `devices`)
are untouched; `sessions` gained a nullable `summary` column.

Public store API used by the graph:

- `store.upsertRun(sessionId, run)` / `store.runs(sessionId)` — durable Run CRUD.
- `store.upsertNode(node)` / `store.nodesForRun(sessionId, runId)` — node tree.
- `store.session(id)` / `store.addProject(cwd, name)` — snapshot/project reads.

## Orchestration as the graph's batch policy (T7, ADR-0001)

`host/orchestration-graph.ts` projects an `OrchestrationRun` onto the graph:

- the **lead run** becomes a `root_turn` node;
- each worker **dispatch** becomes a child `subagent` node under the lead root;
- the projection records `OrchestrationGraphLink { leadRunId, workerNodeIds }`.

`migrateOrchestrationGraph(raw)` forward-migrates legacy
`orchestration_runs` (versions 1/2) to carry the `graph` linkage while keeping
legacy fields intact — history stays readable (the `version` field already
supported forward migration).

`readOrchestrationFromGraph(store, leadSessionId, run)` reads a worker's
durable state from the node tree instead of the parallel dispatch state; a
legacy run without a `graph` link falls back to its own dispatch state.

## Checkpoint scopes — NOT implemented

t3code V2 models nested `CheckpointScope`s. MonoCode deliberately does **not**
yet: `rollback` is only a capability flag (see
[remaining-gaps.md](remaining-gaps.md)). Node `content` is the only
per-tool/approval substance today.