// T2 (issue #3): content-agnostic run normalizer.
//
// A Run is the counted user-visible turn on a session. The normalizer turns
// raw harness events into lifecycle transitions (run started/terminal, request
// resolved) WITHOUT touching message content — content stays in Blocks. This
// is the pure, replay-deterministic piece that the store persists.
import type { HarnessEvent } from "../src/integrations/harness/core/types";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled";

/** The durable, app-owned Run entity (a user-visible counted turn). */
export type Run = {
  id: string;
  sessionId: string;
  ordinal: number;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  /** User-visible prompt text; null for compaction turns. */
  message: string | null;
};

/** The lifecycle state the normalizer tracks (not stored per event). */
export type RunLifecycle = {
  status: RunStatus;
  message?: string;
};

const TERMINAL_EVENTS: Partial<Record<HarnessEvent["type"], RunStatus>> = {
  "message.completed": "completed",
  "session.error": "interrupted",
  "session.ended": "interrupted",
};

/**
 * Content-agnostic normalizer: map one raw harness event to the run lifecycle
 * transition it implies. Returns the same lifecycle unchanged for events that
 * are not lifecycle transitions (content stays in blocks).
 */
export function normalizeRunEvent(
  lifecycle: RunLifecycle,
  event: HarnessEvent,
): RunLifecycle {
  const terminal = TERMINAL_EVENTS[event.type as HarnessEvent["type"]];
  if (!terminal) return lifecycle;
  if (event.type === "session.error")
    return { status: terminal, message: event.message };
  return { ...lifecycle, status: terminal };
}

/** Fresh lifecycle state for a new run. */
export function freshRunLifecycle(message: string | null): RunLifecycle {
  return { status: "running", message: message ?? undefined };
}