# Provider Switching And Context

This is the shipped provider-switch vertical (T5, issue #6) and its follow-on
uses (fork F3, delegation F4). It is the consumer-facing companion to
[feature-lifecycles.md](feature-lifecycles.md) and [core-graph-and-data-model.md](core-graph-and-data-model.md).

## The vocabulary

Per `CONTEXT.md`, MonoCode deliberately uses **Handoff** (not t3code's
"context transfer"):

> **Handoff** — the act of continuing a conversation across a provider
> boundary: the composer records `pendingSwitch` and the handoff runs on the
> next send. Covers provider switches, forks, and worker delegation, all
> through one auditable artifact.
>
> **Handoff summary** — the materialized context artifact a target provider
> receives — a delta of the runs that happened while it was absent, or a full
> thread summary when the delta is impossible. Attached per-run and consumed
> at dispatch; the delta is derived from the normalized run event store, not
> stored as a chain. Auditable app data, never hidden prompt concatenation.

## The flow

1. **Composer arms a switch.** `planComposerSwitch(session, next)` decides:
   - same harness → `{ kind: "model" }` (just a model change);
   - reverting to `pendingSwitch.from` → `{ kind: "revert" }` (restores the
     prior provider session/account ids);
   - no user blocks yet → `{ kind: "empty", forget }`;
   - otherwise → `{ kind: "arm", pending: PendingHarnessSwitch }`.

   `PendingHarnessSwitch` carries `{ from, fromModel, fromSettings,
   fromProviderSessionId?, fromProviderAccountId? }`.

2. **A Handoff block is prepared.** `appendPreparingHandoff` /
   `appendReadyHandoff` / `completeHandoff` manage the transcript block
   (role `handoff`, `status: preparing | ready`, `pending`). `pendingHandoff`
   returns the ready handoff's text, falling back to
   `buildDeterministicHandoff(session)`.

3. **The summary is derived deterministically.** The frontend model builds it
   from the session's own Blocks (`handoffParts`: recent user messages, latest
   assistant reply, last plan/tasks, files edited by edit tools, CI context),
   and the host builds a per-run delta from the store
   (`buildRunHandoffSummary` in `host/handoff-summary.ts`: recent runs +
   statuses, latest user prompt + last assistant reply, tool list).
   `recordHandoff` persists it as a durable, reviewable `handoffs` row.

4. **The switch runs on the next send.** The handoff text is injected with the
   user message — the summary is a separate preamble/system/developer context,
   and the user message remains the actual run input.

5. **The next harness sees the context.** Because the summary was materialized
   as app data (a Handoff block + a `handoffs` row), the switch is auditable:
   a user can see exactly what context crossed the boundary.

### The outgoing-agent recap

When the session has edits, `shouldAskOutgoingAgent` is true and
`buildOutgoingHandoffPrompt(userRequest)` asks the outgoing agent for a short
recap of the conversation (under 120 words, no tools, no transcript dump,
files only if edited) — before the new agent starts.

## The host-side summarizer

`host/handoff-summary.ts`:

```text
buildRunHandoffSummary(store, sessionId)
  -> "# Runs" over the recent run list (status + prompt)
  -> "# Last reply" (latest assistant block, capped)
  -> "# Tools" (tool titles, capped)
```

Deterministic: same store state → same text (tested in
`host/handoff-summary.test.ts`, which also asserts the summary contains run
prompts/status and is per-run).

## Delta vs full summaries

The summary is a **delta** of what the target provider missed (runs since it
last participated), derived from the store each time — not stored as a chain.
A full thread summary is the fallback when the delta is impossible (per
CONTEXT.md). The switch flow does not yet implement t3code's orchestrator-v2 treatment of
"return to a previous provider thread and inject delta handoff into the
resumed provider thread" — MonoCode's current switch creates a new target
session/context per switch (see [remaining-gaps.md](remaining-gaps.md),
ProviderThread gap).

## Capability interaction

- Harnesses that cannot accept a Handoff summary degrade via the capability
  policy: `degradePolicy(caps, "handoff")` returns
  `synthetic_user_message` when the harness lacks `handoff` — the context is
  delivered as a synthetic user message instead (user story #16).
- The UI surface reflects this: `capabilityAffordances` maps a harness's
  declared `canHandoff` into a `HandoffAffordance` of `available` /
  `synthetic` / `unavailable` (F6, `src/features/sessions/model/capabilityAffordances.ts`).

## Related features that reuse the same artifact

- **Forks (F3):** fork records a Handoff summary (the delta) on the fork;
  merge-back records one back to the source.
- **Delegation (F4):** the worker's result integrates back into the lead
  through a Handoff artifact (`delegate-task.ts` records a
  `handler: "delegate_task"` handoff).

The Handoff is the single auditable artifact across switches, forks, and
worker delegation — exactly as the glossary defines it.