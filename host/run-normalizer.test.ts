// T2 (issue #3): durable Run entity + content-agnostic normalizer.
//
// The seam: the provider process boundary (replay harness). A run is a durable,
// counted user-visible turn persisted on the host; the normalizer turns raw
// harness events into lifecycle transitions (run started/terminal) without
// touching message content.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "../src/integrations/harness/core/types";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import {
  normalizeRunEvent,
  type RunStatus,
} from "./run-normalizer";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-run-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(entries: ProviderTranscript["entries"]): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "run_lifecycle",
    entries,
  };
}

function simpleTurn(): ProviderTranscript {
  return transcript([
    { kind: "send", sessionId: "s", text: "hello" },
    {
      kind: "event",
      sessionId: "s",
      event: { type: "turn.started", providerTurnId: "t1" },
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
  ]);
}

describe("run normalizer (content-agnostic lifecycle)", () => {
  it("leaves a run running on non-terminal events and completes on message.completed", () => {
    const first = normalizeRunEvent(
      { status: "running", message: undefined },
      { type: "message.delta", text: "hi" },
    );
    expect(first).toEqual({ status: "running", message: undefined });

    const done = normalizeRunEvent(
      { status: "running", message: undefined },
      { type: "message.completed" },
    );
    expect(done).toEqual({ status: "completed", message: undefined });
  });

  it("interrupts a run on session.error without touching content", () => {
    const next = normalizeRunEvent(
      { status: "running", message: undefined },
      { type: "session.error", message: "boom" },
    );
    expect(next.status).toBe("interrupted");
    expect(next.message).toBe("boom");
  });

  it("ignores events that are not lifecycle transitions", () => {
    const next = normalizeRunEvent(
      { status: "running", message: undefined },
      { type: "turn.started", providerTurnId: "t1" },
    );
    expect(next).toEqual({ status: "running", message: undefined });
  });
});

describe("durable Run entity end to end", () => {
  it("persists a counted run with lifecycle through the replay harness", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "runs.db"));
    const replay = replayProvider(simpleTurn());
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

    // The run is counted and durable: one run with ordinal 1.
    await vi.waitFor(() => {
      const runs = store.runs(created.sessionId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.ordinal).toBe(1);
      expect(runs[0]!.status).toBe("completed");
      expect(runs[0]!.sessionId).toBe(created.sessionId);
      expect(runs[0]!.id).toBeTruthy();
    }, { timeout: 2_000 });
  });

  it("creates monotonically ordered runs for follow-up turns", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "runs2.db"));
    const replay = replayProvider(
      transcript([
        { kind: "send", sessionId: "s", text: "first" },
        { kind: "event", sessionId: "s", event: { type: "turn.started", providerTurnId: "t1" } },
        { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
        { kind: "event", sessionId: "s", event: { type: "message.completed" } },
        { kind: "send", sessionId: "s", text: "second" },
        { kind: "event", sessionId: "s", event: { type: "turn.started", providerTurnId: "t2" } },
        { kind: "event", sessionId: "s", event: { type: "message.completed" } },
      ]),
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
    engine.command({ type: "send", commandId: "send1", sessionId: created.sessionId, text: "first" });
    await vi.waitFor(
      () => expect(store.session(created.sessionId).status).toBe("idle"),
      { timeout: 2_000 },
    );
    engine.command({ type: "send", commandId: "send2", sessionId: created.sessionId, text: "second" });

    await vi.waitFor(
      () => {
        const runs = store.runs(created.sessionId);
        expect(runs).toHaveLength(2);
        expect(runs.every((run) => run.status !== "running")).toBe(true);
      },
      { timeout: 3_000 },
    );
    const runs = store.runs(created.sessionId);
    expect(runs.map((run) => run.ordinal)).toEqual([1, 2]);
    expect(runs.every((run) => run.status === "completed")).toBe(true);
  });

  it("marks a run interrupted on session.error", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "runs3.db"));
    const replay = replayProvider(
      transcript([
        { kind: "send", sessionId: "s", text: "hello" },
        { kind: "event", sessionId: "s", event: { type: "turn.started", providerTurnId: "t1" } },
        { kind: "event", sessionId: "s", event: { type: "session.error", message: "boom" } },
      ]),
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
    engine.command({ type: "send", commandId: "send", sessionId: created.sessionId, text: "hello" });

    await vi.waitFor(
      () => {
        const runs = store.runs(created.sessionId);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe("interrupted");
      },
      { timeout: 2_000 },
    );
  });
});