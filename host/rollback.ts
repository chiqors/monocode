// G3 (issue #19): rollback reconciliation.
//
// Provider rollback (today: the provider's native `thread/revert` / rewind
// capability, driven by codex's rollback or a synthetic restart) is turned
// into a real, durable host flow: runs after the target are marked
// `rolled_back`, the durable ProviderThread (G1) coverage is truncated back to
// the target ordinal, and a `handler: "rollback"` handoff is recorded so a
// subsequent switch-back delta covers exactly the post-rollback runs. The app
// run count never advances on rollback, and no duplicate runs are created —
// rolled-back runs stay for audit, exactly like t3code's "mark later runs
// rolled_back".
import type { HostStore } from "./store";
import { recordHandoff } from "./handoff-summary";
import { providerThreads } from "./provider-thread";
import { checkpointScopes, markScopeRolledBack } from "./checkpoint";

/**
 * Roll a thread back to a target run ordinal. Durable, host-side reconcile:
 * - marks runs after the target `rolled_back` (auditable; never deletes),
 * - truncates the participating ProviderThread coverage back to the target
 *   (so a switch-back delta covers only the post-rollback runs),
 * - records a `handler: "rollback"` handoff as the auditable artifact.
 *
 * The provider-native rollback (probe historyMode / page thread/turns/list /
 * thread/revert) stays in the harness layer behind the existing capability
 * policy; this is the durable state half the host owns.
 */
export function rollbackThread(
  store: HostStore,
  sessionId: string,
  targetRunOrdinal: number,
): void {
  const runs = store.runs(sessionId);
  // Reject an invalid target (must reference an existing ordinal).
  const targetRun = runs.find((r) => r.ordinal === targetRunOrdinal);
  if (!targetRun) throw new Error(`No run at ordinal ${targetRunOrdinal}`);
  // Mark every later run rolled_back (durable, auditable — never deleted).
  for (const run of runs) {
    if (run.ordinal > targetRunOrdinal) {
      store.upsertRun(sessionId, {
        ...run,
        status: "rolled_back",
        endedAt: run.endedAt ?? Date.now(),
      });
    }
  }
  // Truncate each participating ProviderThread's coverage back to the target.
  // (Direct UPDATE: recordProviderThread's MAX-on-last would prevent shrinking
  // the covered range, which is exactly what a rollback must do.)
  for (const thread of providerThreads(store, sessionId)) {
    if (!thread || thread.lastRunOrdinal == null) continue;
    if (thread.lastRunOrdinal > targetRunOrdinal) {
      store.db
        .prepare(
          "UPDATE provider_threads SET last_run_ordinal=? WHERE session_id=? AND provider=?",
        )
        .run(targetRunOrdinal, sessionId, thread.provider);
    }
  }
  // Checkpoints after the target are turned over (the world moved back); the
  // target scope itself is the rollback destination and stays captured.
  for (const scope of checkpointScopes(store, sessionId)) {
    if (scope.runOrdinal > targetRunOrdinal) markScopeRolledBack(store, scope.id);
  }
  // Auditable rollback handoff: the next switch-back delta starts from here.
  recordHandoff(store, {
    sessionId,
    provider: store.session(sessionId).session.harness,
    runOrdinal: targetRunOrdinal,
    summary: `Rolled back to run ${targetRunOrdinal}.`,
    handler: "rollback",
  });
}