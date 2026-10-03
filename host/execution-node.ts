// T4 (issue #5): execution graph (nodes, root-only completion, run attempts).
//
// A Run carries an execution-node tree. The root node is the user turn; child
// nodes are tools, approvals, and subagent work. Only the ROOT node's
// completion completes the run — child nodes complete independently and never
// end the parent run.
import type { HarnessEvent } from "../src/integrations/harness/core/types";
import { now } from "./determinism";

export type NodeKind =
  | "root_turn"
  | "tool"
  | "approval"
  | "subagent";

export type NodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "interrupted"
  | "failed";

export type ExecutionNode = {
  id: string;
  /** The app session the node belongs to. */
  sessionId: string;
  /** The run the node belongs to. */
  runId: string;
  /** null for the root; the app node id of the parent otherwise. */
  parentId: string | null;
  kind: NodeKind;
  status: NodeStatus;
  startedAt: number;
  endedAt: number | null;
  /**
   * Optional typed content (F5): the node's plan/tool/approval substance, so
   * projections can show per-tool status and nested checkpoints. Absent for
   * legacy content-agnostic runs — those stay readable and identical.
   */
  content?: {
    kind?: string;
    title?: string;
    detail?: string;
    requestId?: number;
    decision?: "allow" | "deny" | "cancelled";
  };
};

export type NodeReduction = {
  nodes: ExecutionNode[];
  /** True only when the ROOT node completed (message.completed on the run). */
  rootCompleted: boolean;
};

const TERMINAL_NODE_EVENTS: Partial<
  Record<HarnessEvent["type"], NodeStatus>
> = {
  "message.completed": "completed",
  "session.error": "interrupted",
  "session.ended": "interrupted",
};

/** Fresh root node for a new run. */
export function freshRootNode(
  sessionId: string,
  runId: string,
): ExecutionNode {
  return {
    id: `root:${runId}`,
    sessionId,
    runId,
    parentId: null,
    kind: "root_turn",
    status: "running",
    startedAt: now(),
    endedAt: null,
  };
}

/**
 * Content-agnostic node reducer: apply one harness event to the node list.
 * - message.delta / non-lifecycle events: no structural change.
 * - tool.started: create a child tool node under the current root.
 * - tool.updated: complete the matching child tool node (never the root).
 * - message.completed: only the ROOT node completes -> rootCompleted=true.
 * - session.error / session.ended: root (+ open children) interrupted.
 */
export function applyNodeEvent(
  nodes: ExecutionNode[],
  event: HarnessEvent,
): NodeReduction {
  const root = nodes[0];
  if (!root) return { nodes, rootCompleted: false };

  switch (event.type) {
    case "tool.started": {
      const child: ExecutionNode = {
        id: `tool:${event.callId}`,
        sessionId: root.sessionId,
        runId: root.runId,
        parentId: root.id,
        kind: "tool",
        status: "running",
        startedAt: now(),
        endedAt: null,
        content: {
          ...(event.title ? { title: event.title } : {}),
          ...(event.kind ? { kind: event.kind } : {}),
          ...(event.preview?.path
            ? { detail: event.preview.path }
            : event.preview?.title
              ? { detail: event.preview.title }
              : {}),
        },
      };
      return { nodes: [...nodes, child], rootCompleted: false };
    }
    case "tool.updated": {
      const nextStatus =
        event.status === "failed"
          ? ("failed" as const)
          : event.status === "completed"
            ? ("completed" as const)
            : null;
      if (!nextStatus) return { nodes, rootCompleted: false };
      const next = nodes.map((node) =>
        node.kind === "tool" && node.id === `tool:${event.callId}`
          ? {
              ...node,
              status: nextStatus,
              endedAt: now(),
              ...(event.detail
                ? { content: { ...node.content, detail: event.detail } }
                : {}),
            }
          : node,
      );
      return { nodes: next, rootCompleted: false };
    }
    case "approval.requested": {
      const child: ExecutionNode = {
        id: `approval:${event.requestId}`,
        sessionId: root.sessionId,
        runId: root.runId,
        parentId: root.id,
        kind: "approval",
        status: "running",
        startedAt: now(),
        endedAt: null,
        content: {
          requestId: event.requestId,
          ...(event.title ? { title: event.title } : {}),
        },
      };
      return { nodes: [...nodes, child], rootCompleted: false };
    }
    case "approval.resolved": {
      const next = nodes.map((node) =>
        node.kind === "approval" &&
        node.content?.requestId === event.requestId
          ? {
              ...node,
              status: "completed" as const,
              endedAt: now(),
              content: { ...node.content, decision: event.decision },
            }
          : node,
      );
      return { nodes: next, rootCompleted: false };
    }
    case "message.completed": {
      // ONLY the root node completing completes the run.
      const next = nodes.map((node, index) =>
        index === 0
          ? { ...node, status: "completed" as const, endedAt: Date.now() }
          : node,
      );
      return { nodes: next, rootCompleted: true };
    }
    case "session.error":
    case "session.ended": {
      const terminal = TERMINAL_NODE_EVENTS[event.type]!;
      const next = nodes.map((node) =>
        node.status === "running" || node.status === "pending"
          ? { ...node, status: terminal, endedAt: Date.now() }
          : node,
      );
      return { nodes: next, rootCompleted: terminal === "completed" };
    }
    default:
      return { nodes, rootCompleted: false };
  }
}