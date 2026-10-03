// S2 (issue #23): native fork wiring.
//
// When the harness exposes a native fork RPC and the source point is stable,
// the fork's first dispatch must resolve the pending ContextTransfer as
// NATIVE (recording the strategy + native fork ref) instead of always
// materializing portable context. Stable source points now include captured
// checkpoint scopes, not just terminal runs / idle threads. The path is
// capability-gated: harnesses without native fork still degrade to the
// portable-context Handoff, and the existing lazy-fork behaviour (G2 / #17)
// keeps passing.
//
// The seam: the provider process boundary (replay provider) + the host store.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import { pendingForkTransfer, type ContextTransferResolution } from "./context-transfer";
import { forkThread, resolveForkOnFirstDispatch } from "./fork-merge";
import {
  createCheckpointScope,
  captureCheckpoint,
  checkpointScopes,
} from "./checkpoint";
import type { HostProvider } from "./providers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir(prefix = "monocode-native-fork-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(entries: ProviderTranscript["entries"]): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "native-fork",
    entries,
  };
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

/** A replay provider that also advertises a native fork RPC. */
function nativeForkProvider(entries: ProviderTranscript["entries"]) {
  const replay = replayProvider(transcript(entries));
  const forkCalls: Array<{ sessionId: string; forkSessionId: string }> = [];
  const native: HostProvider & {
    forkSession?(
      sessionId: string,
      forkThreadId: string,
      forkCwd?: string,
    ): Promise<{ sessionId: string }>;
  } = {
    ...replay,
    // The native fork RPC the harness exposes (e.g. OpenCode POST /fork).
    forkSession: async (sessionId, forkThreadId) => ({
      sessionId: `native-fork-thread-${sessionId}-${forkThreadId}`,
    }),
  };
  // Record the native fork call into the replay's transcript so tests can
  // assert the RPC was invoked (the replay provider has no forkSession method;
  // this keeps the native path at the true provider-boundary seam).
  const { forkSession } = native;
  const provider: typeof native = {
    ...native,
    forkSession: async (sessionId, forkThreadId, forkCwd) => {
      forkCalls.push({ sessionId, forkSessionId: forkThreadId });
      return forkSession!(sessionId, forkThreadId, forkCwd);
    },
  };
  return { provider, nativeForkCalls: () => forkCalls };
}

describe("native fork resolution (S2)", () => {
  it("resolves a fork's pending transfer as NATIVE when the harness has a native fork RPC", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "native.db"));
    const { provider, nativeForkCalls } = nativeForkProvider([
      ...turn("run one"),
      ...turn("fork run"),
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
    engine.command({
      type: "send",
      commandId: "send1",
      sessionId: created.sessionId,
      text: "run one",
    });
    await vi.waitFor(
      () => expect(store.runs(created.sessionId)[0]!.status).toBe("completed"),
      { timeout: 2_000 },
    );

    const fork = forkThread(store, created.sessionId, 1);
    // First dispatch: the fork's first send resolves the transfer.
    const resolution = await resolveForkOnFirstDispatch(
      store,
      fork.sessionId,
      provider, // the native-fork-capable provider
    );
    // The native fork was called.
    expect(nativeForkCalls()).toHaveLength(1);
    // The transfer is resolved with a NATIVE strategy + the native ref.
    expect(pendingForkTransfer(store, fork.sessionId)).toBeUndefined();
    // Resolution payload carries strategy native + the native fork thread ref.
    const row = store.db
      .prepare("SELECT payload FROM context_transfers WHERE fork_session_id=?")
      .get(fork.sessionId) as { payload: string } | undefined;
    const payload = JSON.parse(row!.payload) as ContextTransferResolution;
    expect(payload.strategy).toBe("native_fork");
    expect(String(payload.nativeForkRef)).toContain("native-fork-thread-");
    // The auditable summary is still present (the native path keeps it as
    // portable context for review).
    expect(typeof resolution).toBe("string");
    expect(resolution.length).toBeGreaterThan(0);
  });

  it("keeps portable-context fallback when the harness has NO native fork RPC", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "portable.db"));
    const replay = replayProvider(transcript([...turn("run one"), ...turn("fork run")]));
    const provider: HostProvider = { ...replay }; // no forkSession
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
    engine.command({
      type: "send",
      commandId: "send1",
      sessionId: created.sessionId,
      text: "run one",
    });
    await vi.waitFor(
      () => expect(store.runs(created.sessionId)[0]!.status).toBe("completed"),
      { timeout: 2_000 },
    );

    const fork = forkThread(store, created.sessionId, 1);
    const summary = await resolveForkOnFirstDispatch(store, fork.sessionId, provider);
    const row = store.db
      .prepare("SELECT payload FROM context_transfers WHERE fork_session_id=?")
      .get(fork.sessionId) as { payload: string } | undefined;
    const payload = JSON.parse(row!.payload) as ContextTransferResolution;
    // Portable fallback: strategy is portable_context with the summary.
    expect(payload.strategy).toBe("portable_context");
    expect(payload.summary).toBeTruthy();
    expect(typeof summary).toBe("string");
  });

  it("accepts a captured checkpoint scope as a stable fork source point", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "checkpoint.db"));
    const { provider } = nativeForkProvider([
      ...turn("run one"),
      ...turn("run two"),
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
    engine.command({
      type: "send",
      commandId: "send1",
      sessionId: created.sessionId,
      text: "run one",
    });
    await vi.waitFor(
      () => expect(store.runs(created.sessionId)[0]!.status).toBe("completed"),
      { timeout: 2_000 },
    );
    // Capture a checkpoint scope at run 1 (a stable source point).
    const scopeId = createCheckpointScope(store, {
      sessionId: created.sessionId,
      runOrdinal: 1,
      advancesAppRunCount: true,
    });
    captureCheckpoint(store, scopeId, "after run 1");
    expect(checkpointScopes(store, created.sessionId)[0]!.status).toBe("captured");

    // Fork at the checkpoint-stable point: NOT rejected (previously unstable).
    const fork = forkThread(store, created.sessionId, 1);
    // The fork is cheap + pending (no eager provider work/handoff).
    expect(pendingForkTransfer(store, fork.sessionId)).toBeTruthy();
    const handoffs = store.db
      .prepare("SELECT * FROM handoffs WHERE session_id=?")
      .all(fork.sessionId);
    expect(handoffs).toHaveLength(0);
  });

  it("forks end-to-end through the engine command (lazy fork, returns fork id)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "engine-fork.db"));
    const { provider } = nativeForkProvider([
      ...turn("run one"),
      ...turn("fork run"),
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
    engine.command({
      type: "send",
      commandId: "send1",
      sessionId: created.sessionId,
      text: "run one",
    });
    await vi.waitFor(
      () => expect(store.runs(created.sessionId)[0]!.status).toBe("completed"),
      { timeout: 2_000 },
    );

    // The engine fork command: lazy — returns the fork id, creates no handoff.
    const forkReceipt = engine.command({
      type: "fork",
      commandId: "fork-cmd",
      sessionId: created.sessionId,
      forkRunOrdinal: 1,
    });
    expect(forkReceipt.sessionId).toBeTruthy();
    expect(forkReceipt.sessionId).not.toBe(created.sessionId);
    expect(pendingForkTransfer(store, forkReceipt.sessionId)).toBeTruthy();
    const handoffs = store.db
      .prepare("SELECT * FROM handoffs WHERE session_id=?")
      .all(forkReceipt.sessionId);
    expect(handoffs).toHaveLength(0);
  });

  it("rejects the engine fork command from a running (unstable) session", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "engine-fork-running.db"));
    // A provider whose send never completes.
    const replay = replayProvider(
      transcript([{ kind: "send", sessionId: "s", text: "never ends" }]),
    );
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
      commandId: "send1",
      sessionId: created.sessionId,
      text: "never ends",
    });
    await vi.waitFor(() => expect(store.runs(created.sessionId)).toHaveLength(1));

    expect(() =>
      engine.command({
        type: "fork",
        commandId: "fork-running",
        sessionId: created.sessionId,
        forkRunOrdinal: 1,
      }),
    ).toThrow(/unstable|stable source point/i);
  });
});