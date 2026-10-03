// T3 (issue #4) + G6 (issue #18): app-owned identity + provider-ref
// correlation.
//
// App ids are primary; provider-native ids are refs (evidence). This module
// owns the durable correlation table that maps app entities to provider refs,
// so weak providers get deterministic app-owned ids and replayed transcripts
// find existing bindings instead of duplicating them.
//
// G6 adds scoped correlation keys: a binding now records `nativeKind` (what
// kind of native object the ref is — conversation, thread, account, ...) and
// a `scope` (the native namespace that disambiguates it), and the correlation
// strategy tiers from strongest to weakest — native exact → scoped → ordinal
// → fingerprint. `pickCorrelationStrategy` maps a provider's identity tier to
// the strongest strategy it can support, so weak providers (no stable native
// id) get a deterministic app-owned id via the scoped/ordinal tier instead of
// overclaiming native_exact.
import type { HarnessId } from "../src/features/sessions/model/session";
import type { HostStore } from "./store";
import type { IdentityTier } from "./capabilities";

export type CorrelationStrategy =
  | "native_exact"
  | "native_scoped"
  | "ordinal"
  | "synthetic"
  | "fingerprint";

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
  /** G6: what kind of native object the ref is (conversation, thread, ...). */
  nativeKind?: string;
  /** G6: the native namespace that scopes the ref (project:/repo, account, ...). */
  scope?: string;
  createdAt: number;
};

/**
 * Strongest correlation strategy a provider can support, by identity tier.
 * strong → native exact; weak → scoped (native ids exist but need a scope);
 * none → fingerprint (deterministic app-owned id from the ref's fingerprint).
 */
export function pickCorrelationStrategy(tier: IdentityTier): CorrelationStrategy {
  switch (tier) {
    case "strong":
      return "native_exact";
    case "weak":
      return "native_scoped";
    case "none":
      return "fingerprint";
  }
}

/** Bind a provider ref to an app entity id, idempotently. */
export function bindProviderRef(
  store: HostStore,
  binding: Omit<ProviderBinding, "createdAt">,
): void {
  store.db
    .prepare(
      `INSERT INTO provider_bindings
         (app_entity_kind, app_entity_id, provider, native_ref, correlation, native_kind, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_entity_kind, app_entity_id, provider) DO UPDATE SET
         native_ref=excluded.native_ref,
         correlation=excluded.correlation,
         native_kind=excluded.native_kind,
         scope=excluded.scope`,
    )
    .run(
      binding.appEntityKind,
      binding.appEntityId,
      binding.provider,
      binding.nativeRef,
      binding.correlation,
      binding.nativeKind ?? null,
      binding.scope ?? null,
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
              native_kind AS nativeKind,
              scope,
              created_at AS createdAt
       FROM provider_bindings
       WHERE app_entity_kind=? AND app_entity_id=? AND provider=?`,
    )
    .get(scope.appEntityKind, scope.appEntityId, scope.provider) as
    | ProviderBinding
    | undefined;
  return row;
}