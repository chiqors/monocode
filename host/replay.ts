// T1 (issue #2): replay harness at the provider boundary.
//
// This module owns the replayed-provider boundary: it gives the tests a way to
// RECORD a provider's outbound calls into a durable transcript and REPLAY that
// transcript through the real engine, replacing only the provider process
// boundary. It is the seam every later ticket's lifecycle tests run against.
//
// The replayed provider delivers recorded provider events into the engine's
// real inbound channel (`input.onEvent`), so a replayed conversation actually
// settles the engine — no live provider process is ever contacted.
import type { HarnessId } from "../src/features/sessions/model/session";
import type { HarnessEvent } from "../src/integrations/harness/core/types";
import type { ApprovalDecision } from "../src/integrations/harness/core/types";
import type { UserQuestionReply } from "../src/features/sessions/model/userQuestion";
import type { HostProvider } from "./providers";

/** One provider-boundary call, recorded faithfully. */
export type ProviderReplayEntry =
  | { kind: "send"; sessionId: string; text: string; attachments?: unknown }
  | { kind: "cancel"; sessionId: string }
  | { kind: "stop"; sessionId: string }
  | { kind: "approve"; sessionId: string; request: number; decision: ApprovalDecision }
  | { kind: "answer"; sessionId: string; request: number; reply: UserQuestionReply }
  | { kind: "event"; sessionId: string; event: HarnessEvent };

/** A durable, self-contained provider transcript. */
export type ProviderTranscript = {
  format: "monocode-replay-v1";
  provider: HarnessId;
  scenario: string;
  entries: ProviderReplayEntry[];
};

/** Parse an untrusted persisted value into a valid transcript, or throw. */
export function parseTranscript(value: unknown): ProviderTranscript {
  const transcript = value as ProviderTranscript;
  if (
    !transcript ||
    typeof transcript !== "object" ||
    transcript.format !== "monocode-replay-v1" ||
    typeof transcript.provider !== "string" ||
    typeof transcript.scenario !== "string" ||
    !Array.isArray(transcript.entries)
  )
    throw new Error("Invalid provider transcript");
  return transcript;
}

/**
 * Record: wrap a live provider so every call it receives is appended to the
 * returned transcript's entries, and every event it emits is appended as an
 * `event` entry. Returns the wrapped provider (which the caller drives) and
 * the durable transcript (which accumulates the captured calls). This is the
 * capture half of the seam with no behavior change to the provider.
 */
export function recordProviderIo(
  provider: HostProvider,
  meta: { provider: HarnessId; scenario?: string },
): {
  provider: HostProvider;
  transcript: ProviderTranscript;
} {
  const transcript: ProviderTranscript = {
    format: "monocode-replay-v1",
    provider: meta.provider,
    scenario: meta.scenario ?? "recorded",
    entries: [],
  };
  const wrapped: HostProvider = {
    send: async (input) => {
      transcript.entries.push({
        kind: "send",
        sessionId: input.sessionId,
        text: input.text,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      // Mirror every inbound provider event into the transcript so a recorded
      // conversation carries its own lifecycle evidence.
      const original = input.onEvent;
      input.onEvent = (event) => {
        transcript.entries.push({ kind: "event", sessionId: input.sessionId, event });
        original(event);
      };
      await provider.send({ ...input, onEvent: input.onEvent });
    },
    cancel: async (id) => {
      transcript.entries.push({ kind: "cancel", sessionId: id });
      await provider.cancel(id);
    },
    stop: async (id) => {
      transcript.entries.push({ kind: "stop", sessionId: id });
      await provider.stop(id);
    },
    approve: async (id, request, decision) => {
      transcript.entries.push({ kind: "approve", sessionId: id, request, decision });
      await provider.approve(id, request, decision);
    },
    answer: async (id, request, reply) => {
      transcript.entries.push({ kind: "answer", sessionId: id, request, reply });
      await provider.answer(id, request, reply);
    },
    bind: (id, providerId, cwd) => {
      provider.bind(id, providerId, cwd);
    },
  };
  return { provider: wrapped, transcript };
}

/**
 * Replay: a HostProvider that replays a transcript's recorded calls and events.
 * Every `send` delivers the recorded events into the engine via `onEvent` in
 * order, so the engine settles exactly as the recorded conversation did —
 * deterministically, with no provider process.
 */
export function replayProvider(
  transcript: ProviderTranscript,
): HostProvider & { calls: () => ProviderReplayEntry[] } {
  const calls: ProviderReplayEntry[] = [];
  const sends = transcript.entries.filter((e) => e.kind === "send");
  let cursor = 0;
  const provider: HostProvider & { calls: () => ProviderReplayEntry[] } = {
    send: async (input) => {
      // Consume the next recorded send and replay only the events that follow
      // it (up to the next recorded send). This keeps multi-turn transcripts
      // faithful: each engine send replays exactly one recorded conversation.
      const next = sends[cursor];
      if (!next) return;
      cursor += 1;
      calls.push({ ...next });
      const start = transcript.entries.indexOf(next) + 1;
      for (let index = start; index < transcript.entries.length; index++) {
        const entry = transcript.entries[index];
        if (entry.kind === "send") break;
        if (entry.kind === "event") await input.onEvent(entry.event);
      }
    },
    cancel: async (_id) => {
      for (const entry of transcript.entries)
        if (entry.kind === "cancel") calls.push({ ...entry });
    },
    stop: async (_id) => {
      for (const entry of transcript.entries)
        if (entry.kind === "stop") calls.push({ ...entry });
    },
    approve: async (_id, _request, _decision) => {
      for (const entry of transcript.entries)
        if (entry.kind === "approve") calls.push({ ...entry });
    },
    answer: async (_id, _request, _reply) => {
      for (const entry of transcript.entries)
        if (entry.kind === "answer") calls.push({ ...entry });
    },
    bind: (_id, _providerId, _cwd) => undefined,
    calls: () => calls,
  };
  return provider;
}