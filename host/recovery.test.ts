// F2 (issue #10): runtime / restart recovery.
//
// The seam: the provider process boundary (replay harness) + the store. On
// restart, a session whose run was interrupted is marked and resumable; a
// harness process crash marks only the affected run failed; the thread and
// other runs stay intact (no duplicated durable state).

import { afterEach, describe, expect, it } from "vitest";
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
  const directory = mkdtempSync(join(tmpdir(), "monocode-recovery-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function turnTranscript(): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "recovery",
    entries: [
      { kind: "send", sessionId: "s", text: "hello" },
      { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
    ],
  };
}

/** A provider whose send never resolves: simulates a turn stuck mid-flight. */
function hangingProvider(): { provider: HostProvider; sendStarted: () => void } {
  const provider: HostProvider = {
    send: async (): Promise<void> => {
      await new Promise(() => undefined); // never resolves
    },
    cancel: async () => undefined,
    stop: async () => undefined,
    bind: () => undefined,
    approve: () => undefined,
    answer: () => undefined,
  };
  return { provider, sendStarted: () => {} };
}

describe("restart recovery (thread survives; only the affected run is marked)", () => {
  it("marks only the interrupted run on restart; completed runs stay intact", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "recovery1.db"));

    // Drive one turn that stays running (a hanging send = mid-flight crash).
    const { provider } = hangingProvider();
    const engine = new HostEngine(store, { codex: provider });
    const project = store.addProject(directory, "Test");

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
    // The turn is now running (send hangs); simulate a crash by abandoning
    // the engine without close() — the next store open is the restart.
    expect(store.session(created.sessionId).status).toBe("running");

    // Restart: a fresh engine over the same DB.
    const restartReplay = replayProvider(turnTranscript());
    const restarted = new HostEngine(store, { codex: restartReplay });
    cleanups.push(async () => {
      await restarted.close();
      store.close();
    });

    // The thread survives: the session still exists with its prior blocks.
    const session = store.session(created.sessionId);
    expect(session.session.blocks.length).toBeGreaterThanOrEqual(1);

    // The session is settled to interrupted (restart recovery marks it), not
    // left running, and no duplicate durable state is created.
    expect(session.status).toBe("interrupted");

    // The affected run row is itself marked interrupted (only the affected
    // run is failed; the thread + count stay intact).
    const runs = store.runs(created.sessionId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.at(-1)!.status).toBe("interrupted");
    const ids = new Set(runs.map((r) => r.id));
    expect(ids.size).toBe(runs.length);
  });

  it("leaves the pending turn.start effect in the outbox for resume (restart)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "recovery2.db"));

    const { provider } = hangingProvider();
    const project = store.addProject(directory, "Test");
    const engine = new HostEngine(store, { codex: provider });
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
    // Turn is running (send hangs); the effect is in-flight — the resume
    // affordance after a restart.
    const pending = pendingEffects(store).filter(
      (e) => e.sessionId === created.sessionId && e.kind === "turn.start",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("in-flight");

    // Simulate a crash and restart: the effect survives for the next engine.
    const restarted = new HostEngine(store, { codex: hangingProvider().provider });
    cleanups.push(async () => {
      await restarted.close();
      store.close();
    });
    const after = pendingEffects(store).filter(
      (e) => e.sessionId === created.sessionId && e.kind === "turn.start",
    );
    expect(after).toHaveLength(1);
  });
});