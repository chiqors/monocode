# Testing Strategy

T1's replay harness became the **one seam** every orchestration ticket's tests
run through. The rule, stated in the ticket and in ADR-0001's context:

> **Only the provider process boundary is replaced.**
> The normalizer, Run entity, event store, Handoff summarizer, and projections
> are all exercised through this one replacement point. No new test seams.

## The seam

`host/replay.ts` owns the replayed-provider boundary:

- `recordProviderIo(provider, meta)` wraps a live provider, appending every
  call it receives (and every event it emits) into a durable `ProviderTranscript`.
- `replayProvider(transcript)` returns a `HostProvider` that replays the
  recorded calls/events through the real engine — a replayed conversation
  actually settles the engine, deterministically, with **no provider process**
  and no paid model.
- `parseTranscript(value)` validates a persisted transcript
  (`format: "monocode-replay-v1"`).

```ts
type ProviderTranscript = {
  format: "monocode-replay-v1";
  provider: HarnessId;
  scenario: string;
  entries: ProviderReplayEntry[];   // send / cancel / stop / approve / answer / event
};
```

Every ticket's test file shares this shape: create a `HostStore` in a temp
dir, a `HostEngine` over a `replayProvider`, drive commands, assert on final
durable state.

## What the suite protects

| Ticket | Test file | Invariants proven |
|---|---|---|
| T1 | `host/replay.test.ts` | transcript parse/validation; record — replay roundtrip; idempotent replay (no duplicate durable state); deterministic. |
| T2 | `host/run-normalizer.test.ts` | content-agnostic lifecycle normalization; durable Run entity end to end. |
| T3 | `host/correlation.test.ts` | app ids primary / refs evidence; native_exact → synthetic fallback; replay finds existing bindings. |
| T4 | `host/execution-node.test.ts` | node tree; **root-only completion**; child tool/approval completing never completes the run; run attempts. |
| T5 | `host/handoff-summary.test.ts` | deterministic per-run delta summarizer; durable auditable handoff artifact. |
| T6 | `host/capabilities.test.ts` | flags default + override; degradation policy; engine never branches on harness name. |
| T7 | `host/orchestration-graph.test.ts` | lead run → root node; dispatches → child subagent nodes; forward migration; graph read-back. |
| F1 | `host/provider-effects.test.ts` | effects persist before dispatch; pending→in-flight→done; restart reads same outbox; attempts increment; idempotent done. |
| F2 | `host/recovery.test.ts` | restart marks only the interrupted run; completed runs intact; outbox survives; no duplicate durable state. |
| F3 | `host/fork-merge.test.ts` | fork shares runs up to fork point; handoff delta recorded; merge-back applies fork's new blocks. |
| F4 | `host/delegate-task.test.ts` | worker as third session; result integrates through handoff; child subagent node; capability-gated degradation. |
| F5 | `host/execution-node-typed.test.ts` | typed tool/approval content; legacy content-agnostic runs stay readable; root-only completion preserved. |

Frontend model tests cover the projections in the existing style of the
orchestration state/plan tests (pure functions over projections, e.g.
`src/features/sessions/model/handoff.test.ts`, F6
`capabilityAffordances` tests).

## What a good test asserts

External behavior through the seam — final projections and durable state:

- run status + ordinal;
- node parent/child structure and `rootCompleted`;
- handoff coverage / recorded artifact;
- idempotent receipts (replay gives the same durable state);
- outbox rows and their status transitions.

Not internal call counts, not mocked lower layers, not private helper
invocation order.

## Differences from t3code V2

t3code V2's testing strategy is replay-first with a **deterministic
clock/id layer** (Effect `TestClock` / `Random`) and contract-test levels
from raw transcript to V2 domain events.

MonoCode's host uses `Date.now()` in the normalizer, node reducer, and store
(`startedAt`, `createdAt`, `endedAt`). Tests therefore use real timers and
small waits (`setTimeout`) rather than a deterministic clock — that keeps the
one-seam rule but makes timing-dependent assertions less re-playable than
t3code's. Moving to a deterministic clock/id layer is tracked in
[remaining-gaps.md](remaining-gaps.md).

The replay transcripts are hand-written fixtures today (recorded via
`recordProviderIo` in tests), not a large recorded-fixture corpus per harness;
that corpus grows with each provider's real transcripts.