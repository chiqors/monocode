// T7 (issue #8): orchestration rework onto the graph (one model).
//
// The seam: the provider process boundary (replay harness) + the store. A lead
// run is a root execution node; worker dispatches are child subagent nodes.
// The projector + forward migration make orchestration ride the same graph.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectOrchestration,
  migrateOrchestrationGraph,
  type OrchestrationRunView,
} from "./orchestration-graph";
import { HostStore } from "./store";
import { HostEngine } from "./engine";
import { replayProvider } from "./replay";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-ortest-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("orchestration graph projection (one model)", () => {
  it("projects a lead run as a root node and dispatches as child subagent nodes", () => {
    const run: OrchestrationRunView = {
      leadId: "lead-1",
      runId: "run-1",
      dispatches: [
        { id: "d1", sessionId: "worker-1", taskId: "t1", state: "running" },
        { id: "d2", sessionId: "worker-2", taskId: "t2", state: "completed" },
      ],
    };
    const { nodes, link } = projectOrchestration(run);
    // Root = the lead run.
    expect(nodes[0]!.kind).toBe("root_turn");
    expect(nodes[0]!.runId).toBe("run-1");
    expect(nodes[0]!.parentId).toBeNull();
    // Each dispatch = a child subagent node under the root.
    expect(nodes).toHaveLength(3);
    expect(nodes[1]!.kind).toBe("subagent");
    expect(nodes[1]!.parentId).toBe(nodes[0]!.id);
    expect(nodes[1]!.status).toBe("running");
    expect(nodes[2]!.status).toBe("completed");
    // The link records the graph mapping.
    expect(link.leadRunId).toBe("run-1");
    expect(link.workerNodeIds).toEqual({ d1: nodes[1]!.id, d2: nodes[2]!.id });
  });

  it("falls back to an app-owned orchestration run id when the lead has no run", () => {
    const { link } = projectOrchestration({ leadId: "lead-1" });
    expect(link.leadRunId).toBe("orchestration:lead-1");
  });

  it("migrates legacy orchestration history forward with the graph link", () => {
    // A legacy v2 run (the shape control_load returns).
    const legacy = {
      version: 2,
      leadId: "lead-1",
      cwd: "/project",
      tasks: [
        { id: "t1", title: "Task 1", status: "completed" },
      ],
      dispatches: [{ id: "d1", sessionId: "worker-1", taskId: "t1", state: "completed" }],
    };
    const migrated = migrateOrchestrationGraph(legacy);
    expect(migrated).not.toBeNull();
    expect(migrated!.run).toMatchObject({ version: 2, leadId: "lead-1" });
    // The graph link is recorded; legacy fields stay intact (history readable).
    expect(migrated!.run.graph.leadRunId).toBeTruthy();
    expect(migrated!.run.graph.workerNodeIds["d1"]).toBeTruthy();
    expect((migrated!.run as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("rejects unsupported orchestration shapes", () => {
    expect(migrateOrchestrationGraph({})).toBeNull();
    expect(migrateOrchestrationGraph(null)).toBeNull();
    expect(migrateOrchestrationGraph({ version: 2 })).toBeNull();
  });

  it("persists the projected graph nodes through the store", () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "or.db"));
    const replay = replayProvider({
      format: "monocode-replay-v1",
      provider: "claude",
      scenario: "orchestration-lead",
      entries: [],
    });
    const engine = new HostEngine(store, { claude: replay });
    const project = store.addProject(directory, "Test");
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });
    // A real lead session row exists so the execution_nodes FK holds.
    const created = engine.command({
      type: "create",
      commandId: "create",
      projectId: project.id,
      harness: "claude",
      model: "claude:test",
      runtimeMode: "supervised",
    });

    const run: OrchestrationRunView = {
      leadId: created.sessionId,
      runId: "run-1",
      dispatches: [
        { id: "d1", sessionId: "worker-1", taskId: "t1", state: "running" },
      ],
    };
    const { nodes } = projectOrchestration(run);
    for (const node of nodes) store.upsertNode(node);

    const stored = store.nodes(created.sessionId);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.kind).toBe("root_turn");
    expect(stored[1]!.kind).toBe("subagent");
    expect(stored[1]!.parentId).toBe(stored[0]!.id);
  });
});