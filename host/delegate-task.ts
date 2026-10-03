// F4 (issue #12) + G5 (issue #20): MCP orchestration surface — the app-owned
// delegate_task tool.
// tool. The delegating harness asks the APP to run a task on another harness
// (or worker); the app spawns a worker as a child subagent execution node
// under the delegating run (one graph), and the worker's result integrates
// back through the Handoff artifact. Capability-gated: strong providers get
// the native path; weak providers degrade to the app-owned synthetic path —
// never a silent opaqueness.
//
// G5 makes the result STRUCTURED: a durable `subagent_result` (LHS context
// transfer) with `taskId`, `childThreadId`, `childRunId`, `childNodeId`,
// `workState`, `latestTerminal*`, wait timeout, `task_status` / `task_cancel`,
// and `mode: async | wait` — instead of the worker's last assistant block.
import type { HarnessId } from "../src/features/sessions/model/session";
import type { HostEngine } from "./engine";
import type { HostStore } from "./store";
import { capabilitiesFor, degradePolicy } from "./capabilities";
import { recordHandoff } from "./handoff-summary";

export type DelegationMode = "async" | "wait";

export type WorkState = "working" | "waiting_for_children" | "result_available";

export type DelegationToolInput = {
  leadSessionId: string;
  /** The provider to delegate TO (the worker harness). */
  provider: HarnessId;
  model: string;
  task: string;
  runtimeMode: "supervised" | "auto" | "monitored" | "unrestricted";
  /** G5: async returns immediately with durable state; wait polls to settlement. */
  mode?: DelegationMode;
  /** G5: optional wait timeout in ms (async tasks never hit the 3s poll). */
  timeoutMs?: number;
};

export type DelegationResult = {
  /** G5: durable task id (recoverable, trackable). */
  taskId: string;
  /** The app session id of the spawned worker thread. */
  workerSessionId: string;
  /** The provider-native / app thread the worker runs on (LHS child thread). */
  childThreadId: string;
  /** The worker's first (child) run id, or null if not yet dispatched. */
  childRunId: string | null;
  /** The child subagent node id under the lead's execution graph. */
  childNodeId: string | null;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  workState: WorkState;
  /** The published result summary (stable once available). */
  summary: string | null;
  /** The durable context-transfer id for the result (Handoff row id). */
  resultContextTransferId: string | null;
  latestTerminalRunId: string | null;
  latestTerminalStatus: "completed" | "failed" | "cancelled" | "interrupted" | null;
  latestTerminalSummary: string | null;
  waitTimedOut: boolean;
  /** How the delegation ran: native when the target supports threads,
   *  synthetic when degradation applied. */
  policy: "native" | "synthetic";
};

export type DelegatedTaskRow = {
  taskId: string;
  leadSessionId: string;
  /** G5: the child thread id (the worker app session). */
  childThreadId: string;
  childSessionId: string;
  childRunId: string | null;
  childNodeId: string | null;
  status: DelegationResult["status"];
  workState: WorkState;
  summary: string | null;
  latestTerminalRunId: string | null;
  latestTerminalStatus: DelegationResult["latestTerminalStatus"];
  resultContextTransferId: string | null;
  mode: DelegationMode;
  timeoutMs: number | null;
  waitTimedOut: boolean;
  createdAt: number;
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
  const workerSessionId = worker.sessionId;
  const taskId = `task:${crypto.randomUUID()}`;
  // The child subagent node id under the lead run (created on settlement, but
  // referenced durably now so task_status works before it finishes).
  const childNodeId = `subagent:${workerSessionId}`;

  engine.command({
    type: "send",
    commandId: `delegate-send-${Date.now()}`,
    sessionId: workerSessionId,
    text: input.task,
  });

  // mode: async | wait. Async returns the durable state NOW (no 3s bounded
  // poll); wait polls up to timeoutMs (default the task's timeoutMs or 3s).
  const mode: DelegationMode = input.mode ?? "wait";
  const timeoutMs = input.timeoutMs ?? 3_000;
  const workerRun = await (async () => {
    if (mode === "async") return store.runs(workerSessionId).at(-1) ?? null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = store.runs(workerSessionId);
      const last = runs.at(-1);
      if (last && last.status !== "running") return last;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return store.runs(workerSessionId).at(-1) ?? null;
  })();

  return finalizeDelegation(
    store,
    {
      leadSessionId: input.leadSessionId,
      provider: input.provider,
      workerSessionId,
      taskId,
      childNodeId,
      workerRun,
      mode,
      timeoutMs,
      waitTimedOut: mode === "wait" && workerRun?.status === "running",
      policy:
        policy === "supported" || policy === "synthetic_user_message"
          ? "native"
          : "synthetic",
    },
    leadRun,
    leadRoot,
    input.task,
  );
}

type FinalizeScope = {
  leadSessionId: string;
  provider: HarnessId;
  workerSessionId: string;
  taskId: string;
  childNodeId: string;
  workerRun: ReturnType<HostStore["runs"]>[number] | null;
  mode: DelegationMode;
  timeoutMs: number;
  waitTimedOut: boolean;
  policy: DelegationResult["policy"];
};

/** Snapshot the durable task row + integrate the result into the lead. */
function finalizeDelegation(
  store: HostStore,
  scope: FinalizeScope,
  leadRun: ReturnType<HostStore["runs"]>[number] | undefined,
  leadRoot: { id: string } | undefined,
  task: string,
): DelegationResult {
  const { leadSessionId, provider, workerSessionId, taskId, childNodeId, workerRun } = scope;
  // The worker's structured result (workState + latestTerminal*), NOT the raw
  // last assistant block.
  const workerRuns = store.runs(workerSessionId);
  const latestTerminal = workerRuns.filter((r) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(r.status),
  ).at(-1);
  const workerBlocks = store.session(workerSessionId).session.blocks;
  const lastAssistant = [...workerBlocks]
    .reverse()
    .find((block) => block.role === "assistant");
  const summary =
    lastAssistant?.text ||
    latestTerminal?.message ||
    (workerRun ? `Worker run ${workerRun.ordinal} (${workerRun.status})` : "Task queued");
  const workState: WorkState =
    latestTerminal?.status === "completed" ? "result_available" : "working";
  const terminalStatus = latestTerminal?.status;
  const status: DelegationResult["status"] =
    terminalStatus === "rolled_back"
      ? "cancelled"
      : terminalStatus ?? (workerRun ? "running" : "queued");

  // Record the delegation as an auditable Handoff artifact carrying the
  // structured result (F4's one-graph model preserved).
  const handoffId = recordHandoff(store, {
    sessionId: leadSessionId,
    provider,
    runOrdinal: store.runs(leadSessionId).length + 1,
    summary,
    handler: "delegate_task",
  });

  // One graph: a child subagent node under the lead run's root.
  if (leadRun && leadRoot) {
    store.upsertNode({
      id: childNodeId,
      sessionId: leadSessionId,
      runId: leadRun.id,
      parentId: leadRoot.id,
      kind: "subagent",
      status: latestTerminal?.status === "completed" ? "completed" : "running",
      startedAt: Date.now(),
      endedAt: null,
      content: {
        title: `Delegated to ${provider}: ${task.slice(0, 60)}`,
        detail: summary.slice(0, 200),
      },
    });
  }

  // Durable task row (recoverable across restart, no double-dispatch).
  store.db
    .prepare(
      `INSERT INTO delegated_tasks
         (task_id, lead_session_id, child_session_id, child_run_id, child_node_id, status, work_state, summary, latest_terminal_run_id, latest_terminal_status, result_context_transfer_id, mode, timeout_ms, wait_timed_out, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         status=excluded.status,
         work_state=excluded.work_state,
         summary=excluded.summary,
         latest_terminal_run_id=excluded.latest_terminal_run_id,
         latest_terminal_status=excluded.latest_terminal_status,
         result_context_transfer_id=excluded.result_context_transfer_id,
         wait_timed_out=excluded.wait_timed_out`,
    )
    .run(
      taskId,
      leadSessionId,
      workerSessionId,
      latestTerminal?.id ?? null,
      childNodeId,
      status,
      workState,
      summary,
      latestTerminal?.id ?? null,
      latestTerminal?.status ?? null,
      handoffId,
      scope.mode,
      scope.timeoutMs,
      scope.waitTimedOut ? 1 : 0,
      Date.now(),
    );

  return {
    taskId,
    workerSessionId,
    childThreadId: workerSessionId,
    childRunId: latestTerminal?.id ?? null,
    childNodeId,
    status,
    workState,
    summary,
    resultContextTransferId: handoffId,
    latestTerminalRunId: latestTerminal?.id ?? null,
    latestTerminalStatus: (latestTerminal?.status as DelegationResult["latestTerminalStatus"]) ?? null,
    latestTerminalSummary: latestTerminal ? summary : null,
    waitTimedOut: scope.waitTimedOut,
    policy: scope.policy,
  };
}

/** Read a delegated task's durable state (rejects unknown/foreign ids). */
export function taskStatus(
  store: HostStore,
  taskId: string,
): DelegatedTaskRow | null {
  const row = store.db
    .prepare(
      `SELECT task_id AS taskId,
              lead_session_id AS leadSessionId,
              child_session_id AS childSessionId,
              child_run_id AS childRunId,
              child_node_id AS childNodeId,
              status,
              work_state AS workState,
              summary,
              latest_terminal_run_id AS latestTerminalRunId,
              latest_terminal_status AS latestTerminalStatus,
              result_context_transfer_id AS resultContextTransferId,
              mode,
              timeout_ms AS timeoutMs,
              wait_timed_out AS waitTimedOut,
              created_at AS createdAt
       FROM delegated_tasks WHERE task_id=?`,
    )
    .get(taskId) as
    | (Omit<DelegatedTaskRow, "waitTimedOut"> & { waitTimedOut: number })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    waitTimedOut: Boolean(row.waitTimedOut),
    childThreadId: row.childSessionId,
  };
}

/** Cancel a delegated task (idempotent for terminal tasks). */
export function taskCancel(
  store: HostStore,
  engine: HostEngine,
  taskId: string,
): { taskId: string; cancelled: boolean } {
  const task = taskStatus(store, taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(
    task.status,
  );
  if (!terminal) {
    // Interrupt the worker's active run via the engine's cancel path.
    const run = store.runs(task.childSessionId).find((r) => r.status === "running");
    if (run) engine.command({ type: "cancel", commandId: `cancel-${taskId}`, sessionId: task.childSessionId, runId: run.id });
    store.db
      .prepare(
        "UPDATE delegated_tasks SET status='cancelled', work_state='working' WHERE task_id=? AND status NOT IN ('completed','failed','cancelled','interrupted')",
      )
      .run(taskId);
  }
  return { taskId, cancelled: !terminal };
}