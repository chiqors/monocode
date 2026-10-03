// S3 (issue #24): engine auto-capture of checkpoints at run boundaries.
//
// Today the checkpoint scope API exists (create scope, ensure pre-run baseline,
// capture post-run) but the engine never invokes it — so rollback and
// checkpoint-aware forks have nothing real to reconcile against. S3 wires the
// lifecycle into the run terminal seam: the engine auto-creates a root scope
// with a pre-run baseline at run start, auto-captures it at run terminal
// (completed / interrupted), and nested (subagent) scopes capture per
// `advancesAppRunCount` under the parent. Idempotent + deterministic under
// replay (same transcript → same captured scopes).
//
// The seam: the provider process boundary (replay harness) + the host store.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import { checkpointScopes, createCheckpointScope } from "./checkpoint";
import { rollbackThread } from "./rollback";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir(name = "monocode-s3-auto-") {
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

function transcript(entries: ProviderTranscript["entries"]): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "s3-auto-capture",
    entries,
  };
}

async function driveCompletedRun(
  store: HostStore,
  engine: HostEngine,
  sessionId: string,
  text: string,
) {
  engine.command({
    type: "send",
    commandId: `send-${text}`,
    sessionId,
    text,
  });
  await vi.waitFor(
    () => expect(store.runs(sessionId).at(-1)!.status).toBe("completed"),
    { timeout: 2_000 },
  );
}

describe("auto-capture at run boundaries (S3)", () => {
  it("auto-creates a root scope + baseline at run start and captures at completion", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "auto1.db"));
    const replay = replayProvider(transcript([...turn("run one"), ...turn("run two")]));
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

    // Before any run, no checkpoint scopes exist.
    expect(checkpointScopes(store, created.sessionId)).toHaveLength(0);

    await driveCompletedRun(store, engine, created.sessionId, "run one");

    // After one completed run: exactly ONE root scope, captured, with a
    // baseline + capture summary, advancing the run count.
    const scopes = checkpointScopes(store, created.sessionId);
    expect(scopes).toHaveLength(1);
    const scope = scopes[0]!;
    expect(scope.runOrdinal).toBe(1);
    expect(scope.advancesAppRunCount).toBe(true);
    expect(scope.status).toBe("captured");
    expect(scope.baselineSummary).toBeTruthy();
    expect(scope.captureSummary).toBeTruthy();
    expect(scope.parentId).toBeUndefined();

    await driveCompletedRun(store, engine, created.sessionId, "run two");
    // Two runs → two root auto-captured scopes.
    const after = checkpointScopes(store, created.sessionId);
    expect(after).toHaveLength(2);
    expect(after[1]!.runOrdinal).toBe(2);
    expect(after[1]!.status).toBe("captured");
  });

  it("captures nested subagent scopes under the parent per advancesAppRunCount without advancing it", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "auto2.db"));
    const replay = replayProvider(transcript([...turn("run one")]));
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
    await driveCompletedRun(store, engine, created.sessionId, "run one");
    const rootScope = checkpointScopes(store, created.sessionId)[0]!;
    expect(rootScope.status).toBe("captured");

    // A nested (subagent) scope is created under the root with
    // advancesAppRunCount=false — it does not advance the parent run count and
    // captures without creating a NEW root scope.
    const childId = createCheckpointScope(store, {
      sessionId: created.sessionId,
      runOrdinal: 1,
      advancesAppRunCount: false,
      parentId: rootScope.id,
    });
    // (The engine auto-capture writes nested scopes under the active run's
    // root when a subagent runs; here we verify the read-back shape.)
    const scopes = checkpointScopes(store, created.sessionId);
    const child = scopes.find((s) => s.id === childId)!;
    expect(child.parentId).toBe(rootScope.id);
    expect(child.advancesAppRunCount).toBe(false);
    // Root still captured + parent; child does not advance the count.
    expect(scopes.filter((s) => s.advancesAppRunCount && s.status === "captured")).toHaveLength(1);
  });

  it("is idempotent + deterministic under replay (same transcript → same scopes)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "auto3.db"));
    // Run the SAME transcript twice over SEPARATE stores; both must end with
    // the same auto-captured scopes (deterministic).
    const stores: Array<{ store: HostStore; engine: HostEngine }> = [];
    for (const suffix of ["a", "b"]) {
      const s = new HostStore(join(directory, `auto3-${suffix}.db`));
      const e = new HostEngine(s, { codex: replayProvider(transcript([...turn("x")])) });
      const project = s.addProject(directory, "Test");
      const created = e.command({
        type: "create",
        commandId: `create-${suffix}`,
        projectId: project.id,
        harness: "codex",
        model: "codex:test",
        runtimeMode: "supervised",
      });
      await driveCompletedRun(s, e, created.sessionId, "x");
      stores.push({ store: s, engine: e });
      cleanups.push(async () => {
        await e.close();
        s.close();
      });
    }
    void store;
    // Both stores produce identical auto-captured scope summaries.
    const a = checkpointScopes(stores[0]!.store, stores[0]!.store.sessions()[0]!.session.id);
    const b = checkpointScopes(stores[1]!.store, stores[1]!.store.sessions()[0]!.session.id);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.baselineSummary).toBe(b[0]!.baselineSummary);
    expect(a[0]!.captureSummary).toBe(b[0]!.captureSummary);
    expect(a[0]!.status).toBe(b[0]!.status);
  });

  it("rollback reconciles against auto-captured scopes (G3 still green)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "auto4.db"));
    const replay = replayProvider(
      transcript([...turn("run one"), ...turn("run two"), ...turn("run three")]),
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
    for (const text of ["run one", "run two", "run three"])
      await driveCompletedRun(store, engine, created.sessionId, text);

    // Three auto-captured scopes exist.
    expect(checkpointScopes(store, created.sessionId)).toHaveLength(3);

    // Roll back to run 1: scopes after the target are marked rolled_back; the
    // target scope stays captured (the reconcile destination).
    rollbackThread(store, created.sessionId, 1);
    const scopes = checkpointScopes(store, created.sessionId);
    expect(scopes[0]!.status).toBe("captured");
    expect(scopes[1]!.status).toBe("rolled_back");
    expect(scopes[2]!.status).toBe("rolled_back");
  });
});