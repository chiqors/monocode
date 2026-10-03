// F1 (issue #9): durable effect outbox.
//
// Provider effects (turn.start / interrupt / rollback / fork) are enqueued
// durably BEFORE dispatch, marked in-flight, then done — so a restart resumes
// a half-sent effect without losing or double-dispatching it. This replaces
// the in-memory-only reactor + retry for the effects that must survive a
// restart.
import type { HostStore } from "./store";

export type ProviderEffectKind =
  | "turn.start"
  | "interrupt"
  | "rollback"
  | "fork";

export type ProviderEffect = {
  sessionId: string;
  runId: string;
  kind: ProviderEffectKind;
  payload?: unknown;
};

export type ProviderEffectRow = ProviderEffect & {
  /** pending | in-flight | done */
  status: "pending" | "in-flight" | "done";
  attempts: number;
  createdAt: number;
};

/** Enqueue a provider effect durably, before dispatch. */
export function enqueueProviderEffect(
  store: HostStore,
  effect: ProviderEffect,
): void {
  store.db
    .prepare(
      `INSERT INTO provider_effects
         (session_id, run_id, kind, payload, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?)
       ON CONFLICT(session_id, run_id, kind) DO NOTHING`,
    )
    .run(
      effect.sessionId,
      effect.runId,
      effect.kind,
      effect.payload == null ? null : JSON.stringify(effect.payload),
      Date.now(),
    );
}

/** Mark a pending effect in-flight (bump attempts if provided). */
export function markEffectInFlight(
  store: HostStore,
  sessionId: string,
  runId: string,
  options: { attempts?: number } = {},
): void {
  const attempts = options.attempts ?? 0;
  store.db
    .prepare(
      `UPDATE provider_effects
       SET status='in-flight', attempts=?1
       WHERE session_id=?2 AND run_id=?3 AND kind='turn.start'`,
    )
    .run(attempts, sessionId, runId);
}

/** Mark an effect done (idempotent: no-op if already gone). */
export function markEffectDone(
  store: HostStore,
  sessionId: string,
  runId: string,
): void {
  store.db
    .prepare(
      "DELETE FROM provider_effects WHERE session_id=? AND run_id=?",
    )
    .run(sessionId, runId);
}

/** All effects still pending or in-flight (the outbox read). */
export function pendingEffects(store: HostStore): ProviderEffectRow[] {
  return store.db
    .prepare(
      `SELECT session_id AS sessionId,
              run_id AS runId,
              kind,
              payload,
              status,
              attempts,
              created_at AS createdAt
       FROM provider_effects
       WHERE status != 'done'
       ORDER BY created_at ASC`,
    )
    .all() as unknown as ProviderEffectRow[];
}