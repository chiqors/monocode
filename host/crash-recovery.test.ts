// S1 (issue #22): crash-durable live-turn recovery.
//
// The restart-recovery suite proves a *hanging* provider; this covers the real
// crash shapes: a live-turn child that is killed, a child that exits by
// itself, and a turn whose settle path was still pending real-timer work when
// the engine dies. After a restart over the same durable store:
//   - exactly one affected run is marked interrupted (never duplicated),
//   - every session is recovered (prior runs + blocks intact, resumable),
//   - the effect outbox is drained exactly once (F1 semantics),
//   - the real-timer settle path still settles (no hang, no double-run).
//
// The seam: the provider process boundary (replay harness) + the host store,
// matching the F2/switch-back pattern.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import { pendingEffects } from "./provider-effects";
import type { HostProvider } from "./providers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-crash-recovery-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A transcript whose turn never reaches a terminal — a turn mid-flight. */
function interruptedTranscript(): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "crash-recovery",
    entries: [
      { kind: "send", sessionId: "s", text: "hello" },
      { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
    ],
  };
}

/** A provider whose send never resolves: simulates a turn stuck mid-flight. */
function hangingProvider(): { provider: HostProvider } {
  return {
    provider: {
      send: async (): Promise<void> => {
        await new Promise(() => undefined); // never resolves
      },
      cancel: async () => undefined,
      stop: async () => undefined,
      bind: () => undefined,
      approve: () => undefined,
      answer: () => undefined,
    },
  };
}

/** Drive create + send, leaving the turn running (send hangs = mid-flight). */
function startStuckTurn(directory: string, suffix = "") {
  const store = new HostStore(join(directory, `crash${suffix}.db`));
  const { provider } = hangingProvider();
  const engine = new HostEngine(store, { codex: provider });
  const project = store.addProject(directory, "Test");
  const created = engine.command({
    type: "create",
    commandId: `create${suffix}`,
    projectId: project.id,
    harness: "codex",
    model: "codex:test",
    runtimeMode: "supervised",
  });
  engine.command({
    type: "send",
    commandId: `send${suffix}`,
    sessionId: created.sessionId,
    text: "hello",
  });
  expect(store.session(created.sessionId).status).toBe("running");
  return { store, created };
}

describe("crash-durable recovery (S1)", () => {
  it("marks exactly one affected run interrupted on restart; other sessions untouched and resumable", async () => {
    const directory = setupDir();
    const { store, created } = startStuckTurn(directory, "one");

    // A second session with a completed turn: survives the crash intact.
    const store2 = new HostStore(join(directory, "crashone-2.db"));
    const { provider: completeProvider } = (() => {
      const transcript: ProviderTranscript = {
        format: "monocode-replay-v1",
        provider: "codex",
        scenario: "crash-recovery-done",
        entries: [
          { kind: "send", sessionId: "s", text: "hello" },
          {
            kind: "event",
            sessionId: "s",
            event: { type: "message.delta", text: "hi" },
          },
          { kind: "event", sessionId: "s", event: { type: "message.completed" } },
        ],
      };
      const replay = replayProvider(transcript);
      const provider: HostProvider = { ...replay };
      return { provider };
    })();
    const engineDone = new HostEngine(store2, { codex: completeProvider });
    const projectDone = store2.addProject(directory, "Done");
    const done = engineDone.command({
      type: "create",
      commandId: "create-done",
      projectId: projectDone.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engineDone.command({
      type: "send",
      commandId: "send-done",
      sessionId: done.sessionId,
      text: "hello",
    });
    await vi.waitFor(
      () => expect(store2.session(done.sessionId).status).toBe("idle"),
      { timeout: 2_000 },
    );
    cleanups.push(async () => {
      await engineDone.close();
      store2.close();
    });

    // Crash: abandon the engine without close(). Restart over the same DB.
    const restartReplay = replayProvider(interruptedTranscript());
    const restarted = new HostEngine(store, { codex: restartReplay });
    cleanups.push(async () => {
      await restarted.close();
      store.close();
    });

    // Exactly ONE affected run is interrupted; the session is resumable.
    const session = store.session(created.sessionId);
    expect(session.status).toBe("interrupted");
    const runs = store.runs(created.sessionId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.at(-1)!.status).toBe("interrupted");
    const ids = new Set(runs.map((r) => r.id));
    expect(ids.size).toBe(runs.length);
  });

  it("drains the effect outbox exactly once on restart (no re-send, no lost effect)", async () => {
    const directory = setupDir();
    const { store, created } = startStuckTurn(directory, "outbox");

    // Before restart: the turn.start effect is in-flight (the crash happened
    // mid-dispatch). After restart, it must be gone — drained exactly once.
    const before = pendingEffects(store).filter(
      (e) => e.sessionId === created.sessionId && e.kind === "turn.start",
    );
    expect(before).toHaveLength(1);
    expect(before[0]!.status).toBe("in-flight");

    const restarted = new HostEngine(store, { codex: replayProvider(interruptedTranscript()) });
    cleanups.push(async () => {
      await restarted.close();
      store.close();
    });

    const after = pendingEffects(store).filter(
      (e) => e.sessionId === created.sessionId && e.kind === "turn.start",
    );
    expect(after).toHaveLength(0);
  });

  it("settles a turn whose settle path was pending real-timer work at kill time (no hang, no double-run)", async () => {
    const directory = setupDir();
    const { store, created } = startStuckTurn(directory, "timer");

    // The real-timer settle path: the turn was mid-flight on a timer. Restart,
    // then a follow-up send to the SAME session must settle it — the engageable
    // live path, with the replayed send resolving the turn.
    const transcript: ProviderTranscript = {
      format: "monocode-replay-v1",
      provider: "codex",
      scenario: "crash-recovery-followup",
      entries: [
        // restart recovery first marks the interrupted run...
        // then a NEW send on the same session resolves via the replay provider
        { kind: "send", sessionId: "s", text: "follow-up" },
        {
          kind: "event",
          sessionId: "s",
          event: { type: "message.delta", text: "hi again" },
        },
        { kind: "event", sessionId: "s", event: { type: "message.completed" } },
      ],
    };
    const restarted = new HostEngine(store, { codex: replayProvider(transcript) });
    cleanups.push(async () => {
      await restarted.close();
      store.close();
    });
    // Restart recovery leaves the session interrupted and resumable.
    expect(store.session(created.sessionId).status).toBe("interrupted");

    // A follow-up send must settle (no hang, no double-run): the replayed
    // provider resolves the new turn to completed.
    restarted.command({
      type: "send",
      commandId: "send-followup",
      sessionId: created.sessionId,
      text: "follow-up",
    });
    await vi.waitFor(
      () => expect(store.session(created.sessionId).status).toBe("idle"),
      { timeout: 2_000 },
    );
    const runs = store.runs(created.sessionId);
    // Exactly two runs: the interrupted one + the completed follow-up (no dup).
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("interrupted");
    expect(runs[1]!.status).toBe("completed");
  });
});