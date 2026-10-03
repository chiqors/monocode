// T3 (issue #4): app-owned identity + provider-ref correlation.
//
// App ids are primary; provider-native ids are refs (evidence). This module
// owns the durable correlation table that maps app entities to provider refs,
// so weak providers get deterministic app-owned ids and replayed transcripts
// find existing bindings instead of duplicating them.
import type { HarnessId } from "../src/features/sessions/model/session";
import type { HostStore } from "./store";

export type CorrelationStrategy =
  | "native_exact"
  | "native_scoped"
  | "ordinal"
  | "synthetic";

export type ProviderBinding = {
  /** What app entity this binds (session is the first supported kind). */
  appEntityKind: "session";
  /** App-owned id (the primary identity). */
  appEntityId: string;
  /** Which harness produced the ref. */
  provider: HarnessId;
  /** Provider-native reference — evidence, never identity. */
  nativeRef: string;
  /** How strong the correlation is. */
  correlation: CorrelationStrategy;
  createdAt: number;
};

/** Bind a provider ref to an app entity id, idempotently. */
export function bindProviderRef(
  store: HostStore,
  binding: Omit<ProviderBinding, "createdAt">,
): void {
  store.db
    .prepare(
      `INSERT INTO provider_bindings
         (app_entity_kind, app_entity_id, provider, native_ref, correlation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_entity_kind, app_entity_id, provider) DO UPDATE SET
         native_ref=excluded.native_ref,
         correlation=excluded.correlation`,
    )
    .run(
      binding.appEntityKind,
      binding.appEntityId,
      binding.provider,
      binding.nativeRef,
      binding.correlation,
      Date.now(),
    );
}

/** Find the binding for an app entity + provider, or undefined. */
export function findProviderRef(
  store: HostStore,
  scope: {
    appEntityKind: ProviderBinding["appEntityKind"];
    appEntityId: string;
    provider: HarnessId;
  },
): ProviderBinding | undefined {
  const row = store.db
    .prepare(
      `SELECT app_entity_kind AS appEntityKind,
              app_entity_id AS appEntityId,
              provider,
              native_ref AS nativeRef,
              correlation,
              created_at AS createdAt
       FROM provider_bindings
       WHERE app_entity_kind=? AND app_entity_id=? AND provider=?`,
    )
    .get(scope.appEntityKind, scope.appEntityId, scope.provider) as
    | ProviderBinding
    | undefined;
  return row;
}