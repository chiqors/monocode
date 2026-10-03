import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { renameHostWorktreeBranch, resolveHostWorktree } from "./git-worktrees";
import {
  applyHarnessEvent,
  stopStreaming,
} from "../src/integrations/harness/core/apply";
import { resolveModel } from "../src/features/sessions/model/models";
import { isVisionImage } from "../src/features/sessions/model/attachments";
import type {
  HarnessEvent,
  HarnessSessionInput,
} from "../src/integrations/harness/core/types";
import {
  HARNESS_LABEL,
  RUNTIME_MODES,
  canReplaceSessionTitle,
  formatSessionTitle,
  titleFromPrompt,
  type Session,
} from "../src/features/sessions/model/session";
import { namedWorktreeBranch } from "../src/features/source-control/model/worktrees";
import {
  isRemoteProvider,
  type HostCommand,
  type HostSession,
  type CommandReceipt,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";
import type { HostProvider } from "./providers";
import { HostStore } from "./store";
import {
  freshRunLifecycle,
  normalizeRunEvent,
  type RunLifecycle,
} from "./run-normalizer";
import { bindProviderRef, pickCorrelationStrategy } from "./correlation";
import { now, uuid } from "./determinism";
import {
  applyNodeEvent,
  freshRootNode,
} from "./execution-node";
import { forkThread, resolveForkOnFirstDispatch } from "./fork-merge";
import { rollbackThread } from "./rollback";
import {
  buildRunHandoffSummary,
  recordHandoff,
} from "./handoff-summary";
import {
  recordProviderThread,
  providerThreads,
} from "./provider-thread";
import { capabilitiesFor, degradePolicy } from "./capabilities";
import {
  enqueueProviderEffect,
  markEffectInFlight,
  markEffectDone,
} from "./provider-effects";
import {
  createCheckpointScope,
  ensurePreRunBaseline,
  captureCheckpoint,
  checkpointScopes,
} from "./checkpoint";
import { parseRemoteAttachments, resolveAttachments } from "./attachments";

// Streamed output is written in batches. Anything a user may need to act on
// (approvals, questions, errors, completion) is written immediately.
const FLUSH_MS = 120;
const BATCHED = new Set<string>([
  "message.delta",
  "reasoning.delta",
  "tool.updated",
  "agent.step",
  "status",
]);

const text = (value: unknown, label: string, max = 128): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error(`Invalid ${label}`);
  return value;
};

function modelSettings(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid model settings");
  const entries = Object.entries(value);
  if (
    entries.length > 20 ||
    entries.some(
      ([key, setting]) =>
        !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) ||
        typeof setting !== "string" ||
        setting.length > 128 ||
        setting.includes("\0"),
    )
  )
    throw new Error("Invalid model settings");
  return Object.fromEntries(entries) as Record<string, string>;
}

export function parseCommand(input: unknown): HostCommand {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid command");
  const v = input as Record<string, unknown>;
  const commandId = text(v.commandId, "command ID");
  if (v.type === "create") {
    if (
      !isRemoteProvider(v.harness) ||
      !RUNTIME_MODES.includes(v.runtimeMode as never)
    )
      throw new Error("Invalid provider or permission mode");
    if (
      v.autoWorktreeBranch !== undefined &&
      (v.worktreeCwd === undefined ||
        typeof v.autoWorktreeBranch !== "string" ||
        !/^mc\/[a-z0-9]{8}$/.test(v.autoWorktreeBranch))
    )
      throw new Error("Invalid automatically created worktree branch");
    return {
      type: "create",
      commandId,
      projectId: text(v.projectId, "project ID"),
      ...(v.worktreeCwd !== undefined
        ? { worktreeCwd: text(v.worktreeCwd, "working copy", 4096) }
        : {}),
      ...(v.autoWorktreeBranch !== undefined
        ? { autoWorktreeBranch: v.autoWorktreeBranch as string }
        : {}),
      harness: v.harness,
      model: text(v.model, "model", 200),
      ...(v.modelSettings !== undefined
        ? { modelSettings: modelSettings(v.modelSettings) }
        : {}),
      runtimeMode: v.runtimeMode as Session["runtimeMode"],
    };
  }
  const sessionId = text(v.sessionId, "session ID");
  if (v.type === "configure") {
    if (!RUNTIME_MODES.includes(v.runtimeMode as never))
      throw new Error("Invalid permission mode");
    if (
      v.harness !== undefined &&
      (!isRemoteProvider(v.harness) || String(v.harness) !== v.harness)
    )
      throw new Error("Invalid provider");
    return {
      type: "configure",
      commandId,
      sessionId,
      model: text(v.model, "model", 200),
      modelSettings: modelSettings(v.modelSettings),
      runtimeMode: v.runtimeMode as Session["runtimeMode"],
      ...(v.harness !== undefined ? { harness: v.harness as RemoteProvider } : {}),
    };
  }
  if (v.type === "compact") return { type: "compact", commandId, sessionId };
  if (v.type === "send" || v.type === "draft") {
    const attachments = parseRemoteAttachments(v.attachments);
    if (
      typeof v.text !== "string" ||
      v.text.length > 256_000 ||
      v.text.includes("\0") ||
      (!v.text.trim() &&
        attachments.length === 0 &&
        !(v.type === "send" && v.draftBlockId !== undefined))
    )
      throw new Error("Invalid prompt");
    if (
      v.type === "send" &&
      v.intent !== undefined &&
      !["default", "plan", "build"].includes(String(v.intent))
    )
      throw new Error("Invalid turn intent");
    if (
      v.planBlockId !== undefined &&
      (v.type !== "send" || v.intent !== "build")
    )
      throw new Error("Invalid plan build");
    return {
      type: v.type,
      commandId,
      sessionId,
      text: v.text,
      ...(attachments.length ? { attachments } : {}),
      ...(v.type === "send" && v.intent
        ? { intent: v.intent as "default" | "plan" | "build" }
        : {}),
      ...(v.type === "send" && v.draftBlockId !== undefined
        ? { draftBlockId: text(v.draftBlockId, "draft block ID") }
        : {}),
      ...(v.type === "send" && v.planBlockId !== undefined
        ? { planBlockId: text(v.planBlockId, "plan block ID") }
        : {}),
    };
  }
  if (v.type === "removeDraft")
    return {
      type: "removeDraft",
      commandId,
      sessionId,
      draftBlockId: text(v.draftBlockId, "draft block ID"),
    };
  if (v.type === "fork") {
    if (
      !Number.isSafeInteger(v.forkRunOrdinal) ||
      Number(v.forkRunOrdinal) < 1
    )
      throw new Error("Invalid fork run ordinal");
    return {
      type: "fork",
      commandId,
      sessionId,
      forkRunOrdinal: Number(v.forkRunOrdinal),
    };
  }
  if (v.type === "rollback") {
    if (
      !Number.isSafeInteger(v.targetRunOrdinal) ||
      Number(v.targetRunOrdinal) < 1
    )
      throw new Error("Invalid rollback target run ordinal");
    return {
      type: "rollback",
      commandId,
      sessionId,
      targetRunOrdinal: Number(v.targetRunOrdinal),
    };
  }
  const runId = text(v.runId, "run ID");
  if (v.type === "cancel")
    return { type: "cancel", commandId, sessionId, runId };
  if (!Number.isSafeInteger(v.requestId) || Number(v.requestId) < 0)
    throw new Error("Invalid request ID");
  const requestId = Number(v.requestId);
  if (v.type === "approve" && (v.decision === "allow" || v.decision === "deny"))
    return {
      type: "approve",
      commandId,
      sessionId,
      runId,
      requestId,
      decision: v.decision,
    };
  if (v.type === "answer") {
    const reply = v.reply as
      { kind?: string; answers?: unknown; custom?: unknown } | undefined;
    if (reply?.kind === "skipped")
      return {
        type: "answer",
        commandId,
        sessionId,
        runId,
        requestId,
        reply: { kind: "skipped" },
      };
    if (
      reply?.kind === "answered" &&
      reply.answers &&
      typeof reply.answers === "object" &&
      !Array.isArray(reply.answers)
    ) {
      const entries = Object.entries(reply.answers);
      if (
        entries.length > 50 ||
        entries.some(
          ([key, value]) =>
            key.length > 200 ||
            !Array.isArray(value) ||
            value.length > 50 ||
            value.some((x) => typeof x !== "string" || x.length > 10_000),
        )
      )
        throw new Error("Invalid question answers");
      if (
        reply.custom != null &&
        (typeof reply.custom !== "object" ||
          Array.isArray(reply.custom) ||
          Object.values(reply.custom).some(
            (x) => typeof x !== "string" || x.length > 10_000,
          ))
      )
        throw new Error("Invalid custom answers");
      return {
        type: "answer",
        commandId,
        sessionId,
        runId,
        requestId,
        reply: {
          kind: "answered",
          answers: Object.fromEntries(entries),
          ...(reply.custom
            ? { custom: reply.custom as Record<string, string> }
            : {}),
        },
      };
    }
  }
  throw new Error("Unsupported command");
}

export class HostEngine {
  private switchingProjects = new Set<string>();
  private running = new Map<
    string,
    { runId: string; done: Promise<void>; cancelled: boolean; persistenceFailed: boolean }
  >();
  /** Running sessions, including streamed events not yet written to disk. */
  private live = new Map<
    string,
    {
      value: HostSession;
      events: HarnessEvent[];
      runLifecycle: RunLifecycle;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;

  constructor(
    readonly store: HostStore,
    private readonly providers: Partial<Record<RemoteProvider, HostProvider>>,
  ) {
    // Provider dispatch is not transactional with SQLite. Never replay a send
    // automatically after a crash; its external effects may already exist.
    for (const value of store.sessions()) {
      if (value.status === "running") {
        // Only the affected run is marked failed/interrupted; the thread and
        // prior runs stay intact. Finalize the durable run row alongside the
        // session settle so the run reflects the interruption.
        const interruptedRun = value.runId
          ? store.runs(value.session.id).find((r) => r.id === value.runId)
          : undefined;
        if (interruptedRun && interruptedRun.status === "running") {
          store.upsertRun(value.session.id, {
            ...interruptedRun,
            status: "interrupted",
            endedAt: value.updatedAt,
          });
          // S1: a crashed/hanging turn never reaches the run-loop completion
          // path, so its turn.start effect stays in-flight forever. Retire it
          // here exactly like the normal completion path (markEffectDone),
          // so the outbox is drained once and never re-sends after a restart.
          markEffectDone(store, value.session.id, interruptedRun.id);
        }
        this.save(
          this.settled(
            value,
            "interrupted",
            "Host restarted. This turn was interrupted; inspect its work before continuing.",
            value.updatedAt,
          ),
          { type: "interrupted" },
        );
      }
      if (value.session.providerSessionId)
        this.provider(value.session.harness).bind(
          value.session.id,
          value.session.providerSessionId,
          value.session.cwd,
        );
    }
  }

  async openProject(path: string) {
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("Choose an absolute directory path on the host");
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory())
      throw new Error("Project path is not a directory");
    return this.store.addProject(cwd, basename(cwd));
  }

  async withIdleProject<T>(
    projectId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.switchingProjects.has(projectId))
      throw new Error("A branch switch is already in progress");
    if (
      this.store
        .summaries(projectId)
        .some((session) => session.status === "running")
    )
      throw new Error(
        "Wait for running host sessions before switching branches",
      );
    this.switchingProjects.add(projectId);
    try {
      return await action();
    } finally {
      this.switchingProjects.delete(projectId);
    }
  }

  private provider(id: string): HostProvider {
    const provider = this.providers[id as RemoteProvider];
    if (!provider) throw new Error(`${id} is not available on this host`);
    return provider;
  }

  private save(value: HostSession, event: unknown): HostSession {
    return this.store.transaction(() =>
      this.store.save({ ...value, revision: value.revision + 1, updatedAt: now() }, event),
    );
  }

  updateSession(id: string, patch: Parameters<HostStore["updateSession"]>[1]) {
    this.flush(id);
    const summary = this.store.updateSession(id, patch);
    const live = this.live.get(id);
    if (live) live.value = this.store.session(id);
    return summary;
  }

  private flush(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    clearTimeout(live.timer);
    live.timer = undefined;
    if (!live.events.length) return;
    const events = live.events;
    live.value = this.save(live.value, { type: "events", events });
    live.events = [];
  }

  private scheduledFlush(id: string, provider: HostProvider): void {
    try {
      this.flush(id);
    } catch (error) {
      const active = this.running.get(id);
      if (active) active.persistenceFailed = true;
      console.error(
        "Session persistence failed; stopping its provider:",
        error instanceof Error ? error.message : "unknown error",
      );
      void provider.stop(id);
    }
  }

  private retrySettlement(
    id: string,
    runId: string,
    provider: HostProvider,
  ): void {
    if (this.closing || this.retryTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      void (async () => {
        try {
          await provider.stop(id);
          this.flush(id);
          const latest = this.store.session(id);
          if (latest.runId === runId && latest.status === "running")
            this.save(
              this.settled(
                latest,
                "interrupted",
                "Session storage failed during this turn. Inspect its work before continuing.",
                latest.updatedAt,
              ),
              { type: "interrupted", reason: "persistence failure" },
            );
          this.live.delete(id);
          this.running.delete(id);
          if (latest.session.providerSessionId)
            provider.bind(
              id,
              latest.session.providerSessionId,
              latest.session.cwd,
            );
        } catch (error) {
          console.error(
            "Retrying session persistence:",
            error instanceof Error ? error.message : "unknown error",
          );
          this.retrySettlement(id, runId, provider);
        }
      })();
    }, 1_000);
    timer.unref?.();
    this.retryTimers.set(id, timer);
  }

  command(raw: unknown): CommandReceipt {
    if (this.closing) throw new Error("Host is stopping");
    const command = parseCommand(raw);
    const signature = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const previous = this.store.receipt(command.commandId, signature);
    if (previous) return previous;
    // Commands apply to the latest state, including batched stream output.
    if (command.type !== "create") this.flush(command.sessionId);
    let effect: ((saved: HostSession) => void) | undefined;
    const { receipt, saved } = this.store.transaction(() => {
      let value: HostSession;
      if (command.type === "create") {
        const project = this.store.project(command.projectId);
        if (this.switchingProjects.has(project.id))
          throw new Error("Wait for the branch switch to finish");
        this.provider(command.harness);
        const cwd = resolveHostWorktree(project.cwd, command.worktreeCwd);
        const createdAt = now();
        value = {
          projectId: project.id,
          autoWorktreeBranch: command.autoWorktreeBranch,
          revision: 0,
          status: "idle",
          createdAt,
          updatedAt: createdAt,
          session: {
            id: uuid(),
            cwd,
            harness: command.harness,
            model: command.model,
            runtimeMode: command.runtimeMode,
            modelSettings: command.modelSettings ?? {},
            title: "New remote session",
            ...(command.autoWorktreeBranch
              ? { branch: command.autoWorktreeBranch, worktreeCwd: cwd }
              : {}),
            blocks: [],
          },
        };
      } else {
        value = this.store.session(command.sessionId);
        if (
          (command.type === "send" || command.type === "compact") &&
          this.switchingProjects.has(value.projectId)
        )
          throw new Error("Wait for the branch switch to finish");
        const provider = this.provider(value.session.harness);
        if (command.type === "configure") {
          if (value.status === "running")
            throw new Error(
              "Wait for the current turn before changing settings",
            );
          const switching = command.harness !== undefined;
          if (switching && command.harness !== value.session.harness) {
            // TS does not narrow `command.harness` here; capture the defined
            // harness (the switch target) once for the whole branch.
            // The branch guard (`switching && command.harness !==
            // value.session.harness`) guarantees command.harness is set.
            const targetHarness = command.harness!;
            const latestRun = this.store.runs(value.session.id).at(-1);
            // Departure handoff (from-side, existing T5 convention): record a
            // durable, store-derived artifact for the provider we are leaving.
            const departureSummary = buildRunHandoffSummary(
              this.store,
              value.session.id,
            );
            const departure = recordHandoff(this.store, {
              sessionId: value.session.id,
              provider: value.session.harness,
              runOrdinal: latestRun?.ordinal ?? 1,
              summary: departureSummary,
              handler: value.session.harness,
            });
            // Extend the departing provider's durable thread up to the latest
            // run and link the handoff id, so coverage + handoffIds are one
            // source of truth for a later switch-back delta.
            const departing = providerThreads(this.store, value.session.id).find(
              (thread) => thread.provider === value.session.harness,
            );
            recordProviderThread(this.store, {
              sessionId: value.session.id,
              provider: value.session.harness,
              nativeThreadRef: departing?.nativeThreadRef ?? null,
              firstRunOrdinal: departing?.firstRunOrdinal ?? latestRun?.ordinal ?? 1,
              lastRunOrdinal: latestRun?.ordinal ?? departing?.lastRunOrdinal ?? 1,
              handoffIds: [...(departing?.handoffIds ?? []), departure],
            });
            // G1b: switching BACK to a provider with a prior ProviderThread
            // resumes that thread (its nativeThreadRef resume cursor) and
            // injects a delta handoff covering only the runs that happened
            // while it was absent. Falling back to a fresh target thread + full
            // summary when there is no prior thread or no native cursor.
            const resuming = providerThreads(this.store, value.session.id).find(
              (thread) => thread.provider === targetHarness,
            );
            if (resuming) {
              // Resume: restore the provider-native thread ref so the next
              // send binds/resumes the native conversation instead of opening
              // a fresh one. The provider-boundary bind() carries the cursor
              // to the harness layer.
              const fromOrdinal = (resuming.lastRunOrdinal ?? 0) + 1;
              const missedRuns =
                latestRun && fromOrdinal <= latestRun.ordinal
                  ? latestRun.ordinal - fromOrdinal + 1
                  : 0;
              if (resuming.nativeThreadRef) {
                value = {
                  ...value,
                  session: {
                    ...value.session,
                    providerSessionId: resuming.nativeThreadRef,
                  },
                };
                this.provider(targetHarness).bind(
                  value.session.id,
                  resuming.nativeThreadRef,
                  value.session.cwd,
                );
                // Delta handoff: only the runs since this provider last
                // participated (derived from the run store, never a chain).
                if (missedRuns > 0) {
                  const summary = buildRunHandoffSummary(
                    this.store,
                    value.session.id,
                    { fromOrdinal, toOrdinal: latestRun!.ordinal },
                  );
                  const handoff = recordHandoff(this.store, {
                    sessionId: value.session.id,
                    provider: value.session.harness,
                    runOrdinal: latestRun!.ordinal,
                    summary,
                    handler: "switch-back",
                  });
                  // Link the delta into the resumed thread (coverage stays
                  // put: codex has already seen [.. before], the delta is
                  // after).
                  recordProviderThread(this.store, {
                    sessionId: value.session.id,
                    provider: targetHarness,
                    nativeThreadRef: resuming.nativeThreadRef,
                    firstRunOrdinal: resuming.firstRunOrdinal,
                    lastRunOrdinal: resuming.lastRunOrdinal,
                    handoffIds: [...resuming.handoffIds, handoff],
                  });
                }
              } else if (missedRuns > 0) {
                // Weak provider with no native resume cursor: the delta is
                // impossible, so fall back to a full summary + fresh thread.
                // The target still gets complete context through a
                // switch-back handoff covering everything it missed.
                const summary = buildRunHandoffSummary(
                  this.store,
                  value.session.id,
                );
                const handoff = recordHandoff(this.store, {
                  sessionId: value.session.id,
                  provider: value.session.harness,
                  runOrdinal: latestRun!.ordinal,
                  summary,
                  handler: "switch-back",
                });
                recordProviderThread(this.store, {
                  sessionId: value.session.id,
                  provider: targetHarness,
                  nativeThreadRef: null,
                  firstRunOrdinal: resuming.firstRunOrdinal,
                  lastRunOrdinal: resuming.lastRunOrdinal,
                  handoffIds: [...resuming.handoffIds, handoff],
                });
              }
            }
          }
          value = {
            ...value,
            session: {
              ...value.session,
              ...(switching ? { harness: command.harness } : {}),
              model: command.model,
              modelSettings: command.modelSettings,
              runtimeMode: command.runtimeMode,
            },
          };
        } else if (command.type === "draft") {
          if (
            value.status === "running" ||
            value.session.blocks.some((block) => block.draft)
          )
            throw new Error("This session cannot save another draft right now");
          const attachments = resolveAttachments(
            this.store,
            command.attachments ?? [],
          );
          value = {
            ...value,
            session: {
              ...value.session,
              title: value.session.blocks.length
                ? value.session.title
                : titleFromPrompt(
                    command.text,
                    value.session.harness,
                    attachments,
                  ),
              blocks: [
                ...value.session.blocks,
                {
                  id: command.commandId,
                  role: "user",
                  text: command.text,
                  ...(attachments.length ? { attachments } : {}),
                  draft: true,
                },
              ],
            },
          };
        } else if (command.type === "removeDraft") {
          const draft = value.session.blocks.find(
            (block) => block.id === command.draftBlockId && block.draft,
          );
          if (!draft) throw new Error("Draft not found");
          value = {
            ...value,
            session: {
              ...value.session,
              blocks: value.session.blocks.filter(
                (block) => block.id !== draft.id,
              ),
            },
          };
        } else if (command.type === "fork") {
          if (value.status === "running")
            throw new Error(
              "Wait for the current turn before forking (unstable source point)",
            );
          // S2: the fork is created lazily — a target App thread + a pending
          // ContextTransfer, with zero provider work (native fork / portable
          // context resolve on the fork's first dispatch). forkThread enforces
          // the stable-source-point policy (terminal run, idle thread, or a
          // captured checkpoint scope).
          const forkResult = forkThread(
            this.store,
            value.session.id,
            command.forkRunOrdinal,
          );
          // Replace the working session with the new fork session so the
          // shared save path below persists it and returns its id/revision.
          value = this.store.session(forkResult.sessionId);
        } else if (command.type === "rollback") {
          if (value.status === "running")
            throw new Error(
              "Wait for the current turn before rolling back",
            );
          // S4: probe the harness's rollback capability + history mode.
          // When native rollback is supported (capability flag + legacy
          // history), call the provider's native RPC, then reconcile the
          // returned provider snapshot into the durable store via
          // rollbackThread. Otherwise degrade to the host-only reconcile
          // (the existing fallback) — never silent.
          const caps = capabilitiesFor(value.session.harness);
          const policy = degradePolicy(caps, "rollback");
          const hostReconcile = () => {
            rollbackThread(
              this.store,
              value.session.id,
              command.targetRunOrdinal,
            );
          };
          // Native path (capability-supported + history probe + native RPC).
          if (policy === "supported" && provider.rollbackToRun) {
            effect = () => {
              void (async () => {
                try {
                  const historyMode = await provider
                    .historyMode?.(value.session.id)
                    .catch(() => "paginated" as const);
                  if (historyMode === "legacy") {
                    // Provider-native rewind, then the durable host reconcile.
                    await provider.rollbackToRun!(
                      value.session.id,
                      command.targetRunOrdinal,
                    );
                    hostReconcile();
                  } else {
                    // Paginated history: no native rewind; host reconcile.
                    hostReconcile();
                  }
                } catch {
                  // Provider-native rewind failed: still reconcile the host
                  // state (the provider didn't move, so the durable rollback
                  // remains the auditable record).
                  hostReconcile();
                }
              })();
            };
          } else {
            // No native RPC: host-only reconcile (the existing fallback).
            hostReconcile();
          }
        } else if (command.type === "send" || command.type === "compact") {
          if (value.status === "running")
            throw new Error("This session is already running");
          if (command.type === "compact") {
            const policy = degradePolicy(
              capabilitiesFor(value.session.harness),
              "rollback",
            );
            if (!provider.compact || policy === "unavailable")
              throw new Error(
                "Context compaction is unavailable for this provider",
              );
          }
          const draft =
            command.type === "send" && command.draftBlockId
              ? value.session.blocks.find(
                  (block) => block.id === command.draftBlockId && block.draft,
                )
              : undefined;
          if (command.type === "send" && command.draftBlockId && !draft)
            throw new Error("Draft not found");
          const plan =
            command.type === "send" && command.planBlockId
              ? value.session.blocks.find(
                  (block) =>
                    block.id === command.planBlockId && block.role === "plan",
                )
              : undefined;
          if (
            command.type === "send" &&
            command.planBlockId &&
            (!plan ||
              !plan.text.trim() ||
              plan.streaming ||
              plan.plan?.status === "building" ||
              plan.plan?.status === "built")
          )
            throw new Error("Plan is not ready to build");
          const attachments =
            command.type === "send"
              ? (draft?.attachments ??
                resolveAttachments(this.store, command.attachments ?? []))
              : [];
          const runId = uuid();
          const firstTurn =
            command.type === "send" &&
            !value.session.blocks.some((block) => !block.draft);
          // G2: the fork's first dispatch resolves its pending ContextTransfer
          // (lazy fork). Nothing provider-side happened at fork time; now the
          // portable context (a reviewable Handoff summary) is materialized
          // and the transfer is marked resolved exactly once.
          // The fork's first dispatch is its first real `send` (the fork has
          // copied source blocks, so the block-based `firstTurn` is false —
          // the pending transfer is the true marker of "first dispatch").
          if (command.type === "send")
            resolveForkOnFirstDispatch(
              this.store,
              value.session.id,
              this.provider(value.session.harness),
            );
          const placeholderTitle =
            value.session.title === "New remote session" ||
            canReplaceSessionTitle(
              value.session.title,
              value.session.harness,
              HARNESS_LABEL[value.session.harness],
            );
          const model = resolveModel(
            value.session.harness,
            value.session.model,
          );
          value = {
            ...value,
            status: "running",
            runId,
            session: {
              ...value.session,
              busy: true,
              pendingQuestion: undefined,
              title:
                firstTurn && placeholderTitle
                  ? titleFromPrompt(
                      command.text,
                      value.session.harness,
                      attachments,
                    )
                  : value.session.title,
              blocks: [
                ...value.session.blocks
                  .filter((block) => !block.draft)
                  .map((block) =>
                    block === plan
                      ? {
                          ...block,
                          plan: {
                            ...(block.plan ?? { status: "ready" as const }),
                            status: "building" as const,
                            approvedText: block.text,
                          },
                        }
                      : block,
                  ),
                {
                  id: command.commandId,
                  role: "user",
                  text: command.type === "compact" ? "/compact" : command.text,
                  ...(attachments.length ? { attachments } : {}),
                  startedAt: now(),
                  turnModel: {
                    harness: value.session.harness,
                    id: value.session.model,
                    name:
                      model.id === value.session.model
                        ? model.name
                        : value.session.model.replace(/^[^:]+:/, ""),
                  },
                },
              ],
            },
          };
          // The counted, durable Run entity: created in the same transaction
          // as the send so the run row and the session stay consistent.
          const startedAt = now();
          const runOrdinal = this.store.runs(value.session.id).length + 1;
          this.store.upsertRun(value.session.id, {
            id: runId,
            sessionId: value.session.id,
            ordinal: runOrdinal,
            status: "running",
            startedAt,
            endedAt: null,
            attempts: 1,
            message: command.type === "compact" ? null : command.text,
          });
          // G1a: extend the participant provider's durable thread coverage to
          // this new run. The covered range derives from the durable run store
          // (a delta for a later switch-back is derivable, not stored as a
          // chain). If no thread exists yet for this provider (e.g. a weak
          // provider that never reports a native ref), create one with the
          // current run as its covered range start.
          const covering = providerThreads(this.store, value.session.id).find(
            (thread) => thread.provider === value.session.harness,
          );
          recordProviderThread(this.store, {
            sessionId: value.session.id,
            provider: value.session.harness,
            nativeThreadRef: covering?.nativeThreadRef ?? null,
            firstRunOrdinal: covering?.firstRunOrdinal ?? runOrdinal,
            lastRunOrdinal: Math.max(covering?.lastRunOrdinal ?? 0, runOrdinal),
            handoffIds: covering?.handoffIds ?? [],
          });
          // Durable effect outbox: the turn.start effect is enqueued BEFORE
          // the provider is dispatched, so a restart can resume it.
          enqueueProviderEffect(this.store, {
            sessionId: value.session.id,
            runId,
            kind: "turn.start",
            payload:
              command.type === "compact"
                ? { compact: true }
                : { text: command.text },
          });
          // The root execution node for this run, created alongside the run.
          this.store.upsertNode(
            freshRootNode(value.session.id, runId),
          );
          // S3: a root checkpoint scope is auto-created at run start with a
          // pre-run baseline, so rollback and checkpoint-aware forks have a
          // stable boundary. Captured automatically at run terminal below.
          const rootScopeId = createCheckpointScope(this.store, {
            sessionId: value.session.id,
            runOrdinal,
            advancesAppRunCount: true,
          });
          ensurePreRunBaseline(
            this.store,
            rootScopeId,
            `Baseline before run ${runOrdinal}.`,
          );
          effect = (saved) => {
            this.run(
              saved,
              command.type === "compact" ? null : command.text,
              command.type === "send" ? command.intent : undefined,
              attachments,
            );
            if (firstTurn && command.type === "send") {
              this.generateFirstTurnNames(
                saved,
                command.text,
                placeholderTitle,
              );
            }
          };
        } else {
          if (value.runId !== command.runId || value.status !== "running")
            throw new Error(
              "This request belongs to a finished or replaced turn",
            );
          if (command.type === "cancel") {
            effect = () => {
              const active = this.running.get(command.sessionId);
              if (active) active.cancelled = true;
              void provider
                .cancel(command.sessionId)
                .catch(() => provider.stop(command.sessionId));
            };
          } else if (command.type === "approve") {
            const pending = value.session.blocks.some(
              (block) =>
                block.approval?.requestId === command.requestId &&
                !block.approval.decided,
            );
            if (!pending) throw new Error("Approval is already resolved");
            value = {
              ...value,
              session: applyHarnessEvent(value.session, {
                type: "approval.resolved",
                requestId: command.requestId,
                decision: command.decision,
              }),
            };
            effect = () =>
              provider.approve(
                command.sessionId,
                command.requestId,
                command.decision,
              );
          } else {
            if (value.session.pendingQuestion?.requestId !== command.requestId)
              throw new Error("Question is already resolved");
            value = {
              ...value,
              session: { ...value.session, pendingQuestion: undefined },
            };
            effect = () =>
              provider.answer(
                command.sessionId,
                command.requestId,
                command.reply,
              );
          }
        }
      }
      const saved = this.store.save(
        {
          ...value,
          revision: value.revision + 1,
          // Creation already initialized both timestamps from the same clock read.
          updatedAt: command.type === "create" ? value.updatedAt : now(),
        },
        { type: "command", command },
      );
      const result = {
        commandId: command.commandId,
        sessionId: saved.session.id,
        revision: saved.revision,
      };
      this.store.recordReceipt(signature, result);
      return { receipt: result, saved };
    });
    const live = this.live.get(saved.session.id);
    if (live) live.value = saved;
    // A receipt means durable host acceptance, not provider completion.
    effect?.(saved);
    return receipt;
  }

  private generateFirstTurnNames(
    value: HostSession,
    message: string,
    generateTitle: boolean,
  ): void {
    const provider = this.provider(value.session.harness);
    const { id, cwd, harness, title } = value.session;
    if (generateTitle && provider.generateTitle) {
      void provider
        .generateTitle({ sessionId: id, cwd, message })
        .then((generated) => {
          if (!generated) return;
          this.flush(id);
          const current = this.store.session(id);
          if (current.session.title !== title) return;
          const saved = this.save(
            {
              ...current,
              session: {
                ...current.session,
                title: formatSessionTitle(harness, generated.title),
              },
            },
            { type: "session.generatedTitle" },
          );
          const live = this.live.get(id);
          if (live) live.value = saved;
        })
        .catch((error) =>
          console.debug("[monocode] remote session title", error),
        );
    }
    const temporary = value.autoWorktreeBranch;
    if (temporary && provider.generateBranchName) {
      void provider
        .generateBranchName(cwd, message)
        .then(async (fragment) => {
          const branch = fragment ? namedWorktreeBranch(fragment) : null;
          if (!branch) return;
          // A title/branch request may finish after the conversation was deleted.
          const currentBeforeRename = this.store.session(id);
          if (currentBeforeRename.autoWorktreeBranch !== temporary) return;
          const project = this.store.project(value.projectId);
          await renameHostWorktreeBranch(project.cwd, cwd, temporary, branch,
            () => this.store.session(id).autoWorktreeBranch === temporary);
          this.flush(id);
          const current = this.store.session(id);
          const saved = this.save(
            {
              ...current,
              autoWorktreeBranch: undefined,
              session: { ...current.session, branch },
            },
            { type: "session.generatedBranch", branch },
          );
          const live = this.live.get(id);
          if (live) live.value = saved;
        })
        .catch((error) =>
          console.debug("[monocode] remote worktree branch", error),
        );
    }
  }

  private run(
    value: HostSession,
    prompt: string | null,
    intent?: "default" | "plan" | "build",
    attachments: Session["blocks"][number]["attachments"] = [],
  ): void {
    const { session, runId } = value;
    const activeRunId = runId!;
    const provider = this.provider(session.harness);
    const active = { runId: runId!, done: Promise.resolve(), cancelled: false, persistenceFailed: false };
    // The effect is dispatched now: flip it to in-flight in the durable outbox.
    markEffectInFlight(this.store, session.id, activeRunId, { attempts: 1 });
    this.running.set(session.id, active);
    this.live.set(session.id, {
      value,
      events: [],
      runLifecycle: freshRunLifecycle(prompt),
    });
    active.done = Promise.resolve()
      .then(async () => {
        let error: string | undefined;
        try {
          if (!this.closing && !active.cancelled) {
            const input: HarnessSessionInput = {
              sessionId: session.id,
              cwd: session.cwd,
              model: session.model,
              modelSettings: session.modelSettings,
              runtimeMode: session.runtimeMode,
              intent,
              onEvent: (event) => this.event(session.id, runId!, event),
            };
            if (prompt === null) await provider.compact!(input);
            else
              await provider.send({
                ...input,
                text: prompt,
                attachments: attachments?.map((file) =>
                  isVisionImage(file.mimeType) &&
                  file.path &&
                  file.size <= 20 * 1024 * 1024
                    ? {
                        ...file,
                        data: readFileSync(file.path).toString("base64"),
                      }
                    : file,
                ),
              });
          }
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        }
        // Keep the session running until the old process has stopped. Otherwise
        // a follow-up can race cleanup and have its newly spawned child killed.
        await provider.stop(session.id);
        this.flush(session.id);
        const finalLifecycle = this.live.get(session.id)?.runLifecycle;
        this.live.delete(session.id);
        const latest = this.store.session(session.id);
        if (latest.runId === runId) {
          // The turn.start effect completed: retire it from the outbox.
          markEffectDone(this.store, session.id, activeRunId);
          const message = this.closing
            ? "Host stopped. This turn was interrupted."
            : active.persistenceFailed
              ? "Session storage failed during this turn. Inspect its work before continuing."
              : active.cancelled
              ? "Stopped by you."
              : error;
          // Finalize the durable run row: interrupted on error/cancel/host stop,
          // otherwise completed only if the normalizer already saw a terminal
          // event (message.completed). A run that ended abruptly mid-stream is
          // interrupted, never silently completed.
          const run = this.store.runs(session.id).find((r) => r.id === runId);
          if (run) {
            this.store.upsertRun(session.id, {
              ...run,
              status:
                finalLifecycle?.status === "completed"
                  ? "completed"
                  : "interrupted",
              endedAt: now(),
            });
          }
          // Finalize the root node alongside the run: completed only when the
          // run's lifecycle reached completed, otherwise interrupted. Child
          // nodes are left as-is (they complete independently).
          const rootNode = this.store
            .nodesForRun(session.id, activeRunId)
            .find((node) => node.parentId === null);
          if (rootNode && rootNode.status === "running") {
            this.store.upsertNode({
              ...rootNode,
              status:
                finalLifecycle?.status === "completed"
                  ? ("completed" as const)
                  : ("interrupted" as const),
              endedAt: now(),
            });
          }
          // S3: auto-capture the run's root checkpoint scope at terminal
          // (completed or interrupted). Idempotent: a scope already captured
          // or rolled back is left untouched. The scope is found by ordinal
          // (the durable run row owns the ordinal; the scope was created at
          // run start with the same ordinal + advancesAppRunCount=true).
          const terminalRun = this.store.runs(session.id).find(
            (r) => r.id === runId,
          );
          const rootScope = terminalRun
            ? checkpointScopes(this.store, session.id).find(
                (scope) =>
                  scope.runOrdinal === terminalRun.ordinal &&
                  scope.advancesAppRunCount,
              )
            : undefined;
          if (rootScope) {
            captureCheckpoint(
              this.store,
              rootScope.id,
              `Captured after run ${terminalRun!.ordinal} (${terminalRun!.status}).`,
            );
          }
          this.save(
            this.settled(
              latest,
              this.closing || active.persistenceFailed ? "interrupted" : "idle",
              message,
            ),
            { type: "settled", error, cancelled: active.cancelled },
          );
        }
        this.running.delete(session.id);
        // stop/forget releases callbacks and native resources; bind only retained
        // provider conversation identity for an explicit future follow-up.
        const persisted = this.store.session(session.id).session;
        if (persisted.providerSessionId)
          provider.bind(session.id, persisted.providerSessionId, persisted.cwd);
      })
      .catch((error) => {
        clearTimeout(this.live.get(session.id)?.timer);
        console.error(
          "Session persistence failed; stopping its provider:",
          error instanceof Error ? error.message : "unknown error",
        );
        void provider.stop(session.id);
        this.retrySettlement(session.id, runId!, provider);
      });
  }

  private event(id: string, runId: string, event: HarnessEvent): void {
    const live = this.live.get(id);
    if (!live || live.value.runId !== runId || live.value.status !== "running")
      return;
    const session = applyHarnessEvent(live.value.session, event);
    // App ids are primary; provider ids are refs. When the provider announces
    // its native conversation id, record it as a durable correlation binding
    // scoped to the app session id — never as primary identity.
    if (event.type === "session.providerBound") {
      // G6: the correlation strategy follows the provider's identity tier
      // (strong → native_exact, weak → native_scoped, none → fingerprint).
      // Strong providers keep the native ref as-is; weak/none providers get a
      // scoped/fingerprint key so correlation still works when native ids are
      // unreliable without overclaiming.
      const identity = capabilitiesFor(session.harness).identity;
      const strategy = pickCorrelationStrategy(identity);
      bindProviderRef(this.store, {
        appEntityKind: "session",
        appEntityId: id,
        provider: session.harness,
        nativeRef: event.providerSessionId,
        correlation: strategy,
        nativeKind: "conversation",
        scope: identity === "strong" ? undefined : `provider:${session.harness}`,
      });
      // G1a: the durable ProviderThread records the resume cursor (the
      // provider-native thread ref) as evidence, plus the coverage of the runs
      // this provider has seen (the app run ordinals). The first run of this
      // provider participates in the covered range from the current run.
      const runs = this.store.runs(id);
      const currentRun = runs.find((r) => r.id === runId) ?? runs.at(-1);
      if (currentRun) {
        const existing = providerThreads(this.store, id).find(
          (t) => t.provider === session.harness,
        );
        recordProviderThread(this.store, {
          sessionId: id,
          provider: session.harness,
          nativeThreadRef: event.providerSessionId,
          firstRunOrdinal:
            existing?.firstRunOrdinal ?? currentRun.ordinal,
          lastRunOrdinal: Math.max(
            existing?.lastRunOrdinal ?? 0,
            currentRun.ordinal,
          ),
          handoffIds: existing?.handoffIds ?? [],
        });
      }
    }
    // Content-agnostic normalizer: fold the event into the run lifecycle state
    // (status transition only; content stays in blocks) and persist the run row.
    const lifecycle = normalizeRunEvent(live.runLifecycle, event);
    if (lifecycle !== live.runLifecycle) {
      const run = this.store.runs(id).find((r) => r.id === runId);
      if (run) {
        this.store.upsertRun(id, {
          ...run,
          status: lifecycle.status,
          endedAt: lifecycle.status === "running" ? null : Date.now(),
          message: lifecycle.message ?? run.message,
        });
      }
      live.runLifecycle = lifecycle;
    }
    // Execution graph: fold the event into the node tree. The reduction
    // returns rootCompleted=true ONLY when the root node completed, which is
    // what drives the run to terminal (root-only completion).
    const reduction = applyNodeEvent(
      this.store.nodesForRun(id, runId),
      event,
    );
    if (reduction.nodes.length) {
      for (const node of reduction.nodes) this.store.upsertNode(node);
    }
    if (session === live.value.session) return;
    live.value = { ...live.value, session };
    live.events.push(event);
    if (!BATCHED.has(event.type))
      this.scheduledFlush(id, this.provider(session.harness));
    else
      live.timer ??= setTimeout(
        () => this.scheduledFlush(id, this.provider(session.harness)),
        FLUSH_MS,
      );
  }

  private settled(
    value: HostSession,
    status: "idle" | "interrupted",
    message?: string,
    endedAt = Date.now(),
  ): HostSession {
    const stopped = stopStreaming(value.session, endedAt);
    const session = {
      ...stopped,
      blocks: stopped.blocks.map((block) =>
        block.role === "plan" && block.plan?.status === "building"
          ? {
              ...block,
              plan: {
                ...block.plan,
                status:
                  status === "idle" && !message
                    ? ("built" as const)
                    : ("ready" as const),
              },
            }
          : block,
      ),
    };
    if (message)
      session.blocks.push({
        id: randomUUID(),
        role: "system",
        text: message,
        streaming: false,
      });
    return { ...value, status, session };
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.all(
      [...this.running.keys()].map((id) =>
        this.provider(this.store.session(id).session.harness).stop(id),
      ),
    );
    await Promise.all([...this.running.values()].map((active) => active.done));
  }
}
