# Entity Ids And Correlation

The T3 principle, implemented in `host/correlation.ts`:

> **App ids are primary. Provider ids are refs (evidence).**

Every durable app entity (session, run, node, handoff, effect) uses an
app-owned id as its primary key. Provider-native ids (`providerSessionId`,
`providerThreadId`, native turn/item refs) are stored only as optional
correlation refs for debugging, replay, and command routing — never as app
identity.

## The binding table

```ts
type ProviderBinding = {
  appEntityKind: "session";      // first supported kind; the shape extends
  appEntityId: string;           // app-owned id (the primary identity)
  provider: HarnessId;           // which harness produced the ref
  nativeRef: string;             // provider-native reference — evidence only
  correlation: CorrelationStrategy;
  createdAt: number;
};

type CorrelationStrategy =
  | "native_exact"   // strong native id, used directly
  | "native_scoped"  // native id valid only inside a scope (session/turn)
  | "ordinal"        // deterministic scoped ordinal (weak providers)
  | "synthetic";     // app-owned synthetic id (weakest providers)
```

Persisted in `provider_bindings(app_entity_kind, app_entity_id, provider,
native_ref, correlation, created_at)`, primary keyed on
`(app_entity_kind, app_entity_id, provider)` — one binding per app entity per
provider.

## API

`host/correlation.ts`:

- `bindProviderRef(store, binding)` — idempotent insert/update
  (`ON CONFLICT ... DO UPDATE`).
- `findProviderRef(store, { appEntityKind, appEntityId, provider })` — the
  binding, or `undefined`.

`HostStore` also tracks `provider_bindings` natively, and the engine calls
`bindProviderRef` when a harness event carries a provider-native id (e.g.
`session.providerBound` with a `providerSessionId`).

## How correlation works with the replay harness

The correlation module is exercised end to end through the replay harness
(`host/correlation.test.ts`): a transcript contains a `session.providerBound`
event carrying a native ref; replaying it through the real engine binds the
ref to the app session id. Replaying the same transcript again finds the
existing binding instead of creating a second entity — this is what makes
replay idempotent (`host/replay.test.ts`).

## Weak providers

When a provider has no stable native id, the app allocates its own (`synthetic`
correlation). The app id is allocated once and never changes for that entity;
re-processing the same provider evidence finds the existing binding, it does
not allocate another entity.

## What is NOT implemented (deliberately)

t3code V2 defines a richer correlation model:

- per-scope matching keys (never match a native id globally — always scoped by
  `provider + session + thread`);
- fallback tiers within a scope (native exact → scoped → ordinal → fingerprint);
- `nativeKind` + a full `scope` object on each binding.

MonoCode uses a flat `(kind, id, provider) → ref` map with a single strategy
column today. That covers the shipped verticals; the richer scope-aware story
is listed in [remaining-gaps.md](remaining-gaps.md).

## Terminology

Per `CONTEXT.md`, MonoCode does **not** adopt t3code's "context transfer"
vocabulary. The app-owned identity stays "Session"/"App thread", and the
provider-ref map is the "correlation store." Keep that language when writing
code or issues.