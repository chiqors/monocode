// F1 (issue #9): durable effect outbox (restart-resume of provider effects).
//
// The seam: the provider process boundary (replay harness) + the store. A
// provider effect (turn.start / interrupt / rollback / fork) is enqueued
// durably BEFORE dispatch, marked in-flight, then done — so a restart resumes
// a half-sent effect without losing or double-dispatching it.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { HostEngine } from "./engine";
import { replayProvider, type ProviderTranscript } from "./replay";
import {
  enqueueProviderEffect,
  markEffectInFlight,
  markEffectDone,
  pendingEffects,
  type ProviderEffect,
} from "./provider-effects";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-effects-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("durable effect outbox", () => {
  it("enqueues an effect durably, marks it in-flight, then done", () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "effects.db"));
    cleanups.push(() => store.close());

    const effect: ProviderEffect = {
      sessionId: "s1",
      runId: "run-1",
      kind: "turn.start",
      payload: { text: "hello" },
    };
    enqueueProviderEffect(store, effect);
    expect(pendingEffects(store).some((e) => e.sessionId === "s1")).toBe(true);

    markEffectInFlight(store, "s1", effect.runId);
    const inFlight = pendingEffects(store).find((e) => e.sessionId === "s1")!;
    expect(inFlight.status).toBe("in-flight");

    markEffectDone(store, "s1", effect.runId);
    expect(pendingEffects(store).some((e) => e.sessionId === "s1")).toBe(false);
  });

  it("survives a restart (reopened store reads the same pending effect)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "effects2.db"));
    enqueueProviderEffect(store, {
      sessionId: "s2",
      runId: "run-2",
      kind: "turn.start",
      payload: { text: "hello" },
    });
    store.close();

    // Restart: a fresh store over the same DB sees the pending effect.
    const reopened = new HostStore(join(directory, "effects2.db"));
    cleanups.push(() => reopened.close());
    const pending = pendingEffects(reopened);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sessionId).toBe("s2");
    expect(pending[0]!.kind).toBe("turn.start");
    expect(pending[0]!.attempts).toBe(0);
  });

  it("increments attempts on retry and never double-dispatches done effects", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "effects3.db"));
    cleanups.push(() => store.close());

    enqueueProviderEffect(store, {
      sessionId: "s3",
      runId: "run-3",
      kind: "turn.start",
      payload: { text: "hello" },
    });
    const effect = pendingEffects(store)[0]!;
    expect(effect.attempts).toBe(0);

    markEffectInFlight(store, "s3", "run-3", { attempts: 1 });
    const retried = pendingEffects(store)[0]!;
    expect(retried.attempts).toBe(1);

    markEffectDone(store, "s3", "run-3");
    expect(pendingEffects(store)).toHaveLength(0);
    // Marking done a second time is idempotent (no error, no row).
    markEffectDone(store, "s3", "run-3");
    expect(pendingEffects(store)).toHaveLength(0);
  });

  it("engine enqueues turn.start on send and retires it on settlement", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "effects4.db"));
    cleanups.push(() => store.close());
    const transcript: ProviderTranscript = {
      format: "monocode-replay-v1",
      provider: "codex",
      scenario: "effects",
      entries: [
        { kind: "send", sessionId: "s", text: "hello" },
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
    const replay = replayProvider(transcript);
    const engine = new HostEngine(store, { codex: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
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
    // Immediately after send, the effect is enqueued.
    expect(
      pendingEffects(store).some(
        (e) => e.sessionId === created.sessionId && e.kind === "turn.start",
      ),
    ).toBe(true);
    // After settlement, the effect is retired from the outbox.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      pendingEffects(store).some(
        (e) => e.sessionId === created.sessionId && e.kind === "turn.start",
      ),
    ).toBe(false);
  });
});