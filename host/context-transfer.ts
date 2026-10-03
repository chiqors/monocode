// G2 (issue #17): lazy fork resolution — the pending ContextTransfer.
//
// Forking is cheap: create the target App thread + a pending `ContextTransfer`
// (type `fork`). No provider session/thread/context handoff happens until the
// fork's FIRST dispatch resolves the transfer (native fork when possible, else
// portable context). The durable `context_transfers` row is the idempotent
// record of that intent: exactly one per (fork, type), resolved once.
//
// Uses MonoCode vocabulary per CONTEXT.md — "ContextTransfer" is the durable
// pending-fork record (the t3code term is deliberately used only for the
// host-side entity, mirroring the reference shape).
import type { HostStore } from "./store";
import { now, uuid } from "./determinism";

export type ContextTransferState = "pending" | "resolved" | "superseded";
export type ContextTransferType = "fork";

export type ContextTransfer = {
  id: string;
  sourceSessionId: string;
  forkSessionId: string;
  type: ContextTransferType;
  state: ContextTransferState;
  /** Resolution payload (e.g. { summary } for portable-context resolution). */
  payload?: unknown;
  createdAt: number;
};

/** Create a pending fork transfer idempotently (one per fork session + type). */
export function createForkTransfer(
  store: HostStore,
  scope: { sourceSessionId: string; forkSessionId: string },
): string {
  const id = uuid();
  store.db
    .prepare(
      `INSERT INTO context_transfers
         (id, source_session_id, fork_session_id, type, state, payload, created_at)
       VALUES (?, ?, ?, 'fork', 'pending', NULL, ?)
       ON CONFLICT(fork_session_id, type) DO NOTHING`,
    )
    .run(id, scope.sourceSessionId, scope.forkSessionId, now());
  const row = store.db
    .prepare(
      "SELECT id FROM context_transfers WHERE fork_session_id=? AND type='fork'",
    )
    .get(scope.forkSessionId) as { id: string } | undefined;
  return row!.id;
}

/** The pending fork transfer for a fork session, or undefined once resolved. */
export function pendingForkTransfer(
  store: HostStore,
  forkSessionId: string,
): ContextTransfer | undefined {
  const row = store.db
    .prepare(
      `SELECT id,
              source_session_id AS sourceSessionId,
              fork_session_id AS forkSessionId,
              type,
              state,
              payload,
              created_at AS createdAt
       FROM context_transfers
       WHERE fork_session_id=? AND type='fork' AND state='pending'`,
    )
    .get(forkSessionId) as
    | (Omit<ContextTransfer, "payload"> & { payload: string | null })
    | undefined;
  if (!row) return undefined;
  return {
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : undefined,
  };
}

/** Mark a pending fork transfer resolved with a resolution payload. */
export function resolveForkTransfer(
  store: HostStore,
  forkSessionId: string,
  resolution: { summary: string },
): void {
  store.db
    .prepare(
      "UPDATE context_transfers SET state='resolved', payload=? WHERE fork_session_id=? AND type='fork' AND state='pending'",
    )
    .run(JSON.stringify(resolution), forkSessionId);
}