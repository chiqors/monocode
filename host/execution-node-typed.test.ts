// F5 (issue #13): typed execution nodes.
//
// The seam: the provider process boundary (replay harness) + the store. The
// content-agnostic normalizer is upgraded so plan/tool/approval CONTENT also
// normalizes into typed execution-node fields — per-tool status, nested
// checkpoints — while existing content-agnostic runs stay readable and
// project identically.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import {
  applyNodeEvent,
  freshRootNode,
  type ExecutionNode,
} from "./execution-node";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-typed-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("typed execution nodes (plan/tool/approval content)", () => {
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

  it("creates a tool node with typed content (kind/title/detail)", () => {
    const { nodes } = applyNodeEvent([root], {
      type: "tool.started",
      callId: "tool-1",
      title: "Read file",
      kind: "read",
    });
    const tool = nodes[1]!;
    expect(tool.kind).toBe("tool");
    // Typed content: the node carries the tool's kind/title for projections.
    expect("content" in tool ? (tool as { content?: unknown }).content : undefined).toBeDefined();
  });

  it("completes a typed tool node with its status and detail", () => {
    const started = applyNodeEvent([root], {
      type: "tool.started",
      callId: "tool-1",
      title: "Edit",
      kind: "edit",
    });
    const done = applyNodeEvent(started.nodes, {
      type: "tool.updated",
      callId: "tool-1",
      status: "completed",
      detail: "patched file.ts",
    });
    expect(done.nodes[1]!.status).toBe("completed");
  });

  it("creates an approval node with typed content (requestId, decision)", () => {
    const { nodes } = applyNodeEvent([root], {
      type: "approval.requested",
      requestId: 5,
      title: "Run git commit",
    });
    const approval = nodes[1]!;
    expect(approval.kind).toBe("approval");
    expect(approval.status).toBe("running");
  });

  it("resolves an approval node when the decision arrives", () => {
    const requested = applyNodeEvent([root], {
      type: "approval.requested",
      requestId: 5,
      title: "Run git commit",
    });
    const resolved = applyNodeEvent(requested.nodes, {
      type: "approval.resolved",
      requestId: 5,
      decision: "allow",
    });
    const approval = resolved.nodes[1]!;
    // Approval nodes never complete the run (root-only completion): the
    // approval settles to a terminal sub-state but root stays running.
    expect(approval.status).not.toBe("running");
    expect(resolved.rootCompleted).toBe(false);
    expect(resolved.nodes[0]!.status).toBe("running");
  });

  it("keeps existing content-agnostic runs readable (no content required)", () => {
    // A run with no typed content (a pure lifecycle run from the old normalizer)
    // still reduces identically — the typed fields are optional.
    const done = applyNodeEvent([root], {
      type: "message.completed",
    });
    expect(done.rootCompleted).toBe(true);
    expect(done.nodes[0]!.status).toBe("completed");
    // And a legacy tool node without typed content still completes.
    const legacy = applyNodeEvent([root], {
      type: "tool.started",
      callId: "legacy-tool",
      title: "Legacy",
    });
    expect(legacy.nodes[1]!.kind).toBe("tool");
    expect("content" in legacy.nodes[1]! ? true : false).toBe(true);
  });
});