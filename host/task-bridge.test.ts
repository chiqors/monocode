// S8 (issue #29): remote task bridge parity — local task_status / task_cancel.
//
// Today the G5 delegation surface wires task.status / task.cancel through the
// REMOTE machine bridge in the app shell, and the local path fails loudly
// ("Task status is unavailable for local sessions yet"). The durable host
// reader (taskStatus/taskCancel) is taskId-scoped and exists; the missing
// piece is routing the LOCAL delegateTask through the same durable task rows
// so a local lead's delegated task is trackable via task_status and
// cancellable via task_cancel — same structured result as remote.
//
// The seam: the host RPC server (host/server.ts) + the durable store.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostServer } from "./server";
import { HostChildBackend } from "./child-backend";
import { configureChildBackend } from "../src/integrations/harness/core/child";
import type { SendTurnInput } from "../src/integrations/harness/core/types";
import type { RemoteProvider } from "../src/features/connections/model/protocol";

const modelProbe = vi.hoisted(() => vi.fn());
vi.mock("../src/integrations/harness/providers/codex/codexCatalog", () => ({
  discoverCodexModels: modelProbe,
}));
const binaries: { codex?: string } = {};
configureChildBackend(new HostChildBackend(binaries));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-s8-task-"));
  const store = new HostStore(join(directory, "host.db"));
  let turn: SendTurnInput | undefined;
  const send = vi.fn((input: SendTurnInput) => {
    turn = input;
    // Resolve immediately: the turn settles so the lead/worker complete and
    // engine.close() never spins on an in-flight provider call.
    input.onEvent?.({ type: "message.completed" });
    return Promise.resolve();
  });
  const engine = new HostEngine(store, {
    codex: {
      send,
      stop: async () => undefined,
      cancel: async () => undefined,
      bind: () => {},
      approve: () => {},
      answer: () => {},
    },
    claude: {
      send,
      stop: async () => undefined,
      cancel: async () => undefined,
      bind: () => {},
      approve: () => {},
      answer: () => {},
    },
  });
  const project = await engine.openProject(directory);
  const server = createHostServer(engine, ["codex", "claude"] as RemoteProvider[]);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  const token = store.issueDevice("Laptop").token;
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        environmentId: store.environmentId,
        method,
        params,
      }),
    });
    return (await response.json()) as { result?: any; error?: string };
  };
  cleanups.push(async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { call, store, engine, directory };
}

describe("local task bridge parity (S8)", () => {
  it("delegate.task + task.status work for a LOCAL session through the host store (no loud failure)", async () => {
    const { call, store, engine, directory } = await setup();
    // A lead session that is running a turn.
    const leadResp = await call("commands.dispatch", {
      type: "create",
      commandId: "lead-create",
      projectId: store.projects()[0]!.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    expect(leadResp.error).toBeUndefined();
    const leadSessionId = leadResp.result.sessionId;
    const sent = await call("commands.dispatch", {
      type: "send",
      commandId: "lead-send",
      sessionId: leadSessionId,
      text: "orchestrate",
    });
    expect(sent.error).toBeUndefined();

    // Delegate locally: the worker + durable task row are created.
    const delegated = await call("delegate.task", {
      leadSessionId,
      provider: "claude",
      model: "claude:test",
      task: "the task",
      runtimeMode: "supervised",
      mode: "async",
    });
    expect(delegated.error).toBeUndefined();
    const taskId = delegated.result.taskId as string;
    expect(taskId).toBeTruthy();
    expect(delegated.result.workerSessionId).toBeTruthy();

    // Local task_status returns the structured result from the same durable
    // store — NO loud "unavailable for local sessions" error.
    const status = await call("task.status", { taskId });
    expect(status.error).toBeUndefined();
    expect(status.result).toMatchObject({
      taskId,
      status: expect.stringMatching(/queued|running|completed/),
      workState: expect.stringMatching(/working|result_available/),
    });
    expect(status.result.childThreadId).toBeTruthy();
    expect(status.result.childSessionId).toBeTruthy();

    // The durable delegated_tasks row exists (same store as remote).
    const row = store.db
      .prepare("SELECT * FROM delegated_tasks WHERE task_id=?")
      .get(taskId);
    expect(row).toBeTruthy();
    expect((row as { lead_session_id: string }).lead_session_id).toBe(leadSessionId);
  });

  it("task.cancel is idempotent for a terminal task (same store, structured cancelled result)", async () => {
    const { call, store } = await setup();
    // Create a lead + delegate a worker that completes instantly (terminal).
    const leadResp = await call("commands.dispatch", {
      type: "create",
      commandId: "lead-create",
      projectId: store.projects()[0]!.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    const leadSessionId = leadResp.result.sessionId;
    // A quick-completing worker: complete the send immediately.
    const delegated = await call("delegate.task", {
      leadSessionId,
      provider: "claude",
      model: "claude:test",
      task: "terminal task",
      runtimeMode: "supervised",
      mode: "async",
    });
    expect(delegated.error).toBeUndefined();
    const taskId = delegated.result.taskId as string;

    // Cancelling a terminal task is idempotent: it does NOT throw and returns
    // the structured result even for an already-settled task. The `cancelled`
    // flag reflects whether THIS call interrupted an active run (a terminal
    // task reports cancelled:false — the no-op idempotent shape).
    const first = await call("task.cancel", { taskId });
    expect(first.error).toBeUndefined();
    expect(typeof first.result.cancelled).toBe("boolean");
    const second = await call("task.cancel", { taskId });
    expect(second.error).toBeUndefined();
    expect(second.result).toMatchObject({ taskId, cancelled: false });
  });

  it("shares ONE task store + structured result shape between local and remote (delegate/status/cancel all served by the host)", async () => {
    const { call, store } = await setup();
    // The host RPC serves all three delegation surfaces (local + remote use
    // the same server + durable delegated_tasks store).
    const leadResp = await call("commands.dispatch", {
      type: "create",
      commandId: "lead-create",
      projectId: store.projects()[0]!.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    const leadSessionId = leadResp.result.sessionId;
    const delegated = await call("delegate.task", {
      leadSessionId,
      provider: "claude",
      model: "claude:test",
      task: "one store",
      runtimeMode: "supervised",
      mode: "async",
    });
    expect(delegated.error).toBeUndefined();
    const taskId = delegated.result.taskId as string;

    // status + cancel resolve from the SAME store (taskId-scoped).
    const status = await call("task.status", { taskId });
    expect(status.error).toBeUndefined();
    expect(status.result.taskId).toBe(taskId);
    const cancel = await call("task.cancel", { taskId });
    expect(cancel.error).toBeUndefined();
    expect(cancel.result.taskId).toBe(taskId);
  });
});