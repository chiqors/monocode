# Orchestration MCP Surface

F4 (issue #12): the app-owned orchestration tool surface for cross-provider
worker delegation.

## Purpose

Let one harness (the lead) delegate a task to **another harness** (a worker)
through an app-owned tool, with the delegation visible in the **same execution
graph**. This is not a provider-native sub-agent API: it is a MonoCode
orchestration operation.

## The tool

`host/delegate-task.ts` implements `delegateTask(store, engine, input)` —
the `delegate_task` tool:

```ts
type DelegationToolInput = {
  leadSessionId: string;              // the delegating session
  provider: HarnessId;                // the harness to delegate TO (the worker)
  model: string;
  task: string;
  runtimeMode: "supervised" | "auto" | "monitored" | "unrestricted";
};

type DelegationResult = {
  workerSessionId: string;
  result: string;                     // the worker's integrated result
  policy: "native" | "synthetic";     // how the delegation ran
};
```

## Lifecycle

```text
delegate_task input
  -> capability policy decides native vs synthetic
  -> engine.command({ type: "create", ... worker session ... })
  -> engine.command({ type: "send", ... task ... })
  -> wait for the worker's run to settle (bounded poll)
  -> worker result = its last assistant reply (the Handoff brief source)
  -> recordHandoff(..., handler: "delegate_task") on the lead
  -> upsert child subagent node under the lead run's root (ONE graph)
```

One graph: the worker is a **third session**, but the delegation is part of
the lead's execution tree — a child `subagent` node keyed to the lead run
matching the orchestration rework's one-model rule (T7, ADR-0001).

## Capability gating

`delegateTask` uses `capabilitiesFor(input.provider)` +
`degradePolicy(caps, "handoff")`:

- strong providers → `policy: "native"`;
- weak providers → `policy: "synthetic"` (the delegation goes through the
  app-owned projection path) — never a silent opaqueness, matching the
  capability-driven rule.

`host/delegate-task.test.ts` proves:

- a delegation spawns a worker session distinct from the lead;
- the worker's result integrates back through the Handoff artifact;
- a child `subagent` node appears under the lead run's root;
- unsupported providers degrade through the capability policy.

## Relationship to the rest

- The Handoff artifact is the shared auditable mechanism (switches, forks,
  delegation) — see [provider-switching-and-context.md](provider-switching-and-context.md).
- The lead/worker structure is the graph's batch policy — see
  [core-graph-and-data-model.md](core-graph-and-data-model.md) (T7) and
  [feature-lifecycles.md](feature-lifecycles.md) (delegation).

## Differences from t3code V2 (and MonoCode's own future work)

t3code V2's MCP server is a full command ingress surface: `delegate_task`,
`task_status`, `task_cancel`, `create_threads`, `t3_thread_launch`, list/read/
send/wait/interrupt, durable command receipts with `clientRequestId`
idempotency, and `mode: "async" | "wait"`.

MonoCode's current surface is a single host function:

- the wait is a **bounded synchronous poll** (3s deadline) rather than a
  durable async state machine with `task_status`/`task_cancel`;
- the result is the worker's **last assistant reply**, not a structured
  `subagent_result` context transfer;
- commands are not yet exposed through an authenticated MCP server (HTTP) with
  orchestration capabilities.

Those are real gaps, tracked in [remaining-gaps.md](remaining-gaps.md).