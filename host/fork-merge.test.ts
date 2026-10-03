// F3 (issue #11): forks + merge-back through the Handoff primitives.
//
// The seam: the provider process boundary (replay harness) + the store. A
// thread can be forked into a new app session sharing the source's runs up to
// the fork point; merge-back applies the fork's new blocks into the source via
// the handoff artifact. Harnesses without native fork degrade through the
// capability policy (synthetic fork).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import { forkThread, mergeBack } from "./fork-merge";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-fork-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "fork",
    entries: [
      { kind: "send", sessionId: "s", text: "first" },
      { kind: "event", sessionId: "s", event: { type: "message.delta", text: "one" } },
      { kind: "event", sessionId: "s", event: { type: "message.completed" } },
      { kind: "send", sessionId: "s", text: "second" },
      { kind: "event", sessionId: "s", event: { type: "message.delta", text: "two" } },
      { kind: "event", sessionId: "s", event: { type: "message.completed" } },
    ],
  };
}

describe("forks + merge-back through the handoff primitives", () => {
  it("forks a thread: a new session sharing the source's runs up to the fork point", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "fork1.db"));
    const replay = replayProvider(transcript());
    const engine = new HostEngine(store, { codex: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });

    const source = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engine.command({ type: "send", commandId: "send1", sessionId: source.sessionId, text: "first" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    engine.command({ type: "send", commandId: "send2", sessionId: source.sessionId, text: "second" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Fork at run ordinal 1: the fork shares history up to the first run.
    const fork = forkThread(store, source.sessionId, 1);
    expect(fork.sessionId).not.toBe(source.sessionId);
    // The fork references the source's runs (one model, shared history).
    expect(fork.runs).toContain(source.sessionId);
    // The fork's blocks are the source's up to the fork point.
    const sourceSession = store.session(source.sessionId);
    const forkSession = store.session(fork.sessionId);
    // The fork is a prefix of the source up to the fork point (runs before the
    // fork), NOT the whole thread — that is the point of a fork.
    expect(forkSession.session.blocks.length).toBeLessThanOrEqual(
      sourceSession.session.blocks.length,
    );
    expect(
      forkSession.session.blocks.every((block) =>
        sourceSession.session.blocks.some((b) => b.id === block.id),
      ),
    ).toBe(true);
    // A Handoff summary is recorded on the fork (the delta is reviewable).
    expect(fork.handoffSummary.length).toBeGreaterThan(0);
  });

  it("merge-back applies the fork's new blocks to the source thread", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "fork2.db"));
    const replay = replayProvider(transcript());
    const engine = new HostEngine(store, { codex: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });

    const source = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engine.command({ type: "send", commandId: "send1", sessionId: source.sessionId, text: "first" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const before = store.session(source.sessionId).session.blocks.length;
    const fork = forkThread(store, source.sessionId, 1);

    // On the fork, add a new run (the tangent).
    engine.command({ type: "send", commandId: "fork-send", sessionId: fork.sessionId, text: "second" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Merge back: the source gains the fork's new blocks.
    const merged = mergeBack(store, fork.sessionId, source.sessionId);
    expect(merged.count).toBeGreaterThan(before);
    const sourceNow = store.session(source.sessionId).session.blocks;
    expect(sourceNow.map((b) => b.text)).toContain("two");
  });
});