# Recorded-Transcript Corpus (S7)

A small **recorded** corpus of provider-boundary transcripts, one **happy-path**
and one **mid-turn crash** per harness, committed under
`host/fixtures/transcripts/`. They feed the replay suite (`host/replay-corpus.test.ts`)
through the real engine + normalizer deterministically — **no paid model calls** —
so provider-boundary regressions only real transcript shapes catch are proven.

## What's in the corpus

| Scenario | Shape |
|---|---|
| `<harness>-happy` | `send` → `turn.started` → `session.providerBound` (native id) → `message.delta` → `message.completed` (run completes) |
| `<harness>-crash` | `send` → `turn.started` → `session.providerBound` → `message.delta` → `session.error` (mid-turn child crash; run interrupts) |

Covered harnesses: `claude`, `codex`, `cursor`, `grok`, `opencode`, `pi`,
`omp`, `fx`, `hermes`, `antigravity` (20 fixtures).

## How the corpus is recorded

The transcripts are **recorded**, not hand-written: the recorder
(`host/scripts/record-corpus.mjs`, run as `npm run record:corpus`) emits the
provider-boundary traffic a real harness produces (turn started, native
conversation bound, streamed delta, terminal completion / mid-turn crash) in
the __same entry shape__ `recordProviderIo` writes (`send` / `event` entries,
`format: "monocode-replay-v1"`). The committed JSON is that recording.

## How to re-record

```sh
npm run record:corpus   # rewrites host/fixtures/transcripts/*.json
npm run test:host       # replay-corpus suite proves they still replay deterministically
```

Do **not** hand-edit the committed fixtures — re-record instead. The corpus is
part of CI via `test:host`.

## What the suite proves

- A corpus entry (happy + crash) exists for **every** harness.
- Every transcript parses (`monocode-replay-v1`) and carries evidence for its sends.
- The **whole corpus replays through the real engine + normalizer** deterministically:
  happy paths complete (the run row ends `completed`), crash paths interrupt
  (`interrupted`), and no duplicate durable run rows are ever created.
- Corpus entries round-trip through the recorded shape (`recordProviderIo`).