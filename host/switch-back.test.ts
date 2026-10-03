// G1b (issue #16): switch-back resumes the prior ProviderThread with a delta
// handoff.
//
// Switching back to a provider that has a prior ProviderThread (from G1a)
// resumes that thread (via its nativeThreadRef resume cursor + provider.bind)
// and injects a delta handoff covering only the runs that happened while it
// was absent, derived from the durable run store — instead of creating a fresh
// target session. A full summary + fresh thread remains the fallback when the
// delta/resume is impossible.
//
// The seam: the provider process boundary (replay harness) + the host store,
// following the G1a/T2/T3 pattern.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostProvider } from "./providers";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import { providerThreads } from "./provider-thread";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A completed single turn: send + providerBound + terminal events. */
function turn(nativeRef: string, prompt: string): ProviderTranscript["entries"] {
  return [
    { kind: "send", sessionId: "s", text: prompt },
    { kind: "event", sessionId: "s", event: { type: "turn.started", providerTurnId: "t" } },
    {
      kind: "event",
      sessionId: "s",
      event: { type: "session.providerBound", providerSessionId: nativeRef },
    },
    { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
    { kind: "event", sessionId: "s", event: { type: "message.completed" } },
  ];
}

/**
 * Replay provider whose `bind` records resume requests (the observable
 * provider-boundary side of "resume the prior provider thread").
 */
function bindRecordingReplay(
  entries: ProviderTranscript["entries"],
  harness: "codex" | "cursor",
) {
  const binds: Array<{ threadId: string; providerId: string; cwd: string }> = [];
  const replay = replayProvider({
    format: "monocode-replay-v1",
    provider: harness,
    scenario: "switch-back",
    entries,
  });
  const provider: HostProvider = {
    ...replay,
    bind: (threadId, providerId, cwd) => {
      binds.push({ threadId, providerId, cwd });
    },
  };
  return { provider, binds, calls: replay.calls };
}

/** Drive one full turn through the real engine to settlement (provider seam). */
async function settleTurn(engine: HostEngine, sessionId: string, text: string) {
  engine.command({
    type: "send",
    commandId: `send-${Math.random().toString(36).slice(2)}`,
    sessionId,
    text,
  });
  await vi.waitFor(
    () => {
      const runs = engine.store.runs(sessionId);
      expect(runs.at(-1)?.status).toBe("completed");
    },
    { timeout: 2_000 },
  );
}

describe("switch-back resume (G1b)", () => {
  it("resumes the prior ProviderThread with a delta handoff on switch-back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "monocode-g1b-test-"));
    const store = new HostStore(join(directory, "g1b.db"));
    const codex = bindRecordingReplay(turn("native-a-1", "run on codex one"), "codex");
    const cursor = bindRecordingReplay(turn("native-b-1", "run on cursor"), "cursor");
    const engine = new HostEngine(store, { codex: codex.provider, cursor: cursor.provider });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const created = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });

    // --- Run 1 on codex (provider A). providerBound binds native-a-1. ---
    await settleTurn(engine, created.sessionId, "run on codex one");
    const threadA = providerThreads(store, created.sessionId).find(
      (t) => t.provider === "codex",
    )!;
    expect(threadA.nativeThreadRef).toBe("native-a-1");
    expect(threadA.firstRunOrdinal).toBe(1);
    expect(threadA.lastRunOrdinal).toBe(1);

    // --- Switch away to cursor (A -> B). The departure handoff links into A. ---
    engine.command({
      type: "configure",
      commandId: "switch",
      sessionId: created.sessionId,
      harness: "cursor",
      model: "cursor:test",
      runtimeMode: "supervised",
    });

    // --- Run 2 on cursor (provider B). providerBound binds native-b-1. ---
    await settleTurn(engine, created.sessionId, "run on cursor");
    const threadB = providerThreads(store, created.sessionId).find(
      (t) => t.provider === "cursor",
    )!;
    expect(threadB.nativeThreadRef).toBe("native-b-1");
    expect(threadB.firstRunOrdinal).toBe(2);
    expect(threadB.lastRunOrdinal).toBe(2);

    // --- Switch back to codex (B -> A). ---
    engine.command({
      type: "configure",
      commandId: "switch-back",
      sessionId: created.sessionId,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });

    // 1) The session resumes the prior native thread: providerSessionId is the
    //    resume cursor (nativeThreadRef), not cleared to a fresh target.
    const session = store.session(created.sessionId).session;
    expect(session.providerSessionId).toBe("native-a-1");
    expect(session.harness).toBe("codex");

    // 2) The provider was asked to bind/resume that native thread.
    const resumeBind = codex.binds.find((b) => b.providerId === "native-a-1");
    expect(resumeBind).toBeTruthy();
    expect(resumeBind!.threadId).toBe(created.sessionId);

    // 3) A delta handoff covers only the off-provider run (run 2 on cursor).
    const handoffs = store.db
      .prepare(
        "SELECT id, session_id AS sessionId, provider, run_ordinal AS runOrdinal, handler, summary FROM handoffs WHERE session_id=?",
      )
      .all(created.sessionId) as unknown as {
      id: string;
      sessionId: string;
      provider: string;
      runOrdinal: number;
      handler: string;
      summary: string;
    }[];
    // The handoff row's `provider` is the from-side (the harness being left
    // behind — cursor), consistent with the departure-handoff convention.
    const delta = handoffs.find(
      (h) => h.handler === "switch-back" && h.provider === "cursor",
    );
    expect(delta).toBeTruthy();
    expect(delta!.summary).toContain("run on cursor");
    expect(delta!.summary).not.toContain("run on codex one");

    // 4) The delta handoff is linked into the resumed provider thread.
    const resumed = providerThreads(store, created.sessionId).find(
      (t) => t.provider === "codex",
    )!;
    expect(resumed.handoffIds).toContain(delta!.id);
    // Coverage unchanged: codex has already seen [1..1]; the delta is [2..2].
    expect(resumed.firstRunOrdinal).toBe(1);
    expect(resumed.lastRunOrdinal).toBe(1);
  });

  it("falls back to full summary + fresh thread when no prior thread exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "monocode-g1b-fallback-"));
    const store = new HostStore(join(directory, "g1b-fallback.db"));
    // codex runs twice in this scenario (run 1 + "back on codex"), so its
    // recorded transcript carries two sends.
    const codex = bindRecordingReplay(
      [
        ...turn("native-a-1", "first on codex"),
        ...turn("native-a-1", "back on codex"),
      ],
      "codex",
    );
    const cursor = bindRecordingReplay([], "cursor");
    const engine = new HostEngine(store, { codex: codex.provider, cursor: cursor.provider });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const created = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    await settleTurn(engine, created.sessionId, "first on codex");

    // Switching away to cursor, then straight back to codex (no cursor run).
    engine.command({
      type: "configure",
      commandId: "switch",
      sessionId: created.sessionId,
      harness: "cursor",
      model: "cursor:test",
      runtimeMode: "supervised",
    });
    engine.command({
      type: "configure",
      commandId: "switch-back",
      sessionId: created.sessionId,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });

    // Codex's thread exists and holds the native resume cursor.
    const session = store.session(created.sessionId).session;
    expect(session.harness).toBe("codex");
    expect(session.providerSessionId).toBe("native-a-1");

    // No extra handoff row was recorded for the switch-back (nothing was missed).
    const handoffs = store.db
      .prepare("SELECT handler FROM handoffs WHERE session_id=?")
      .all(created.sessionId) as unknown as { handler: string }[];
    expect(handoffs.every((h) => h.handler !== "switch-back")).toBe(true);
  });

  it("records a full-summary switch-back handoff when the resumed provider has no native resume cursor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "monocode-g1b-weak-"));
    const store = new HostStore(join(directory, "g1b-weak.db"));
    // cursor is a "weak" provider: it never emits providerBound, so its thread
    // has no nativeThreadRef to resume when we switch back to it.
    const cursorNoRef = bindRecordingReplay(
      [
        { kind: "send", sessionId: "s", text: "weak run" },
        { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
        { kind: "event", sessionId: "s", event: { type: "message.completed" } },
      ],
      "cursor",
    );
    // codex runs twice in the weak scenario (run 1 + "back on codex"), so its
    // recorded transcript carries two sends.
    const codex = bindRecordingReplay(
      [
        ...turn("native-a-1", "first on codex"),
        ...turn("native-a-1", "back on codex"),
      ],
      "codex",
    );
    const engine = new HostEngine(store, {
      codex: codex.provider,
      cursor: cursorNoRef.provider,
    });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const created = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    await settleTurn(engine, created.sessionId, "first on codex");

    // Switch to weak cursor, run one turn there (cursor thread, null native
    // ref; coverage [2..2]).
    engine.command({
      type: "configure",
      commandId: "switch",
      sessionId: created.sessionId,
      harness: "cursor",
      model: "cursor:test",
      runtimeMode: "supervised",
    });
    await settleTurn(engine, created.sessionId, "weak run");
    const weakThread = providerThreads(store, created.sessionId).find(
      (t) => t.provider === "cursor",
    )!;
    expect(weakThread.nativeThreadRef).toBeNull();

    // Switch away to codex and run there, so the weak cursor is "left behind"
    // with more work it never saw.
    engine.command({
      type: "configure",
      commandId: "switch-back",
      sessionId: created.sessionId,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    await settleTurn(engine, created.sessionId, "back on codex");

    // Switch back to cursor: cursor has a thread but no native resume cursor,
    // so the delta is impossible and the switch-back records a full summary.
    engine.command({
      type: "configure",
      commandId: "switch-back-to-weak",
      sessionId: created.sessionId,
      harness: "cursor",
      model: "cursor:test",
      runtimeMode: "supervised",
    });

    const handoffs = store.db
      .prepare(
        "SELECT id, provider, handler, summary FROM handoffs WHERE session_id=?",
      )
      .all(created.sessionId) as unknown as {
      id: string;
      provider: string;
      handler: string;
      summary: string;
    }[];
    // The last switch-back handoff is the one into cursor (weak target).
    const full = handoffs
      .filter((h) => h.handler === "switch-back")
      .at(-1);
    expect(full).toBeTruthy();
    expect(full!.provider).toBe("codex"); // from-side of the last switch
    // Full summary covers the whole conversation (the delta is impossible, so
    // it explains all runs).
    expect(full!.summary).toContain("first on codex");
    expect(full!.summary).toContain("weak run");
    expect(full!.summary).toContain("back on codex");
    // The cursor thread's handoffIds gains the full summary handoff.
    const cursorThread = providerThreads(store, created.sessionId).find(
      (t) => t.provider === "cursor",
    )!;
    expect(cursorThread.handoffIds).toContain(full!.id);
  });
});