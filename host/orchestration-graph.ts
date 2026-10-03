// T7 (issue #8): orchestration rework onto the graph (one model).
//
// ADR-0001: a lead run is a root execution node and its worker dispatches are
// CHILD execution nodes (kind = "subagent"). Orchestration rides the same
// graph as ordinary chats — one model, not a separate state store. This
// projector maps an OrchestrationRun's dispatches onto execution nodes, and a
// forward migration records the graph linkage on save while keeping legacy
// history readable.

import type { ExecutionNode } from "./execution-node";
import type { HostStore } from "./store";

/** The graph linkage an orchestration run carries after migration. */
export type OrchestrationGraphLink = {
  /** The lead session's run that is this orchestration's root node. */
  leadRunId: string;
  /** Worker dispatch id -> the child subagent node id under the lead root. */
  workerNodeIds: Record<string, string>;
};

/** A minimal, host-side view of one orchestration dispatch. */
export type DispatchView = {
  id: string;
  sessionId: string;
  taskId: string;
  state: string;
};

/** A minimal host-side orchestration run to project. */
export type OrchestrationRunView = {
  leadId: string;
  /** The lead session's current run (the root node), when known. */
  runId?: string;
  dispatches?: DispatchView[];
};

/**
 * Project an orchestration run onto the execution graph: the lead run is the
 * root node; each dispatch becomes a child subagent node under it. Returns the
 * child nodes (for persistence) and the graph link.
 */
export function projectOrchestration(
  run: OrchestrationRunView,
  now = Date.now(),
): {
  nodes: ExecutionNode[];
  link: OrchestrationGraphLink;
} {
  const leadRunId = run.runId ?? `orchestration:${run.leadId}`;
  const nodes: ExecutionNode[] = [
    {
      id: `orchestration-root:${run.leadId}`,
      sessionId: run.leadId,
      runId: leadRunId,
      parentId: null,
      kind: "root_turn",
      status: "running",
      startedAt: now,
      endedAt: null,
    },
  ];
  const link: OrchestrationGraphLink = {
    leadRunId,
    workerNodeIds: {},
  };
  for (const dispatch of run.dispatches ?? []) {
    const nodeId = `orchestration-worker:${dispatch.id}`;
    nodes.push({
      id: nodeId,
      // One model: worker nodes are part of the LEAD run's node tree, scoped
      // to the lead session. The worker's own session is a separate corollary
      // (its provider turn), not the tree's identity.
      sessionId: run.leadId,
      runId: leadRunId,
      parentId: `orchestration-root:${run.leadId}`,
      kind: "subagent",
      status: dispatch.state === "completed" ? "completed" : "running",
      startedAt: now,
      endedAt: dispatch.state === "completed" ? now : null,
    });
    link.workerNodeIds[dispatch.id] = nodeId;
  }
  return { nodes, link };
}

/**
 * Forward-migrate an orchestration run's stored state to include the graph
 * linkage: returns the migrated run (with the `graph` field) or null if the
 * run shape is unsupported. Legacy history (versions 1/2) stays readable.
 */
export function migrateOrchestrationGraph(
  raw: unknown,
): { run: { graph: OrchestrationGraphLink } & Record<string, unknown> } | null {
  const run = raw as { leadId?: unknown; tasks?: unknown; dispatches?: unknown };
  if (!run || typeof run !== "object" || typeof run.leadId !== "string")
    return null;
  const dispatches = Array.isArray(run.dispatches)
    ? (run.dispatches as DispatchView[]).filter(
        (d) => d && typeof d.id === "string",
      )
    : [];
  const { link } = projectOrchestration({
    leadId: run.leadId!,
    dispatches,
  });
  return { run: { ...run, graph: link } };
}

/**
 * Contract (ADR-0001): read a worker dispatch's durable state from the
 * execution graph (the node tree) instead of the parallel dispatch state.
 * Returns the worker's graph node status when the graph link exists, else
 * null (legacy run without a link falls back to its own dispatch state).
 */
export function readOrchestrationFromGraph(
  store: HostStore,
  leadSessionId: string,
  run: { graph?: OrchestrationGraphLink; dispatches?: DispatchView[] },
): { dispatchId: string; status: string }[] | null {
  if (!run.graph) return null;
  const nodes = store.nodesForRun(leadSessionId, run.graph.leadRunId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const workers = run.dispatches ?? [];
  const result: { dispatchId: string; status: string }[] = [];
  for (const dispatch of workers) {
    const nodeId = run.graph.workerNodeIds[dispatch.id];
    const node = nodeId ? byId.get(nodeId) : undefined;
    result.push({
      dispatchId: dispatch.id,
      status: node ? node.status : dispatch.state,
    });
  }
  return result;
}