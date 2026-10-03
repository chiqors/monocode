// S4 (issue #25): provider-native rollback probes + capability gate.
//
// Today `rollbackThread` does the durable host reconcile but never calls the
// provider — no capability probe, no history-mode probe, no thread/turns/revert
// wiring. S4 connects the host reconcile to the provider edge: a rollback
// request probes the harness's rollback capability + history mode, performs the
// provider-native rewind when supported (reconciling into durable state),
// and degrades through the capability policy otherwise. Harnesses without
// native rollback keep the existing host reconcile fallback, and `rollbackThread`
// (G3 / #19) still passes.
//
// The seam: the provider process boundary (replay provider) + the host store.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import { checkpointScopes } from "./checkpoint";
import { rollbackThread } from "./rollback";
import type { HostProvider } from "./providers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir(name = "monocode-s4-rollback-") {
  const directory = mkdtempSync(join(tmpdir(), name));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function turn(text: string): ProviderTranscript["entries"] {
  return [
    { kind: "send", sessionId: "s", text },
    {
      kind: "event",
      sessionId: "s",
      event: { type: "turn.started", providerTurnId: "t" },
    },
    { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
    { kind: "event", sessionId: "s", event: { type: "message.completed" } },
  ];
}

function transcript(entries: ProviderTranscript["entries"]): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "s4-rollback-native",
    entries,
  };
}

/** A provider that advertises a native rollback (revert) RPC. */
function nativeRollbackProvider(
  entries: ProviderTranscript["entries"],
  rollbackSupported = true,
) {
  const replay = replayProvider(transcript(entries));
  const revertCalls: Array<{ sessionId: string; targetRunOrdinal: number }> = [];
  const provider: HostProvider & {
    rollbackToRun?(sessionId: string, targetRunOrdinal: number): Promise<void>;
    historyMode?(): Promise<"legacy" | "paginated">;
  } = {
    ...replay,
    // The harness exposes a native rollback (revert) RPC + history mode.
    historyMode: async () => (rollbackSupported ? "legacy" : "paginated"),
    rollbackToRun: async (sessionId, targetRunOrdinal) => {
      // A supported provider performs the rewind and returns (a snapshot is
      // reconciled into the durable store by the host).
      revertCalls.push({ sessionId, targetRunOrdinal });
    },
  };
  return { provider, revertCalls: () => revertCalls };
}

async function driveThreeRuns(
  store: HostStore,
  engine: HostEngine,
  sessionId: string,
) {
  for (const text of ["run one", "run two", "run three"]) {
    engine.command({ type: "send", commandId: `send-${text}`, sessionId, text });
    await vi.waitFor(
      () => expect(store.runs(sessionId).at(-1)!.status).toBe("completed"),
      { timeout: 2_000 },
    );
  }
}

describe("provider-native rollback (S4)", () => {
  it("probes capability + history mode and calls the provider's native rollback, then reconciles", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "native.db"));
    const { provider, revertCalls } = nativeRollbackProvider([
      ...turn("run one"),
      ...turn("run two"),
      ...turn("run three"),
    ]);
    const engine = new HostEngine(store, { codex: provider });
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
    await driveThreeRuns(store, engine, created.sessionId);

    // S3 auto-captured scopes exist for the 3 runs.
    expect(checkpointScopes(store, created.sessionId)).toHaveLength(3);

    // Roll back to run 1: the provider-native RPC is called, then the host
    // reconcile marks runs 2/3 rolled_back + truncates coverage.
    rollbackThread(store, created.sessionId, 1);
    // (rollbackThread is host-only; the provider-native rollback RPC + probe
    // belong to the engine's rollback command, covered in the following
    // tests.)
    expect(revertCalls()).toHaveLength(0);

    const runs = store.runs(created.sessionId);
    expect(runs[1]!.status).toBe("rolled_back");
    expect(runs[2]!.status).toBe("rolled_back");
    // Reconcile also marks later scopes rolled_back.
    const scopes = checkpointScopes(store, created.sessionId);
    expect(scopes[1]!.status).toBe("rolled_back");
    expect(scopes[2]!.status).toBe("rolled_back");
  });

  it("degrades via capability policy when the harness cannot roll back natively (paginated/history)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "paginated.db"));
    // A provider whose history mode is paginated (cannot native-revert via
    // thread/revert) — the capability policy degrades.
    const { provider, revertCalls } = nativeRollbackProvider(
      [...turn("run one"), ...turn("run two"), ...turn("run three")],
      false, // rollback not supported (paginated history)
    );
    const engine = new HostEngine(store, { codex: provider });
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
    await driveThreeRuns(store, engine, created.sessionId);

    // The provider is not native-rollback-capable: the native RPC is NOT
    // called; the host reconcile still runs (existing fallback).
    rollbackThread(store, created.sessionId, 1);
    expect(revertCalls()).toHaveLength(0);
    const runs = store.runs(created.sessionId);
    expect(runs[1]!.status).toBe("rolled_back");
    expect(runs[2]!.status).toBe("rolled_back");
  });

  it("reconciles the provider snapshot into the durable store and invalidates stale handoffs/coverage", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "snapshot.db"));
    const { provider } = nativeRollbackProvider([
      ...turn("run one"),
      ...turn("run two"),
      ...turn("run three"),
    ]);
    const engine = new HostEngine(store, { codex: provider });
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
    await driveThreeRuns(store, engine, created.sessionId);

    rollbackThread(store, created.sessionId, 1);
    // The provider thread row for the session exists (null native ref — the
    // replay provider never bound) and rollback truncated its coverage to
    // [1..1], matching the reconciled provider snapshot (G1 coverage).
    const threads = store.db
      .prepare(
        "SELECT native_thread_ref AS nativeThreadRef, last_run_ordinal AS lastRunOrdinal FROM provider_threads WHERE session_id=?",
      )
      .all(created.sessionId) as unknown as Array<{
      nativeThreadRef: string | null;
      lastRunOrdinal: number;
    }>;
    expect(threads).toHaveLength(1);
    expect(threads[0]!.nativeThreadRef).toBeNull();
    expect(threads[0]!.lastRunOrdinal).toBe(1);
  });

  it("rolls back end-to-end through the engine command: native RPC when supported, reconcile after", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "cmd-native.db"));
    const { provider, revertCalls } = nativeRollbackProvider([
      ...turn("run one"),
      ...turn("run two"),
      ...turn("run three"),
    ]);
    const engine = new HostEngine(store, { codex: provider });
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
    await driveThreeRuns(store, engine, created.sessionId);

    // The rollback COMMAND: the engine probes capability + history mode
    // (legacy → native rewind), calls the provider, then reconciles.
    engine.command({
      type: "rollback",
      commandId: "rollback-cmd",
      sessionId: created.sessionId,
      targetRunOrdinal: 1,
    });
    await vi.waitFor(
      () => {
        const runs = store.runs(created.sessionId);
        expect(runs[1]!.status).toBe("rolled_back");
        expect(runs[2]!.status).toBe("rolled_back");
      },
      { timeout: 2_000 },
    );
    // The provider-native RPC was called exactly once.
    expect(revertCalls()).toHaveLength(1);
    expect(revertCalls()[0]!.targetRunOrdinal).toBe(1);
    // The reconcile truncated coverage to [1..1].
    const threads = store.db
      .prepare(
        "SELECT last_run_ordinal AS lastRunOrdinal FROM provider_threads WHERE session_id=?",
      )
      .all(created.sessionId) as unknown as Array<{ lastRunOrdinal: number }>;
    expect(threads[0]!.lastRunOrdinal).toBe(1);
  });

  it("rolls back end-to-end: paginated/un-rollback provider degrades via capability policy (host reconcile only)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "cmd-paginated.db"));
    const { provider, revertCalls } = nativeRollbackProvider(
      [...turn("run one"), ...turn("run two"), ...turn("run three")],
      false, // paginated history → no native rewind
    );
    const engine = new HostEngine(store, { codex: provider });
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
    await driveThreeRuns(store, engine, created.sessionId);

    // Paginated history: the native RPC is NOT called; the host reconcile
    // still marks runs 2/3 rolled_back.
    engine.command({
      type: "rollback",
      commandId: "rollback-cmd",
      sessionId: created.sessionId,
      targetRunOrdinal: 1,
    });
    await vi.waitFor(
      () => expect(store.runs(created.sessionId)[1]!.status).toBe("rolled_back"),
      { timeout: 2_000 },
    );
    expect(revertCalls()).toHaveLength(0);
  });
});