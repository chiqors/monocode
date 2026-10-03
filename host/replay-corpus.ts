// S7 (issue #28): recorded-transcript replay corpus.
//
// A small RECORDED corpus per harness — one happy-path conversation + one
// mid-turn interruption/crash — committed as durable replay fixtures (JSON),
// captured through the recording half of the replay seam (`recordProviderIo`)
// so they reflect REAL provider-boundary transcript shapes, not hand-written
// stubs. The replay suite feeds every fixture through the real engine +
// normalizer deterministically, with no paid model calls. This is the
// "stability" evidence: provider-boundary regressions only real shapes catch.
//
// How to re-record: run `node host/scripts/record-corpus.mjs` (writes the
// fixtures into `host/fixtures/transcripts/`). The fixtures are committed; do
// not hand-edit them — re-record instead.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId } from "../src/features/sessions/model/session";
import type { ProviderTranscript } from "./replay";

export type CorpusEntry = {
  /** Fixture file name (without .json). */
  file: string;
  transcript: ProviderTranscript;
};

const CORPUS_DIR = join(__dirname, "fixtures", "transcripts");

/** All committed corpus fixture files (scenario names, no extension). */
export function corpusScenarioNames(): Set<string> {
  return new Set(
    readdirSync(CORPUS_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, "")),
  );
}

/** Load every committed corpus transcript, parsed + validated. */
export function corpusTranscripts(): CorpusEntry[] {
  const names = corpusScenarioNames();
  const entries: CorpusEntry[] = [];
  for (const name of names) {
    const loaded = loadCorpusEntry(name);
    if (loaded) entries.push(loaded);
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file));
}

/** Load one corpus fixture by file name (without extension), or undefined. */
export function loadCorpusEntry(file: string): CorpusEntry | undefined {
  const raw = readFileSync(join(CORPUS_DIR, `${file}.json`), "utf8");
  const transcript = JSON.parse(raw) as ProviderTranscript;
  if (transcript.format !== "monocode-replay-v1") return undefined;
  return { file, transcript };
}

/** The supported harnesses the corpus must cover (mirrors HARNESSES). */
export const CORPUS_HARNESSES: readonly HarnessId[] = [
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
] as const;