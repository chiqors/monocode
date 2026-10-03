// G1a (issue #15): ProviderThread as a first-class durable entity.
//
// A durable `provider_threads` entity records an App thread's history per
// provider: a resume cursor (`nativeThreadRef`), per-provider coverage
// (`firstRunOrdinal` / `lastRunOrdinal`, i.e. the covered run range), and
// `handoffIds`. Provider-native ids are kept as refs (evidence), never app
// identity — the app thread (session) id remains primary.
//
// Coverage is derived from the durable run store: the covered range tells a
// later switch-back which runs the provider has already seen, so a delta
// handoff is derivable (not stored as a chain), per the V2 delta-vs-full
// summary design. The store records one row per (session, provider), upserting
// as coverage extends and handoffs accumulate.
import type { HarnessId } from "../src/features/sessions/model/session";
import type { HostStore } from "./store";

/** The covered run range a provider thread has seen, as run ordinals. */
export type ProviderThread = {
  /** App-owned identity, derived from a session id (never a native id). */
  sessionId: string;
  /** Which harness this thread belongs to. */
  provider: HarnessId;
  /** Provider-native thread ref — evidence for resume, never identity. */
  nativeThreadRef: string | null;
  /** First app run ordinal this provider thread has covered. */
  firstRunOrdinal: number | null;
  /** Last app run ordinal this provider thread has covered. */
  lastRunOrdinal: number | null;
  /** Durable handoff ids recorded into/out of this provider thread. */
  handoffIds: string[];
  createdAt: number;
};

/** Insert or extend the durable ProviderThread for (session, provider). */
export function recordProviderThread(
  store: HostStore,
  thread: Omit<ProviderThread, "createdAt"> & { createdAt?: number },
): void {
  const now = thread.createdAt ?? Date.now();
  store.db
    .prepare(
      `INSERT INTO provider_threads
         (session_id, provider, native_thread_ref, first_run_ordinal, last_run_ordinal, handoff_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, provider) DO UPDATE SET
         native_thread_ref=COALESCE(excluded.native_thread_ref, native_thread_ref),
         first_run_ordinal=MIN(first_run_ordinal, excluded.first_run_ordinal),
         last_run_ordinal=MAX(last_run_ordinal, excluded.last_run_ordinal),
         handoff_ids=excluded.handoff_ids`,
    )
    .run(
      thread.sessionId,
      thread.provider,
      thread.nativeThreadRef,
      thread.firstRunOrdinal,
      thread.lastRunOrdinal,
      JSON.stringify(thread.handoffIds),
      now,
    );
}

/** All durable ProviderThreads for an App thread, insertion order. */
export function providerThreads(
  store: HostStore,
  sessionId: string,
): ProviderThread[] {
  const rows = store.db
    .prepare(
      `SELECT session_id AS sessionId,
              provider,
              native_thread_ref AS nativeThreadRef,
              first_run_ordinal AS firstRunOrdinal,
              last_run_ordinal AS lastRunOrdinal,
              handoff_ids AS handoffIds,
              created_at AS createdAt
       FROM provider_threads
       WHERE session_id=?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(sessionId) as unknown as Array<
    Omit<ProviderThread, "handoffIds"> & { handoffIds: string }
  >;
  return rows.map((row) => ({
    ...row,
    handoffIds: JSON.parse(row.handoffIds) as string[],
  }));
}