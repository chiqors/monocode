// F3 (issue #11) + G2 (issue #17): forks + merge-back through the Handoff
// primitives, with lazy resolution.
//
// A thread can be forked into a new app session sharing the source's runs up
// to the fork point. G2 makes forking CHEAP: forkThread creates the target
// App thread + a pending ContextTransfer (type `fork`) WITHOUT any provider
// work or eager Handoff. The fork's FIRST dispatch resolves the transfer
// (native fork when possible, else portable context / Handoff summary).
// Forks are only made from STABLE source points (a terminal fork-at run, or
// an idle thread); forking from an active run is rejected.
import type { HostStore } from "./store";
import { buildRunHandoffSummary, recordHandoff } from "./handoff-summary";
import {
  createForkTransfer,
  pendingForkTransfer,
  resolveForkTransfer,
} from "./context-transfer";
import { now, uuid } from "./determinism";

export type ForkResult = {
  sessionId: string;
  /** The source session id (shared runs up to the fork point). */
  runs: string[];
  /** The durable pending ContextTransfer id (resolved on first dispatch). */
  transferId: string;
};

export type MergeBackResult = {
  /** Number of new blocks merged from the fork into the source. */
  blocks: { text: string }[];
  /** Total source block count after the merge. */
  count: number;
};

/** Terminal RunStatus values that make a fork-at point a stable source point. */
const STABLE_FORK_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);

/**
 * Fork a thread at a run ordinal, lazily.
 *
 * Stabilization: forking is rejected unless the source is at a STABLE point —
 * the fork-at run is terminal, or the source thread is idle with no run in
 * flight. This guarantees a fork only ever starts from a state that can be
 * faithfully reproduced (no active provider work is being forked around).
 *
 * The fork creates the target App thread (borrowing the source's blocks up to
 * the fork point) + a pending ContextTransfer. NO Handoff row is recorded and
 * NO provider session/thread/context is touched until the fork's first
 * dispatch (see resolveForkOnFirstDispatch).
 */
export function forkThread(
  store: HostStore,
  sourceSessionId: string,
  forkRunOrdinal: number,
): ForkResult {
  const source = store.session(sourceSessionId);
  const runs = store.runs(sourceSessionId);
  const forkAtRun = runs.find((r) => r.ordinal === forkRunOrdinal);
  // Stable source point policy (G2): the fork-at run must be terminal, or the
  // thread must be idle with no in-flight run. A running/queued run is an
  // unstable point — forking around active work cannot be faithfully
  // reproduced, so reject it. (Checkpoint source points arrive with G3.)
  if (forkAtRun && !STABLE_FORK_STATUSES.has(forkAtRun.status)) {
    throw new Error(
      `Fork requires a stable source point: run ${forkRunOrdinal} is ${forkAtRun.status}`,
    );
  }
  if (!forkAtRun && runs.some((run) => !STABLE_FORK_STATUSES.has(run.status))) {
    throw new Error(
      "Fork requires a stable source point: the thread has an in-flight run",
    );
  }
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
  const timestamp = now();
  const forkId = uuid();

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
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "idle",
      }),
      JSON.stringify({ id: forkId }),
    );

  // G2: lazy fork — no eager Handoff. Record the pending ContextTransfer so
  // the fork's first dispatch can resolve it (portable context / native fork).
  const transferId = createForkTransfer(store, {
    sourceSessionId,
    forkSessionId: forkId,
  });

  return {
    sessionId: forkId,
    runs: [sourceSessionId],
    transferId,
  };
}

/**
 * Resolve a fork's pending ContextTransfer on its first dispatch.
 *
 * The fork's first send materializes the portable context NOW: a Handoff
 * summary (the delta, derived from the run store) is built, recorded as a
 * durable reviewable handoff row, and the transfer is marked resolved. Native
 * fork (via a provider RPC) is the preferred path when available; the
 * portable-context Handoff is the fallback, exactly per t3code V2
 * ("materialize portable context"). Idempotent: calling it twice resolves
 * only the single pending transfer.
 *
 * Returns the Handoff summary text (empty if the fork is not pending or
 * already resolved).
 */
export function resolveForkOnFirstDispatch(
  store: HostStore,
  forkSessionId: string,
): string {
  const pending = pendingForkTransfer(store, forkSessionId);
  if (!pending) return "";
  const summary = buildRunHandoffSummary(store, pending.sourceSessionId);
  recordHandoff(store, {
    sessionId: forkSessionId,
    provider: store.session(forkSessionId).session.harness,
    runOrdinal: 1,
    summary,
    handler: "fork",
  });
  resolveForkTransfer(store, forkSessionId, { summary });
  return summary;
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
      updatedAt: now(),
      session: { ...source.session, blocks: merged },
    },
    { type: "merge-back", from: forkSessionId },
  );
  return { blocks: newBlocks, count: merged.length };
}