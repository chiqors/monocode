// T4 (issue #5): execution graph (nodes, root-only completion, run attempts).
//
// The seam: the provider process boundary (replay harness). A run has an
// execution-node tree; only the root node's completion completes the run.
// Child nodes (tools, approvals, subagents) complete independently without
// completing the parent run.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "../src/integrations/harness/core/types";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import {
  applyNodeEvent,
  type ExecutionNode,
  type NodeKind,
} from "./execution-node";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-node-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function baseTranscript(): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "node-graph",
    entries: [
      { kind: "send", sessionId: "s", text: "hello" },
      {
        kind: "event",
        sessionId: "s",
        event: { type: "turn.started", providerTurnId: "t1" },
      },
    ],
  };
}

describe("node normalizer (root-only completion)", () => {
  const root: ExecutionNode = {
    id: "root",
    sessionId: "s",
    runId: "r1",
    parentId: null,
    kind: "root_turn",
    status: "running",
    startedAt: 1,
    endedAt: null,
  };

  it("ignores non-lifecycle events", () => {
    const next = applyNodeEvent([root], {
      type: "message.delta",
      text: "hi",
    });
    expect(next.nodes[0]!.status).toBe("running");
    expect(next.rootCompleted).toBe(false);
  });

  it("creates a child tool node from tool.started, able to complete independently", () => {
    const session = applyNodeEvent(
      [root],
      { type: "tool.started", callId: "tool-1", title: "read" },
    );
    expect(session.nodes).toHaveLength(2);
    const tool = session.nodes[1]!;
    expect(tool.kind).toBe("tool");
    expect(tool.status).toBe("running");
    expect(tool.parentId).toBe("root");

    // A child node completing never completes the run: the root stays running.
    const afterToolDone = applyNodeEvent(
      session.nodes,
      { type: "tool.updated", callId: "tool-1", status: "completed" },
    );
    expect(afterToolDone.rootCompleted).toBe(false);
    expect(afterToolDone.nodes[1]!.status).toBe("completed");
    expect(afterToolDone.nodes[0]!.status).toBe("running");
  });

  it("completes the run only when the root node completes (message.completed)", () => {
    const done = applyNodeEvent(
      [root],
      { type: "message.completed" },
    );
    expect(done.rootCompleted).toBe(true);
    expect(done.nodes[0]!.status).toBe("completed");
  });
});

describe("execution graph through the replay harness", () => {
  it("creates a root node per run and completes the run on root completion", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "nodes.db"));
    const replay = replayProvider({
      ...baseTranscript(),
      entries: [
        ...baseTranscript().entries,
        { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
        { kind: "event", sessionId: "s", event: { type: "message.completed" } },
      ],
    });
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

    await vi.waitFor(() => {
      const nodes = store.nodes(created.sessionId);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.kind).toBe("root_turn");
      expect(nodes[0]!.status).toBe("completed");
      expect(nodes[0]!.parentId).toBeNull();
    }, { timeout: 2_000 });
  });

  it("child tool nodes exist and never complete the parent run", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "nodes2.db"));
    const replay = replayProvider({
      ...baseTranscript(),
      entries: [
        ...baseTranscript().entries,
        { kind: "event", sessionId: "s", event: { type: "tool.started", callId: "tool-1", title: "read" } },
        { kind: "event", sessionId: "s", event: { type: "tool.updated", callId: "tool-1", status: "completed" } },
      ],
    });
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
    await new Promise((resolve) => setTimeout(resolve, 150));

    const nodes = store.nodes(created.sessionId);
    // Root created; the tool node appears as a child under it.
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    const tool = nodes.find((n) => n.kind === "tool");
    expect(tool).toBeTruthy();
    expect(tool!.parentId).not.toBeNull();
    // The run is NOT completed by the tool completing (no message.completed
    // was recorded): the run row ends interrupted, never completed — the root
    // is the only node that can complete it.
    expect(store.runs(created.sessionId)[0]!.status).not.toBe("completed");
  });

  it("records run attempts (one per run initially)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "nodes3.db"));
    const replay = replayProvider(baseTranscript());
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
    await vi.waitFor(
      () => expect(store.runs(created.sessionId)[0]!.attempts).toBe(1),
      { timeout: 2_000 },
    );
  });
});