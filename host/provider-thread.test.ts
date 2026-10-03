// G1a (issue #15): ProviderThread as a first-class durable entity.
//
// A durable `provider_threads` entity records an App thread's history per
// provider: a resume cursor (`nativeThreadRef`), per-provider coverage
// (`coveredRunRange`, `firstRunOrdinal` / `lastRunOrdinal`), and `handoffIds`.
// Today `providerThreadId` is a thin optional field on the session snapshot and
// the host records `handoffs` rows, but there is no durable thread entity.
//
// The seam: the provider process boundary (replay harness), plus store-level
// unit tests, following the T2/T3 pattern.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import {
  recordProviderThread,
  providerThreads,
  type ProviderThread,
} from "./provider-thread";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir(name: string) {
  const directory = mkdtempSync(join(tmpdir(), name));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Seed a real session row so provider_threads satisfies the sessions FK. */
function createSessionRow(
  store: HostStore,
  directory: string,
  sessionId: string,
  harness = "codex",
) {
  const project = store.addProject(directory, "Test");
  const now = Date.now();
  store.db
    .prepare(
      "INSERT INTO sessions (id, project_id, snapshot) VALUES (?, ?, ?)",
    )
    .run(
      sessionId,
      project.id,
      JSON.stringify({
        session: {
          id: sessionId,
          harness,
          model: "codex:test",
          modelSettings: {},
          runtimeMode: "supervised",
          title: "Test",
          cwd: directory,
          blocks: [],
        },
        projectId: project.id,
        revision: 0,
        status: "idle",
        updatedAt: now,
        createdAt: now,
      }),
    );
  return project;
}

function transcript(entries: ProviderTranscript["entries"]): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "provider_thread",
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
      event: { type: "session.providerBound", providerSessionId: "native-42" },
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

describe("provider-thread entity (store level)", () => {
  it("records one durable ProviderThread per participating provider with coverage", () => {
    const directory = setupDir("monocode-provider-thread-store-");
    const store = new HostStore(join(directory, "provider-threads.db"));
    cleanups.push(() => store.close());

    createSessionRow(store, directory, "app-session-1");
    const sessionId = "app-session-1";

    // Two runs happen on provider A, then a handoff happens, then one run on B.
    // Providers join the thread history through handoffs / bound refs.
    const now = Date.now();
    recordProviderThread(store, {
      sessionId,
      provider: "codex",
      nativeThreadRef: "native-a-1",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      handoffIds: [],
      createdAt: now,
    });
    recordProviderThread(store, {
      sessionId,
      provider: "cursor",
      nativeThreadRef: null,
      firstRunOrdinal: 3,
      lastRunOrdinal: 3,
      handoffIds: ["handoff-1"],
      createdAt: now + 1,
    });

    const threads = providerThreads(store, sessionId);
    expect(threads).toHaveLength(2);

    const a = threads.find((t) => t.provider === "codex")!;
    expect(a).toMatchObject({
      sessionId,
      provider: "codex",
      nativeThreadRef: "native-a-1",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      handoffIds: [],
    });

    const b = threads.find((t) => t.provider === "cursor")!;
    expect(b).toMatchObject({
      sessionId,
      provider: "cursor",
      nativeThreadRef: null,
      firstRunOrdinal: 3,
      lastRunOrdinal: 3,
      handoffIds: ["handoff-1"],
    });
    expect(typeof a.createdAt).toBe("number");
    expect(typeof b.createdAt).toBe("number");
  });

  it("upserts by (session, provider): coverage extends, handoffs accumulate", () => {
    const directory = setupDir("monocode-provider-thread-upsert-");
    const store = new HostStore(join(directory, "provider-threads-upsert.db"));
    cleanups.push(() => store.close());

    const sessionId = "app-session-1";
    createSessionRow(store, directory, sessionId);
    const now = Date.now();
    recordProviderThread(store, {
      sessionId,
      provider: "codex",
      nativeThreadRef: "native-a-1",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      createdAt: now,
    });
    // A second run on the same provider + handoff back into it.
    recordProviderThread(store, {
      sessionId,
      provider: "codex",
      nativeThreadRef: "native-a-1",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      handoffIds: ["handoff-2"],
      createdAt: now + 1,
    });

    const threads = providerThreads(store, sessionId);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      provider: "codex",
      nativeThreadRef: "native-a-1",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      handoffIds: ["handoff-2"],
    });
  });

  it("derives the covered run range from the durable run store", () => {
    const directory = setupDir("monocode-provider-thread-derive-");
    const store = new HostStore(join(directory, "provider-threads-derive.db"));
    cleanups.push(() => store.close());

    const sessionId = "app-session-1";
    createSessionRow(store, directory, sessionId);
    recordProviderThread(store, {
      sessionId,
      provider: "codex",
      nativeThreadRef: null,
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      createdAt: Date.now(),
    });

    // The delta is derivable from coverage: the absent range [2..2] is the
    // off-provider work a switch-back later summarises.
    const threads = providerThreads(store, sessionId);
    expect(threads[0]!.firstRunOrdinal).toBe(1);
    expect(threads[0]!.lastRunOrdinal).toBe(1);
  });

  it("deletes provider threads when the session is deleted", () => {
    const directory = setupDir("monocode-provider-thread-delete-");
    const store = new HostStore(join(directory, "provider-threads-delete.db"));
    cleanups.push(() => store.close());

    const sessionId = "app-session-1";
    createSessionRow(store, directory, sessionId);
    recordProviderThread(store, {
      sessionId,
      provider: "codex",
      nativeThreadRef: null,
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      createdAt: Date.now(),
    });
    expect(providerThreads(store, sessionId)).toHaveLength(1);

    store.deleteSession(sessionId);
    expect(providerThreads(store, sessionId)).toHaveLength(0);
  });
});

describe("ProviderThread through the engine (replay seam)", () => {
  it("records a thread for a weak provider that never reports a native ref", async () => {
    const directory = setupDir("monocode-provider-thread-weak-");
    const store = new HostStore(join(directory, "provider-threads-weak.db"));
    const pi = replayProvider(
      transcript([
        { kind: "send", sessionId: "s", text: "hello pi" },
        { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
        { kind: "event", sessionId: "s", event: { type: "message.completed" } },
      ]),
    );
    const engine = new HostEngine(store, { pi });
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
      text: "hello pi",
    });

    await vi.waitFor(
      () => {
        const threads = providerThreads(store, created.sessionId);
        expect(threads).toHaveLength(1);
        expect(threads[0]!.provider).toBe("pi");
        expect(threads[0]!.firstRunOrdinal).toBe(1);
        expect(threads[0]!.lastRunOrdinal).toBe(1);
        expect(threads[0]!.nativeThreadRef).toBeNull();
      },
      { timeout: 2_000 },
    );
  });

  it("records one ProviderThread per participating provider across switch-back", async () => {
    const directory = setupDir("monocode-provider-thread-engine-");
    const store = new HostStore(join(directory, "provider-threads-engine.db"));
    const codex = replayProvider(
      transcript([
        { kind: "send", sessionId: "s", text: "hello" },
        {
          kind: "event",
          sessionId: "s",
          event: { type: "turn.started", providerTurnId: "t1" },
        },
        {
          kind: "event",
          sessionId: "s",
          event: { type: "session.providerBound", providerSessionId: "native-a-1" },
        },
        { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
        { kind: "event", sessionId: "s", event: { type: "message.completed" } },
      ]),
    );
    const cursor = replayProvider(
      transcript([
        { kind: "send", sessionId: "s", text: "on cursor" },
        {
          kind: "event",
          sessionId: "s",
          event: { type: "turn.started", providerTurnId: "t2" },
        },
        {
          kind: "event",
          sessionId: "s",
          event: { type: "session.providerBound", providerSessionId: "native-b-1" },
        },
        { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi b" } },
        { kind: "event", sessionId: "s", event: { type: "message.completed" } },
      ]),
    );
    const engine = new HostEngine(store, { codex, cursor });
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

    // After the first turn settles, provider A has a durable thread with
    // coverage [1..1] and its native ref bound as evidence.
    await vi.waitFor(
      () => {
        const threads = providerThreads(store, created.sessionId);
        expect(threads).toHaveLength(1);
        expect(threads[0]!.provider).toBe("codex");
        expect(threads[0]!.firstRunOrdinal).toBe(1);
        expect(threads[0]!.lastRunOrdinal).toBe(1);
        expect(threads[0]!.nativeThreadRef).toBe("native-a-1");
      },
      { timeout: 2_000 },
    );

    // Switch to cursor (A -> B). The departure handoff is recorded and linked
    // into provider A's thread.
    engine.command({
      type: "configure",
      commandId: "switch",
      sessionId: created.sessionId,
      harness: "cursor",
      model: "cursor:test",
      runtimeMode: "supervised",
    });

    // One run on cursor (run ordinal 2), so provider B has a durable thread
    // with coverage [2..2].
    engine.command({
      type: "send",
      commandId: "send-b",
      sessionId: created.sessionId,
      text: "on cursor",
    });
    await vi.waitFor(
      () => {
        const threads = providerThreads(store, created.sessionId);
        expect(threads).toHaveLength(2);
        const b = threads.find((t) => t.provider === "cursor")!;
        expect(b.firstRunOrdinal).toBe(2);
        expect(b.lastRunOrdinal).toBe(2);
        expect(b.nativeThreadRef).toBe("native-b-1");
      },
      { timeout: 2_000 },
    );

    // Switch back to codex (B -> A): another departure handoff links into
    // provider B's thread, and provider A's thread keeps its resume cursor.
    engine.command({
      type: "configure",
      commandId: "switch-back",
      sessionId: created.sessionId,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });

    const finalThreads = providerThreads(store, created.sessionId);
    const a = finalThreads.find((t) => t.provider === "codex")!;
    const b = finalThreads.find((t) => t.provider === "cursor")!;
    // One durable thread per participating provider.
    expect(finalThreads).toHaveLength(2);
    // Provider A covered runs [1..1] (it was absent for run 2 on B), so the
    // delta for a switch-back into A is exactly the runs it missed [2..2] —
    // derivable from the store, not stored as a chain.
    expect(a.firstRunOrdinal).toBe(1);
    expect(a.lastRunOrdinal).toBe(1);
    expect(a.nativeThreadRef).toBe("native-a-1");
    // The A -> B departure handoff plus the B -> A switch-back delta both
    // link into provider A's thread (G1b resumes A with the delta).
    expect(a.handoffIds).toHaveLength(2);
    // Provider B covered run 2 and carries the B -> A departure handoff.
    expect(b.firstRunOrdinal).toBe(2);
    expect(b.lastRunOrdinal).toBe(2);
    expect(b.nativeThreadRef).toBe("native-b-1");
    // Cursor's departure from B -> A links into B (still 1; no switch-back
    // into cursor happened).
    expect(b.handoffIds).toHaveLength(1);
  });
});