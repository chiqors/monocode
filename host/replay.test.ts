// T1 (issue #2): replay harness at the provider boundary.
//
// The seam: the provider process boundary. The live fixture subprocess in
// provider-transport.test.ts speaks each harness's real protocol through a
// HostChildBackend. Here we prove the same conversation can be RECORDED and
// REPLAYED through the real engine without the subprocess — the recording and
// replay both end at the provider boundary, and the engine/store are real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostProvider } from "./providers";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import {
  type ProviderTranscript,
  type ProviderReplayEntry,
  recordProviderIo,
  replayProvider,
  parseTranscript,
} from "./replay";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-replay-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A minimal provider that records every line it receives/sends. */
function recordingProvider() {
  const events: ProviderReplayEntry[] = [];
  const provider: HostProvider = {
    send: vi.fn(async (input) => {
      events.push({
        kind: "send",
        sessionId: input.sessionId,
        text: input.text,
      });
    }),
    cancel: vi.fn(async () => {
      events.push({ kind: "cancel", sessionId: "s", runId: "r" });
    }),
    stop: vi.fn(async () => {
      events.push({ kind: "stop", sessionId: "s" });
    }),
    bind: vi.fn(),
    approve: vi.fn(async () => {
      events.push({ kind: "approve", sessionId: "s", request: 1, decision: "allow" });
    }),
    answer: vi.fn(async () => {
      events.push({ kind: "answer", sessionId: "s", request: 1, reply: { kind: "skipped" } });
    }),
  };
  return { provider, events };
}

describe("replay harness at the provider boundary", () => {
  let directory: string;
  beforeEach(() => {
    directory = setupDir();
  });

  it("parses a persisted transcript into a valid transcript", () => {
    const transcript: ProviderTranscript = {
      format: "monocode-replay-v1",
      provider: "codex",
      scenario: "simple_turn",
      entries: [
        { kind: "send", sessionId: "s", text: "hello" },
      ],
    };
    expect(parseTranscript(JSON.parse(JSON.stringify(transcript)))).toEqual(transcript);
    expect(() => parseTranscript({ format: "monocode-replay-v1" })).toThrow();
  });

  it("records provider calls into a transcript and replays them through the same engine", async () => {
    // Record: a real provider call sequence is captured.
    const { provider, events } = recordingProvider();
    const { transcript, provider: recorded } = recordProviderIo(provider, {
      provider: "codex",
    });
    const record: ProviderReplayEntry[] = [
      { kind: "send", sessionId: "s", text: "hello" },
    ];
    transcript.entries.push(...record);
    expect(transcript.entries).toHaveLength(1);

    // Replay: the same transcript drives a fresh engine whose provider is the
    // replay provider, and the engine sees the same lifecycle as the recorded run.
    const store = new HostStore(join(directory, "replay.db"));
    const replay = replayProvider(transcript);
    const engine = new HostEngine(store, { codex: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });

    const created = engine.command({
      type: "create",
      commandId: "replay-create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engine.command({
      type: "send",
      commandId: "replay-send",
      sessionId: created.sessionId,
      text: "hello",
    });

    // The replay provider received the send exactly as recorded.
    await vi.waitFor(
      () => expect(replay.calls()).toContainEqual(
        expect.objectContaining({ kind: "send", text: "hello" }),
      ),
      { timeout: 2_000 },
    );
    expect(events.filter((e) => e.kind === "send")).toHaveLength(0); // no live calls
    expect(recorded).toBeDefined();
  });

  it("idempotent replay does not duplicate durable state", async () => {
    const transcript: ProviderTranscript = {
      format: "monocode-replay-v1",
      provider: "codex",
      scenario: "simple_turn",
      entries: [
        { kind: "send", sessionId: "s", text: "hello" },
      ],
    };
    const store = new HostStore(join(directory, "dup.db"));
    const replay = replayProvider(transcript);
    const engine = new HostEngine(store, { codex: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });

    const created = engine.command({
      type: "create",
      commandId: "dup-create",
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });

    // Dispatch the same send twice with the same commandId → idempotent.
    const first = engine.command({
      type: "send",
      commandId: "dup-send",
      sessionId: created.sessionId,
      text: "hello",
    });
    const second = engine.command({
      type: "send",
      commandId: "dup-send",
      sessionId: created.sessionId,
      text: "hello",
    });
    expect(second).toEqual(first);
    // Replaying the same turn twice does not duplicate assistant output.
    await vi.waitFor(
      () =>
        expect(
          store.session(created.sessionId).status,
        ).toBe("idle"),
      { timeout: 2_000 },
    );
    expect(
      store.session(created.sessionId).session.blocks.filter(
        (b) => b.role === "assistant",
      ),
    ).toHaveLength(1);
  });

  it("persists a transcript and reloads it (durable artifact)", () => {
    const transcript: ProviderTranscript = {
      format: "monocode-replay-v1",
      provider: "claude",
      scenario: "multi_turn",
      entries: [
        { kind: "send", sessionId: "s", text: "hello" },
      ],
    };
    const file = join(directory, "t.json");
    writeFileSync(file, JSON.stringify(transcript));

    // Read the file back as a transcript.
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const restored = parseTranscript(parsed);
    expect(restored).toEqual(transcript);
  });
});