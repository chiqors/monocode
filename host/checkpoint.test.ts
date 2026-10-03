// G3 (issue #19): CheckpointScope + rollback reconciliation.
//
// Nested CheckpointScopes with `advancesAppRunCount`: pre-run baseline +
// post-run capture. Provider rollback is a real host flow: runs after the
// target are marked `rolled_back`, the durable ProviderThread (G1) coverage is
// truncated back to the target, and a `handler: "rollback"` handoff is recorded
// so a subsequent switch-back delta covers exactly the post-rollback runs.
// The app run count advances only per `advancesAppRunCount`; rollback never
// creates duplicate runs.
//
// The seam: the provider process boundary (replay harness) + the host store,
// following the G1a/G1b/G2/T2/T3 pattern.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import { providerThreads } from "./provider-thread";
import {
  captureCheckpoint,
  checkpointScopes,
  createCheckpointScope,
  ensurePreRunBaseline,
} from "./checkpoint";
import { rollbackThread } from "./rollback";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir(name: string) {
  const directory = mkdtempSync(join(tmpdir(), name));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
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

function seedSession(store: HostStore, projectId: string, sessionId: string) {
  const now = Date.now();
  store.db
    .prepare("INSERT INTO sessions (id, project_id, snapshot) VALUES (?, ?, ?)")
    .run(
      sessionId,
      projectId,
      JSON.stringify({
        session: {
          id: sessionId,
          harness: "codex",
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

describe("checkpoint scopes (nested, advancesAppRunCount)", () => {
  it("creates a root scope that advances the run count and captures a baseline + post-run", () => {
    const directory = setupDir("monocode-g3-scopes-");
    const store = new HostStore(join(directory, "g3.db"));
    cleanups.push(() => store.close());
    const project = store.addProject(directory, "Test");
    seedSession(store, project.id, "s1");

    const scopeId = createCheckpointScope(store, {
      sessionId: "s1",
      runOrdinal: 1,
      advancesAppRunCount: true,
    });
    ensurePreRunBaseline(store, scopeId, "before run 1");
    captureCheckpoint(store, scopeId, "after run 1");

    const scopes = checkpointScopes(store, "s1");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      sessionId: "s1",
      runOrdinal: 1,
      advancesAppRunCount: true,
      baselineSummary: "before run 1",
      captureSummary: "after run 1",
      status: "captured",
    });
    expect(scopes[0]!.parentId).toBeUndefined();
  });

  it("creates a child scope under a parent that does NOT advance the run count", () => {
    const directory = setupDir("monocode-g3-child-");
    const store = new HostStore(join(directory, "g3-child.db"));
    cleanups.push(() => store.close());
    const project = store.addProject(directory, "Test");
    seedSession(store, project.id, "s1");

    const rootId = createCheckpointScope(store, {
      sessionId: "s1",
      runOrdinal: 1,
      advancesAppRunCount: true,
    });
    const childId = createCheckpointScope(store, {
      sessionId: "s1",
      runOrdinal: 1,
      advancesAppRunCount: false,
      parentId: rootId,
    });

    const scopes = checkpointScopes(store, "s1");
    expect(scopes).toHaveLength(2);
    const child = scopes.find((s) => s.id === childId)!;
    expect(child.parentId).toBe(rootId);
    expect(child.advancesAppRunCount).toBe(false);
    // The root is still the parent; child capture doesn't advance the run.
    const root = scopes.find((s) => s.id === rootId)!;
    expect(root.advancesAppRunCount).toBe(true);
  });
});

describe("rollback reconciliation (durable, not UI)", () => {
  it("marks later runs rolled_back, truncates ProviderThread coverage, and records a rollback handoff", async () => {
    const directory = setupDir("monocode-g3-rollback-");
    const store = new HostStore(join(directory, "g3-rollback.db"));
    const replay = replayProvider(
      {
        format: "monocode-replay-v1",
        provider: "codex",
        scenario: "g3",
        entries: [
          ...turn("run one"),
          ...turn("run two"),
          ...turn("run three"),
        ],
      },
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
    for (const text of ["run one", "run two", "run three"]) {
      engine.command({ type: "send", commandId: `send-${text}`, sessionId: created.sessionId, text });
      await vi.waitFor(
        () => expect(store.runs(created.sessionId).at(-1)!.status).toBe("completed"),
        { timeout: 2_000 },
      );
    }
    // 3 completed runs; provider thread coverage [1..3].
    expect(store.runs(created.sessionId)).toHaveLength(3);
    const thread = providerThreads(store, created.sessionId).find(
      (t) => t.provider === "codex",
    )!;
    expect(thread.lastRunOrdinal).toBe(3);
    expect(thread.firstRunOrdinal).toBe(1);

    // Roll back to run 1.
    rollbackThread(store, created.sessionId, 1);

    // Runs 2 and 3 are marked rolled_back (not duplicated, not deleted).
    const runs = store.runs(created.sessionId);
    expect(runs).toHaveLength(3);
    expect(runs[0]!.status).toBe("completed");
    expect(runs[1]!.status).toBe("rolled_back");
    expect(runs[2]!.status).toBe("rolled_back");

    // ProviderThread coverage truncated to [1..1].
    const after = providerThreads(store, created.sessionId).find(
      (t) => t.provider === "codex",
    )!;
    expect(after.firstRunOrdinal).toBe(1);
    expect(after.lastRunOrdinal).toBe(1);

    // A rollback handoff is recorded (the next switch-back delta covers the
    // post-rollback runs).
    const handoffs = store.db
      .prepare("SELECT * FROM handoffs WHERE session_id=? AND handler='rollback'")
      .all(created.sessionId) as unknown as { handler: string }[];
    expect(handoffs).toHaveLength(1);
  });

  it("replay AC: run → checkpoint → rollback → reconcile → delta covers only post-rollback runs", async () => {
    const directory = setupDir("monocode-g3-ac-");
    const store = new HostStore(join(directory, "g3-ac.db"));
    const replay = replayProvider(
      {
        format: "monocode-replay-v1",
        provider: "codex",
        scenario: "g3-ac",
        entries: [
          ...turn("run one"),
          ...turn("run two"),
        ],
      },
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
    engine.command({ type: "send", commandId: "send-1", sessionId: created.sessionId, text: "run one" });
    await vi.waitFor(
      () => expect(store.runs(created.sessionId).at(-1)!.status).toBe("completed"),
      { timeout: 2_000 },
    );
    // Checkpoint scope for run 1 (baseline before, capture after).
    const scopeId = createCheckpointScope(store, {
      sessionId: created.sessionId,
      runOrdinal: 1,
      advancesAppRunCount: true,
    });
    ensurePreRunBaseline(store, scopeId, "baseline run 1");
    captureCheckpoint(store, scopeId, "capture run 1");

    engine.command({ type: "send", commandId: "send-2", sessionId: created.sessionId, text: "run two" });
    await vi.waitFor(
      () => expect(store.runs(created.sessionId).at(-1)!.status).toBe("completed"),
      { timeout: 2_000 },
    );

    // Roll back to run 1 (the checkpointed point).
    rollbackThread(store, created.sessionId, 1);

    // S3 auto-capture creates one root scope per run. Rollback keeps the
    // run-1 scopes (including the manual capture) captured; later auto scopes
    // are rolled back.
    const scopes = checkpointScopes(store, created.sessionId);
    expect(scopes.length).toBeGreaterThanOrEqual(2);
    const manual = scopes.find((s) => s.captureSummary === "capture run 1");
    expect(manual).toBeTruthy();
    expect(manual!.status).toBe("captured");
    // Every scope at an ordinal after the target is rolled back.
    const laterScopes = scopes.filter((s) => s.runOrdinal > 1);
    expect(laterScopes.length).toBeGreaterThanOrEqual(1);
    expect(laterScopes.every((s) => s.status === "rolled_back")).toBe(true);
    const runs = store.runs(created.sessionId);
    expect(runs[1]!.status).toBe("rolled_back");

    // Coverage is now [1..1] — a subsequent switch-back delta must cover
    // exactly the post-rollback runs (there are none yet, so no delta rows).
    const thread = providerThreads(store, created.sessionId).find(
      (t) => t.provider === "codex",
    )!;
    expect(thread.lastRunOrdinal).toBe(1);
  });
});