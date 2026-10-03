// F4 (issue #12): MCP orchestration surface — the app-owned delegate_task
// tool. The delegating harness asks the APP to run a task on another harness
// (or worker); the app spawns a worker as a child subagent execution node
// under the delegating run (one graph), and the worker's result integrates
// back through the Handoff artifact. Capability-gated: strong providers get
// the native path; weak providers degrade to the app-owned synthetic path —
// never a silent opaqueness.
import type { HarnessId } from "../src/features/sessions/model/session";
import type { HostEngine } from "./engine";
import type { HostStore } from "./store";
import { capabilitiesFor, degradePolicy } from "./capabilities";
import { recordHandoff } from "./handoff-summary";

export type DelegationToolInput = {
  leadSessionId: string;
  /** The provider to delegate TO (the worker harness). */
  provider: HarnessId;
  model: string;
  task: string;
  runtimeMode: "supervised" | "auto" | "monitored" | "unrestricted";
};

export type DelegationResult = {
  workerSessionId: string;
  /** The worker's integrated result (its Handoff brief). */
  result: string;
  /** How the delegation ran: native when the target supports threads,
   *  synthetic when degradation applied. */
  policy: "native" | "synthetic";
};

/**
 * Run the app-owned delegate_task tool: spawn a worker as a child subagent node
 * under the delegating run, collect its result, and record a Handoff artifact.
 * Capability policy decides native vs synthetic (app projection).
 */
export async function delegateTask(
  store: HostStore,
  engine: HostEngine,
  input: DelegationToolInput,
): Promise<DelegationResult> {
  const caps = capabilitiesFor(input.provider);
  const policy = degradePolicy(caps, "handoff");

  // Spawn the worker as a NEW session through the engine.
  const project = store.session(input.leadSessionId).projectId;
  const leadRun = store.runs(input.leadSessionId).at(-1);
  const leadRoot = leadRun
    ? store
        .nodesForRun(input.leadSessionId, leadRun.id)
        .find((node) => node.parentId === null)
    : undefined;
  const worker = engine.command({
    type: "create",
    commandId: `delegate-create-${Date.now()}`,
    projectId: project,
    harness: input.provider,
    model: input.model,
    runtimeMode: input.runtimeMode,
  });

  engine.command({
    type: "send",
    commandId: `delegate-send-${Date.now()}`,
    sessionId: worker.sessionId,
    text: input.task,
  });

  // Wait for the worker's run to settle, then read its result.
  const workerRun = await (async () => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const runs = store.runs(worker.sessionId);
      const last = runs.at(-1);
      if (last && last.status !== "running") return last;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return store.runs(worker.sessionId).at(-1);
  })();

  // The worker's result: its last assistant reply (the Handoff brief source).
  const workerBlocks = store.session(worker.sessionId).session.blocks;
  const lastAssistant = [...workerBlocks]
    .reverse()
    .find((block) => block.role === "assistant");
  const result = lastAssistant?.text || workerRun?.message || "";

  // Record the delegation as an auditable Handoff artifact.
  recordHandoff(store, {
    sessionId: input.leadSessionId,
    provider: input.provider,
    runOrdinal: store.runs(input.leadSessionId).length + 1,
    summary: result,
    handler: "delegate_task",
  });

  // One graph: a child subagent node under the lead run's root. The worker is
  // a distinct session, but the delegation is part of the lead's execution
  // tree (matches the orchestration rework's one-model rule).
  if (leadRun && leadRoot) {
    store.upsertNode({
      id: `subagent:${worker.sessionId}`,
      sessionId: input.leadSessionId,
      runId: leadRun.id,
      parentId: leadRoot.id,
      kind: "subagent",
      status: workerRun && workerRun.status === "completed" ? "completed" : "running",
      startedAt: Date.now(),
      endedAt: null,
      content: {
        title: `Delegated to ${input.provider}: ${input.task.slice(0, 60)}`,
        detail: result.slice(0, 200),
      },
    });
  }

  return {
    workerSessionId: worker.sessionId,
    result,
    policy:
      policy === "supported" || policy === "synthetic_user_message"
        ? "native"
        : "synthetic",
  };
}