// G3 (issue #19): nested CheckpointScopes.
//
// A CheckpointScope is the durable host record of a checkpoint boundary: a
// root scope advances the app run count (advancesAppRunCount=true) with a
// pre-run baseline + post-run capture; a child scope (subagent) nests under a
// parent and does NOT advance the parent run count. Checkpoints give rollback
// a stable point to reconcile against, and (with G2) are the future stable
// fork source points.
import type { HostStore } from "./store";
import { now, uuid } from "./determinism";

export type CheckpointScopeStatus = "baselined" | "captured" | "rolled_back";

export type CheckpointScope = {
  id: string;
  /** The parent scope id for a nested (child/subagent) scope, or undefined. */
  parentId?: string;
  sessionId: string;
  /** The app run ordinal this scope checkpointed. */
  runOrdinal: number;
  /** Whether capturing this scope advances the app run count (root=yes). */
  advancesAppRunCount: boolean;
  /** Pre-run baseline summary (what the world looked like before the run). */
  baselineSummary?: string;
  /** Post-run capture summary (the diff/what the run produced). */
  captureSummary?: string;
  status: CheckpointScopeStatus;
  createdAt: number;
  capturedAt?: number;
};

/** Create a checkpoint scope (nested via parentId), returning its id. */
export function createCheckpointScope(
  store: HostStore,
  scope: Pick<
    CheckpointScope,
    "sessionId" | "runOrdinal" | "advancesAppRunCount"
  > & { parentId?: string },
): string {
  const id = uuid();
  store.db
    .prepare(
      `INSERT INTO checkpoint_scopes
         (id, parent_id, session_id, run_ordinal, advances_app_run_count, baseline_summary, capture_summary, status, created_at, captured_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'baselined', ?, NULL)`,
    )
    .run(
      id,
      scope.parentId ?? null,
      scope.sessionId,
      scope.runOrdinal,
      scope.advancesAppRunCount ? 1 : 0,
      now(),
    );
  return id;
}

/** Ensure a pre-run baseline for a scope (no-op if already baselined). */
export function ensurePreRunBaseline(
  store: HostStore,
  scopeId: string,
  baselineSummary: string,
): void {
  store.db
    .prepare(
      "UPDATE checkpoint_scopes SET baseline_summary=?, status='baselined' WHERE id=? AND baseline_summary IS NULL",
    )
    .run(baselineSummary, scopeId);
}

/** Capture a post-run checkpoint for a scope (idempotent). */
export function captureCheckpoint(
  store: HostStore,
  scopeId: string,
  captureSummary: string,
): void {
  store.db
    .prepare(
      "UPDATE checkpoint_scopes SET capture_summary=?, status='captured', captured_at=? WHERE id=? AND status != 'rolled_back'",
    )
    .run(captureSummary, now(), scopeId);
}

/** Mark a checkpoint scope rolled back (later runs turned over). */
export function markScopeRolledBack(store: HostStore, scopeId: string): void {
  store.db
    .prepare("UPDATE checkpoint_scopes SET status='rolled_back' WHERE id=?")
    .run(scopeId);
}

/** All checkpoint scopes for a session, parent before child. */
export function checkpointScopes(
  store: HostStore,
  sessionId: string,
): CheckpointScope[] {
  const rows = store.db
    .prepare(
      `SELECT id,
              parent_id AS parentId,
              session_id AS sessionId,
              run_ordinal AS runOrdinal,
              advances_app_run_count AS advancesAppRunCount,
              baseline_summary AS baselineSummary,
              capture_summary AS captureSummary,
              status,
              created_at AS createdAt,
              captured_at AS capturedAt
       FROM checkpoint_scopes
       WHERE session_id=?
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as unknown as CheckpointScope[];
  return rows.map((row) => ({
    ...row,
    advancesAppRunCount: Boolean(row.advancesAppRunCount),
    ...(row.parentId == null ? { parentId: undefined } : {}),
  }));
}