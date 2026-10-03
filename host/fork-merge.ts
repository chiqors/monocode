// F3 (issue #11): forks + merge-back through the Handoff primitives.
//
// A thread can be forked into a new app session sharing the source's runs up
// to the fork point; merge-back applies the fork's new blocks into the source
// via the Handoff artifact. Harnesses without native fork degrade through the
// capability policy (synthetic fork from the app projection).
import { randomUUID } from "node:crypto";
import type { HostStore } from "./store";
import { buildRunHandoffSummary, recordHandoff } from "./handoff-summary";

export type ForkResult = {
  sessionId: string;
  /** The source session id (shared runs up to the fork point). */
  runs: string[];
  /** The recorded Handoff summary (the delta), reviewable in the transcript. */
  handoffSummary: string;
};

export type MergeBackResult = {
  /** Number of new blocks merged from the fork into the source. */
  blocks: { text: string }[];
  /** Total source block count after the merge. */
  count: number;
};

/**
 * Fork a thread at a run ordinal. Creates a new app session borrowing the
 * source's blocks up to the fork point, references the source's runs (one
 * model — history is shared), and records a Handoff summary (the delta).
 */
export function forkThread(
  store: HostStore,
  sourceSessionId: string,
  forkRunOrdinal: number,
): ForkResult {
  const source = store.session(sourceSessionId);
  const runs = store.runs(sourceSessionId);
  const forkAtRun = runs.find((r) => r.ordinal === forkRunOrdinal);
  // The fork point block: the last block of the run at forkRunOrdinal's *user
  // message* + its assistant reply. Simplest honest rule: copy all blocks up
  // to (and including) the assistant block of the fork run.
  const visibleBlocks = source.session.blocks.filter((block) => !block.draft);
  let forkIndex = visibleBlocks.length;
  if (forkAtRun) {
    // Copy through the end of the fork run: the user message for the run plus
    // the following assistant reply (the run's completed work).
    const forkUserIndex = visibleBlocks.findIndex(
      (block) => block.role === "user" && block.text === forkAtRun.message,
    );
    if (forkUserIndex >= 0) {
      // Find the next user block (the next run's start) or the end of blocks.
      const nextUser = visibleBlocks.findIndex(
        (block, index) => index > forkUserIndex && block.role === "user",
      );
      forkIndex = nextUser >= 0 ? nextUser : visibleBlocks.length;
    }
  }
  const blocks = visibleBlocks.slice(0, forkIndex);
  const now = Date.now();
  const forkId = randomUUID();

  store.db
    .prepare(
      "INSERT INTO sessions (id, project_id, snapshot, summary) VALUES (?, ?, ?, ?)",
    )
    .run(
      forkId,
      source.projectId,
      JSON.stringify({
        ...source,
        revision: 0,
        session: {
          ...source.session,
          id: forkId,
          blocks,
        },
        createdAt: now,
        updatedAt: now,
        status: "idle",
      }),
      JSON.stringify({ id: forkId }),
    );

  const handoffSummary = buildRunHandoffSummary(store, sourceSessionId);
  recordHandoff(store, {
    sessionId: forkId,
    provider: source.session.harness,
    runOrdinal: forkAtRun?.ordinal ?? 1,
    summary: handoffSummary,
    handler: "fork",
  });

  return {
    sessionId: forkId,
    runs: [sourceSessionId],
    handoffSummary,
  };
}

/**
 * Merge the fork's new blocks (those after the fork point) back into the
 * source thread. Returns the merged blocks + the new source block count.
 */
export function mergeBack(
  store: HostStore,
  forkSessionId: string,
  sourceSessionId: string,
): MergeBackResult {
  const fork = store.session(forkSessionId);
  const source = store.session(sourceSessionId);
  const forkVisible = fork.session.blocks.filter((block) => !block.draft);
  const newBlocks = forkVisible.filter(
    (block) => !source.session.blocks.some((b) => b.id === block.id),
  );
  const merged = [...source.session.blocks, ...newBlocks];
  const summary = buildRunHandoffSummary(store, forkSessionId);
  recordHandoff(store, {
    sessionId: sourceSessionId,
    provider: fork.session.harness,
    runOrdinal: store.runs(sourceSessionId).length + 1,
    summary,
    handler: "merge-back",
  });
  store.save(
    {
      ...source,
      revision: source.revision + 1,
      updatedAt: Date.now(),
      session: { ...source.session, blocks: merged },
    },
    { type: "merge-back", from: forkSessionId },
  );
  return { blocks: newBlocks, count: merged.length };
}