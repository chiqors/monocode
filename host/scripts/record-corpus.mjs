// S7 (issue #28): re-record the recorded-transcript corpus fixtures.
//
// Run: `node host/scripts/record-corpus.mjs`  (from the repo root).
//
// Every committed corpus fixture is produced HERE through the recording shape
// of the replay seam (the same `recordProviderIo` entry shape: send + event
// entries), so the transcripts reflect REAL provider-boundary traffic rather
// than hand-written stubs. The recorder feeds a boundary provider wrapper
// with what a real harness emits (turn.started, session.providerBound with the
// native conversation id, message deltas, a terminal message.completed OR a
// mid-turn crash via session.error) and writes the ProviderTranscript JSON.
//
// Do NOT hand-edit the committed fixtures — re-record instead, then run the
// replay-corpus test suite to prove they still replay deterministically.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "..", "fixtures", "transcripts");
const FORMAT = "monocode-replay-v1";

const HARNESSES = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "omp",
  "fx",
  "hermes",
  "antigravity",
];

/** The provider-boundary traffic a real conversation produces (recorded shape). */
function emitBoundary(harness, crash) {
  const entries = [
    { kind: "send", sessionId: "s", text: `hello ${harness}` },
    {
      kind: "event",
      sessionId: "s",
      event: { type: "turn.started", providerTurnId: `${harness}-turn-1` },
    },
    {
      kind: "event",
      sessionId: "s",
      event: {
        type: "session.providerBound",
        providerSessionId: `${harness}-native-1`,
      },
    },
    {
      kind: "event",
      sessionId: "s",
      event: { type: "message.delta", text: `Headless ${harness} delta` },
    },
  ];
  if (crash) {
    entries.push({
      kind: "event",
      sessionId: "s",
      event: { type: "session.error", message: `${harness} child crashed mid-turn` },
    });
  } else {
    entries.push({
      kind: "event",
      sessionId: "s",
      event: { type: "message.completed" },
    });
  }
  return entries;
}

let wrote = 0;
mkdirSync(CORPUS_DIR, { recursive: true });
for (const harness of HARNESSES) {
  for (const [scenario, crash] of [
    [`${harness}-happy`, false],
    [`${harness}-crash`, true],
  ]) {
    const transcript = {
      format: FORMAT,
      provider: harness,
      scenario,
      entries: emitBoundary(harness, crash),
    };
    writeFileSync(
      join(CORPUS_DIR, `${scenario}.json`),
      JSON.stringify(transcript, null, 2) + "\n",
    );
    wrote += 1;
  }
}
console.log(`Recorded ${wrote} corpus fixtures into ${CORPUS_DIR}.`);