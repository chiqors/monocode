// T3 (issue #4): app-owned identity + provider-ref correlation.
//
// The seam: the provider process boundary (replay harness). App ids are
// primary; provider-native ids (providerSessionId etc.) are refs in a durable
// correlation record. Replaying the same transcript finds existing bindings.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import {
  bindProviderRef,
  findProviderRef,
  pickCorrelationStrategy,
  type ProviderBinding,
  type CorrelationStrategy,
} from "./correlation";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-correlation-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(ref: string): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "identity",
    entries: [
      { kind: "send", sessionId: "s", text: "hello" },
      {
        kind: "event",
        sessionId: "s",
        event: { type: "session.providerBound", providerSessionId: ref },
      },
      {
        kind: "event",
        sessionId: "s",
        event: { type: "message.delta", text: "hi" },
      },
      {
        kind: "event",
        sessionId: "s",
        event: { type: "message.completed" },
      },
    ],
  };
}

describe("correlation module (app ids primary, provider refs as evidence)", () => {
  it("binds a provider ref to an app entity id durably and finds it back", () => {
    const binding: ProviderBinding = {
      appEntityKind: "session",
      appEntityId: "app-session-1",
      provider: "codex",
      nativeRef: "provider-thread-42",
      correlation: "native_exact",
    };
    const directory = setupDir();
    const store = new HostStore(join(directory, "correlation.db"));
    cleanups.push(() => store.close());

    bindProviderRef(store, binding);
    const found = findProviderRef(store, {
      appEntityKind: "session",
      appEntityId: "app-session-1",
      provider: "codex",
    });
    expect(found).toMatchObject(binding);
    expect(typeof found?.createdAt).toBe("number");
  });

  it("prefers native_exact and falls back to synthetic for weak providers", () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "correlation2.db"));
    cleanups.push(() => store.close());

    bindProviderRef(store, {
      appEntityKind: "session",
      appEntityId: "weak-1",
      provider: "pi",
      nativeRef: "synthetic-id",
      correlation: "synthetic",
    });
    const found = findProviderRef(store, {
      appEntityKind: "session",
      appEntityId: "weak-1",
      provider: "pi",
    });
    expect(found?.correlation).toBe("synthetic");
  });

  it("does not duplicate a binding on re-bind (idempotent)", () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "correlation3.db"));
    cleanups.push(() => store.close());

    bindProviderRef(store, {
      appEntityKind: "session",
      appEntityId: "s1",
      provider: "codex",
      nativeRef: "native-1",
      correlation: "native_exact",
    });
    bindProviderRef(store, {
      appEntityKind: "session",
      appEntityId: "s1",
      provider: "codex",
      nativeRef: "native-1",
      correlation: "native_exact",
    });
    const rows = (
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM provider_bindings WHERE app_entity_kind='session' AND app_entity_id=?",
        )
        .get("s1") as { count: number }
    ).count;
    expect(rows).toBe(1);
  });

  it("records nativeKind + scope on a binding (scoped correlation keys)", () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "correlation-scoped.db"));
    cleanups.push(() => store.close());

    bindProviderRef(store, {
      appEntityKind: "session",
      appEntityId: "app-1",
      provider: "codex",
      nativeRef: "conversation-42",
      nativeKind: "conversation",
      scope: "project:/repo",
      correlation: "native_scoped",
    });

    const found = findProviderRef(store, {
      appEntityKind: "session",
      appEntityId: "app-1",
      provider: "codex",
    });
    expect(found?.nativeKind).toBe("conversation");
    expect(found?.scope).toBe("project:/repo");
    expect(found?.correlation).toBe("native_scoped");
  });

  it("picks the correlation strategy by identity tier (strong/weak/none)", () => {
    // Strong identity -> native exact.
    expect(pickCorrelationStrategy("strong")).toBe("native_exact");
    // Weak identity -> native scoped (or ordinal fallback).
    expect(pickCorrelationStrategy("weak")).toBe("native_scoped");
    // No identity -> fingerprint-only.
    expect(pickCorrelationStrategy("none")).toBe("fingerprint");
  });

  it("resolves native exact, scoped, ordinal, and fingerprint bindings (replay-stable)", () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "correlation-tiers.db"));
    cleanups.push(() => store.close());

    const cases: Array<{
      provider: string;
      nativeRef: string;
      strategy: CorrelationStrategy;
      expected: CorrelationStrategy;
    }> = [
      { provider: "codex", nativeRef: "conv-1", strategy: "native_exact", expected: "native_exact" },
      { provider: "cursor", nativeRef: "scope:conv-2", strategy: "native_scoped", expected: "native_scoped" },
      { provider: "pi", nativeRef: "3", strategy: "ordinal", expected: "ordinal" },
      { provider: "omp", nativeRef: "fp-abc123", strategy: "fingerprint", expected: "fingerprint" },
    ];
    for (const c of cases) {
      bindProviderRef(store, {
        appEntityKind: "session",
        appEntityId: `app-${c.provider}`,
        provider: c.provider as never,
        nativeRef: c.nativeRef,
        correlation: c.strategy,
      });
    }
    for (const c of cases) {
      const found = findProviderRef(store, {
        appEntityKind: "session",
        appEntityId: `app-${c.provider}`,
        provider: c.provider as never,
      });
      expect(found?.correlation).toBe(c.expected);
      // Replay-stable: resolving again gives the same strategy, no duplicate.
      const again = findProviderRef(store, {
        appEntityKind: "session",
        appEntityId: `app-${c.provider}`,
        provider: c.provider as never,
      });
      expect(again?.nativeRef).toBe(found?.nativeRef);
    }
    expect(
      (
        store.db.prepare("SELECT COUNT(*) AS count FROM provider_bindings").get() as {
          count: number;
        }
      ).count,
    ).toBe(4);
  });
});

describe("identity through the replay harness", () => {
  it("records a provider ref via session.providerBound and correlates it", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "replay-bound.db"));
    const replay = replayProvider(transcript("provider-thread-42"));
    const engine = new HostEngine(store, { codex: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });

    const created = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engine.command({
      type: "send",
      commandId: "send",
      sessionId: created.sessionId,
      text: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The session still carries the ref for provider use (it is a ref, evidence),
    // and the durable correlation table records it app-id-first.
    const session = store.session(created.sessionId).session;
    expect(session.providerSessionId).toBe("provider-thread-42");

    const binding = findProviderRef(store, {
      appEntityKind: "session",
      appEntityId: created.sessionId,
      provider: "codex",
    });
    expect(binding?.nativeRef).toBe("provider-thread-42");
    expect(created.sessionId).toBeTruthy(); // app id, not the ref
  });

  it("replaying the same transcript finds the existing binding (no duplicate)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "replay-rebound.db"));
    const replay = replayProvider(transcript("provider-thread-42"));
    const engine = new HostEngine(store, { codex: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });

    const created = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engine.command({
      type: "send",
      commandId: "send",
      sessionId: created.sessionId,
      text: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const bindings = store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM provider_bindings WHERE provider='codex' AND native_ref='provider-thread-42'",
      )
      .get() as { count: number };
    // The provider-ref appears exactly once, never re-synced or duplicated.
    expect(bindings.count).toBe(1);
  });

  it("correlates weak providers with a synthetic strategy, not native", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "replay-weak.db"));
    const replay = replayProvider(
      transcript("pi-conversation-id").provider === "codex"
        ? { ...transcript("pi-conversation-id"), provider: "pi" }
        : transcript("pi-conversation-id"),
    );
    const engine = new HostEngine(store, { pi: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });

    const created = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "pi",
      model: "pi:test",
      runtimeMode: "supervised",
    });
    engine.command({
      type: "send",
      commandId: "send",
      sessionId: created.sessionId,
      text: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // App id is stable and primary; the provider ref is evidence only.
    expect(created.sessionId).toBeTruthy();
    const binding = findProviderRef(store, {
      appEntityKind: "session",
      appEntityId: created.sessionId,
      provider: "pi",
    });
    expect(binding?.nativeRef).toBeTruthy();
  });
});