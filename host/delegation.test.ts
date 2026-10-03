// G5 (issue #20): structural delegation results.
//
// A delegated task returns a structured `subagent_result` (LHS context
// transfer) — durable task state (`taskId`, `childThreadId`, `childRunId`,
// `childNodeId`, `workState`, `latestTerminal*`, wait timeout) — with
// `task_status` / `task_cancel` and `mode: async | wait`. Async tasks no
// longer hit the 3s bounded-poll deadline; worker results integrate back into
// the Lead via the Handoff artifact (F4), capability degradation preserved.
//
// The seam: the provider process boundary (replay harness) + the store.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import {
  type DelegationToolInput,
  type DelegationResult,
  delegateTask,
  taskStatus,
  taskCancel,
} from "./delegate-task";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-g5-delegate-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function workerTranscript(): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "g5-worker",
    entries: [
      { kind: "send", sessionId: "w", text: "the task" },
      { kind: "event", sessionId: "w", event: { type: "message.delta", text: "worker result" } },
      { kind: "event", sessionId: "w", event: { type: "message.completed" } },
    ],
  };
}

async function leadFixture(store: HostStore, engine: HostEngine, projectId: string) {
  const lead = engine.command({
    type: "create",
    commandId: "create",
    projectId,
    harness: "codex",
    model: "codex:test",
    runtimeMode: "supervised",
  });
  engine.command({
    type: "send",
    commandId: "lead-send",
    sessionId: lead.sessionId,
    text: "orchestrate",
  });
  await vi.waitFor(
    () => expect(store.runs(lead.sessionId).at(-1)?.status).toBe("completed"),
    { timeout: 2_000 },
  );
  return lead.sessionId;
}

describe("structured delegation results (G5)", () => {
  it("returns a structured subagent_result (taskId, child ids, workState, latestTerminal*)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "g5-delegate1.db"));
    const engine = new HostEngine(store, {
      codex: replayProvider(workerTranscript()),
      claude: replayProvider(workerTranscript()),
    });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });
    const leadSessionId = await leadFixture(store, engine, project.id);

    const input: DelegationToolInput = {
      leadSessionId,
      provider: "claude",
      model: "claude:test",
      task: "the task",
      runtimeMode: "supervised",
      mode: "wait",
    };
    const result: DelegationResult = await delegateTask(store, engine, input);

    // The structured result carries the t3code DelegateTaskResult shape.
    expect(result.taskId).toBeTruthy();
    expect(result.childThreadId).toBe(result.workerSessionId);
    expect(result.childRunId).toBeTruthy();
    expect(result.childNodeId).toContain("subagent:");
    expect(result.workState).toBe("result_available");
    // latestTerminal* reflects the worker's terminal run.
    expect(result.latestTerminalStatus).toBe("completed");
    expect(result.latestTerminalRunId).toBe(result.childRunId);
    expect(result.summary).toContain("worker result");
    expect(result.policy).toBe("native");
  });

  it("async mode returns immediately without the 3s bounded poll", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "g5-async.db"));
    // The worker transcript completes ONLY after the async call returns —
    // the async delegate must not wait for it (no 3s poll).
    const engine = new HostEngine(store, {
      codex: replayProvider(workerTranscript()),
      claude: replayProvider(workerTranscript()),
    });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });
    const leadSessionId = await leadFixture(store, engine, project.id);

    const started = Date.now();
    const result = await delegateTask(store, engine, {
      leadSessionId,
      provider: "claude",
      model: "claude:test",
      task: "the task",
      runtimeMode: "supervised",
      mode: "async",
    });
    // Async returns fast (well under a second; the old bounded poll was 3s).
    expect(Date.now() - started).toBeLessThan(1_000);
    // The durable task exists; the worker is still (or just) running — the
    // async result exposes the current stable state, not a completed reply.
    expect(result.taskId).toBeTruthy();
    expect(result.waitTimedOut).toBe(false);
    expect(result.workState).toBe("working");
  });

  it("task_status reads the durable task and task_cancel cancels it", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "g5-status.db"));
    const engine = new HostEngine(store, {
      codex: replayProvider(workerTranscript()),
      claude: replayProvider(workerTranscript()),
    });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });
    const leadSessionId = await leadFixture(store, engine, project.id);

    const result = await delegateTask(store, engine, {
      leadSessionId,
      provider: "claude",
      model: "claude:test",
      task: "the task",
      runtimeMode: "supervised",
      mode: "async",
    });

    // task_status reads the durable task by id from the lead's projection.
    expect(result.taskId).toBeTruthy();
    const status = taskStatus(store, result.taskId);
    expect(status).toBeTruthy();
    expect(status!.childThreadId).toBe(result.childThreadId);
    // task_cancel is idempotent and marks the task (later runs) cancelled.
    const cancelled = taskCancel(store, engine, result.taskId);
    expect(cancelled).toMatchObject({ taskId: result.taskId });
    const after = taskStatus(store, result.taskId);
    expect(after!.status).toMatch(/cancelled|interrupted/);
    // Cancelling again is a no-op (idempotent).
    expect(taskCancel(store, engine, result.taskId)).toMatchObject({
      taskId: result.taskId,
    });
  });

  it("task state is durable across a store reopen (recoverable, no double-dispatch)", async () => {
    const directory = setupDir();
    const dbPath = join(directory, "g5-durable.db");
    const store = new HostStore(dbPath);
    const engine = new HostEngine(store, {
      codex: replayProvider(workerTranscript()),
      claude: replayProvider(workerTranscript()),
    });
    const project = store.addProject(directory, "Test");
    const leadSessionId = await leadFixture(store, engine, project.id);
    const result = await delegateTask(store, engine, {
      leadSessionId,
      provider: "claude",
      model: "claude:test",
      task: "the task",
      runtimeMode: "supervised",
      mode: "async",
    });
    await engine.close();
    store.close();

    // Reopen the same db: the task survives.
    const reopened = new HostStore(dbPath);
    cleanups.push(async () => {
      await reopened.close();
    });
    const status = taskStatus(reopened, result.taskId);
    expect(status).toBeTruthy();
    expect(status!.childThreadId).toBe(result.childThreadId);
    // No duplicate task rows.
    const rows = reopened.db
      .prepare("SELECT COUNT(*) AS count FROM delegated_tasks WHERE task_id=?")
      .get(result.taskId) as { count: number };
    expect(rows.count).toBe(1);
  });
});