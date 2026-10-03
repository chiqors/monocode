// G2 (issue #17): lazy fork resolution + stable source points.
//
// Forking becomes cheap: create the target App thread + a pending
// `ContextTransfer` (type `fork`); no provider session/thread/context handoff
// until the fork's FIRST dispatch, which resolves the transfer (native fork
// when possible, else portable context). Forks are only made from STABLE
// source points (a terminal fork-at run, or an idle thread). Reusing / forking
// repeatedly does not duplicate durable state (idempotent).
//
// The seam: the provider process boundary (replay harness) + the host store,
// following the G1a/G1b/T2/T3 pattern.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import { forkThread, resolveForkOnFirstDispatch } from "./fork-merge";
import {
  createForkTransfer,
  pendingForkTransfer,
  resolveForkTransfer,
} from "./context-transfer";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir(name: string) {
  const directory = mkdtempSync(join(tmpdir(), name));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(entries: ProviderTranscript["entries"]): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "g2",
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

describe("context-transfer entity (lazy fork storage)", () => {
  it("creates a pending fork transfer idempotently and reads it back", () => {
    const directory = setupDir("monocode-g2-transfer-");
    const store = new HostStore(join(directory, "g2.db"));
    cleanups.push(() => store.close());
    const project = store.addProject(directory, "Test");
    const sourceSessionId = "source-1";
    const forkSessionId = "fork-1";
    seedSession(store, project.id, sourceSessionId, "codex");
    seedSession(store, project.id, forkSessionId, "codex");

    const id1 = createForkTransfer(store, {
      sourceSessionId,
      forkSessionId,
    });
    const id2 = createForkTransfer(store, {
      sourceSessionId,
      forkSessionId,
    });
    // Idempotent: re-creating for the same fork returns the same transfer id.
    expect(id2).toBe(id1);

    const pending = pendingForkTransfer(store, forkSessionId);
    expect(pending).toBeTruthy();
    expect(pending!.id).toBe(id1);
    expect(pending!.sourceSessionId).toBe(sourceSessionId);
    expect(pending!.state).toBe("pending");
    expect(pending!.type).toBe("fork");
  });

  it("resolves a pending transfer once and leaves no duplicate", () => {
    const directory = setupDir("monocode-g2-resolve-");
    const store = new HostStore(join(directory, "g2-resolve.db"));
    cleanups.push(() => store.close());
    const project = store.addProject(directory, "Test");
    const sourceSessionId = "source-1";
    const forkSessionId = "fork-1";
    seedSession(store, project.id, sourceSessionId, "codex");
    seedSession(store, project.id, forkSessionId, "codex");

    const id = createForkTransfer(store, { sourceSessionId, forkSessionId });
    resolveForkTransfer(store, forkSessionId, { summary: "portable context" });

    expect(pendingForkTransfer(store, forkSessionId)).toBeUndefined();
    const resolved = store.db
      .prepare(
        "SELECT payload FROM context_transfers WHERE id=? AND fork_session_id=?",
      )
      .get(id, forkSessionId) as { payload: string } | undefined;
    expect(resolved).toBeTruthy();
    expect(JSON.parse(resolved!.payload)).toEqual({ summary: "portable context" });
  });
});

describe("lazy fork + stable source points", () => {
  it("forks lazily: no Handoff row, no provider call, only a pending transfer", async () => {
    const directory = setupDir("monocode-g2-lazy-");
    const store = new HostStore(join(directory, "g2-lazy.db"));
    const replay = replayProvider(
      transcript([
        ...turn("run one"),
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

    // Fork at the completed run: cheap, no eager handoff.
    const fork = forkThread(store, created.sessionId, 1);
    // No handoff row was recorded at fork time.
    const handoffs = store.db
      .prepare("SELECT * FROM handoffs WHERE session_id=?")
      .all(fork.sessionId);
    expect(handoffs).toHaveLength(0);
    // A pending fork ContextTransfer exists.
    const pending = pendingForkTransfer(store, fork.sessionId);
    expect(pending).toBeTruthy();
    expect(pending!.sourceSessionId).toBe(created.sessionId);
    // The fork is a session; blocks are a prefix of the source.
    const forkSession = store.session(fork.sessionId);
    expect(forkSession.session.blocks.length).toBeGreaterThan(0);
    // No provider-bound session/thread work happened at fork time: the fork
    // never created provider_bindings rows.
    const bindings = store.db
      .prepare("SELECT * FROM provider_bindings WHERE app_entity_id=?")
      .all(fork.sessionId);
    expect(bindings).toHaveLength(0);
  });

  it("rejects forking at a running (unstable) source point", async () => {
    const directory = setupDir("monocode-g2-stable-");
    const store = new HostStore(join(directory, "g2-stable.db"));
    // A provider that never completes (its send stays in flight).
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
    // The run exists and is still running (no terminal event).
    await vi.waitFor(() => expect(store.runs(created.sessionId)).toHaveLength(1));

    // Forking at the RUNNING run is rejected as an unstable source point.
    expect(() => forkThread(store, created.sessionId, 1)).toThrow(
      /stable source point/i,
    );
    // No session / transfer was created.
    expect(pendingForkTransfer(store, "any")).toBeUndefined();
  });

  it("resolves the transfer on first dispatch with a portable-context handoff, exactly once", async () => {
    const directory = setupDir("monocode-g2-resolve-io-");
    const store = new HostStore(join(directory, "g2-resolve-io.db"));
    const replay = replayProvider(
      transcript([
        ...turn("run one"),
        ...turn("fork run"), // the fork's first send
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
    // First dispatch on the fork: engine send resolves the transfer.
    engine.command({
      type: "send",
      commandId: "fork-send",
      sessionId: fork.sessionId,
      text: "fork run",
    });
    await vi.waitFor(
      () => expect(store.runs(fork.sessionId)[0]!.status).toBe("completed"),
      { timeout: 2_000 },
    );

    // The transfer was resolved; no pending remains.
    expect(pendingForkTransfer(store, fork.sessionId)).toBeUndefined();
    // Exactly one fork handoff was recorded (the portable context) at
    // resolution time.
    const handoffs = store.db
      .prepare("SELECT * FROM handoffs WHERE session_id=?")
      .all(fork.sessionId) as unknown as { handler: string }[];
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.handler).toBe("fork");
    // The fork run completed (the send worked).
    expect(store.runs(fork.sessionId)[0]!.status).toBe("completed");
  });

  it("an unused fork leaves zero provider-side effects", async () => {
    const directory = setupDir("monocode-g2-unused-");
    const store = new HostStore(join(directory, "g2-unused.db"));
    const replay = replayProvider(
      transcript([
        ...turn("run one"),
        ...turn("second turn"), // never used on the fork
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
    // The fork is never dispatched. No provider calls for the fork's session.
    const forkProvider = store.db
      .prepare("SELECT * FROM provider_bindings WHERE app_entity_id=?")
      .all(fork.sessionId);
    expect(forkProvider).toHaveLength(0);
    // The replay provider saw only the source's one send (calls count 1).
    const calls = replay.calls();
    expect(calls).toHaveLength(1);
    // The fork's pending transfer is still pending (never resolved).
    expect(pendingForkTransfer(store, fork.sessionId)).toBeTruthy();
  });
});

/** Insert a bare session row so FK constraints (handoffs, transfers) pass. */
function seedSession(
  store: HostStore,
  projectId: string,
  sessionId: string,
  harness: "codex" = "codex",
) {
  const now = Date.now();
  store.db
    .prepare("INSERT INTO sessions (id, project_id, snapshot) VALUES (?, ?, ?)")
    .run(
      sessionId,
      projectId,
      JSON.stringify({
        session: {
          id: sessionId,
          harness,
          model: "codex:test",
          modelSettings: {},
          runtimeMode: "supervised",
          title: "Test",
          cwd: "/tmp",
          blocks: [],
        },
        projectId,
        revision: 0,
        status: "idle",
        updatedAt: now,
        createdAt: now,
      }),
    );
}
