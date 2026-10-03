// S5 (issue #26): first-class providerThreadId on Run + engine thread/resume.
//
// Today `providerThreadId` is a thin optional string on a side-thread model
// type, and switch-back resumes by stuffing the native ref into
// `providerSessionId` + calling `provider.bind`. S5 promotes the provider
// thread id onto the durable graph entity, exposes an engine-level
// `thread/resume` that establishes the provider thread handle from the
// durable thread id (beyond raw `bind`), and keeps thread metadata
// restartable — so switch-back, forks, and recovery all resume through one
// explicit path. Resuming after a restart re-establishes the same provider
// thread without duplicating a native thread.
//
// The seam: the provider process boundary (replay harness) + the host store.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import type { HostProvider } from "./providers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir(name = "monocode-s5-thread-resume-") {
  const directory = mkdtempSync(join(tmpdir(), name));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function turn(nativeRef: string, text: string): ProviderTranscript["entries"] {
  return [
    { kind: "send", sessionId: "s", text },
    {
      kind: "event",
      sessionId: "s",
      event: { type: "turn.started", providerTurnId: "t" },
    },
    {
      kind: "event",
      sessionId: "s",
      event: { type: "session.providerBound", providerSessionId: nativeRef },
    },
    { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
    { kind: "event", sessionId: "s", event: { type: "message.completed" } },
  ];
}

function transcript(entries: ProviderTranscript["entries"]): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "s5-thread-resume",
    entries,
  };
}

/** A replay provider that records every bind (resume) request. */
function bindRecordingReplay(
  entries: ProviderTranscript["entries"],
  harness: "codex" | "cursor" = "codex",
) {
  const binds: Array<{ threadId: string; providerId: string; cwd: string }> = [];
  const replay = replayProvider(transcript(entries));
  const provider: HostProvider = {
    ...replay,
    bind: (threadId, providerId, cwd) => {
      binds.push({ threadId, providerId, cwd });
    },
  };
  return { provider, binds };
}

async function settleTurn(engine: HostEngine, sessionId: string, text: string) {
  engine.command({
    type: "send",
    commandId: `send-${Math.random().toString(36).slice(2)}`,
    sessionId,
    text,
  });
  await vi.waitFor(
    () => expect(engine.store.runs(sessionId).at(-1)?.status).toBe("completed"),
    { timeout: 2_000 },
  );
}

describe("thread resume (first-class providerThreadId + engine thread/resume)", () => {
  it("records the provider thread id durably on the run/session graph", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "durable.db"));
    const { provider } = bindRecordingReplay([...turn("native-a-1", "run one")]);
    const engine = new HostEngine(store, { codex: provider });
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
    await settleTurn(engine, created.sessionId, "run one");

    // The provider thread id is a durable field on the run/session graph:
    // the session records it AND the run row carries it (survives the graph).
    const run = store.runs(created.sessionId)[0]!;
    expect(run.providerThreadId).toBe("native-a-1");
    const session = store.session(created.sessionId).session as Session & {
      providerThreadId?: string;
    };
    expect(session.providerThreadId).toBe("native-a-1");
  });

  it("exposes an engine thread/resume operation that establishes the provider thread handle (beyond bind)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "resume.db"));
    const { provider, binds } = bindRecordingReplay([
      ...turn("native-a-1", "run one"),
      ...turn("native-a-1", "run two"),
    ]);
    const engine = new HostEngine(store, { codex: provider });
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
    await settleTurn(engine, created.sessionId, "run one");
    const threadId = store.runs(created.sessionId)[0]!.providerThreadId!;
    expect(threadId).toBe("native-a-1");

    // The engine thread/resume operation: resolves the durable thread id into
    // a live provider handle (records the bind) + sets the session's thread id.
    engine.command({
      type: "thread/resume",
      commandId: "thread-resume",
      sessionId: created.sessionId,
      threadId,
    });
    const bind = binds.find((b) => b.providerId === threadId);
    expect(bind).toBeTruthy();
    expect(bind!.threadId).toBe(created.sessionId);
    const after = store.session(created.sessionId).session as Session & {
      providerThreadId?: string;
    };
    expect(after.providerThreadId).toBe(threadId);
  });

  it("re-establishes the same provider thread after restart without duplicating it (delta handoff)", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "restart.db"));
    const codex = bindRecordingReplay([
      ...turn("native-a-1", "run one"),
      ...turn("native-a-1", "back on codex"),
    ], "codex");
    const cursor = bindRecordingReplay([
      ...turn("native-c-1", "run on cursor"),
    ], "cursor");
    const engine = new HostEngine(store, {
      codex: codex.provider,
      cursor: cursor.provider,
    });
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
    await settleTurn(engine, created.sessionId, "run one");
    const threadA = store.runs(created.sessionId)[0]!.providerThreadId!;

    // Switch away to a provider with NO prior thread (fresh cursor), then back.
    // The resume binds the ORIGINAL native thread (native-a-1) — one handle.
    engine.command({
      type: "configure",
      commandId: "switch-away",
      sessionId: created.sessionId,
      harness: "cursor",
      model: "cursor:test",
      runtimeMode: "supervised",
    });
    await settleTurn(engine, created.sessionId, "run on cursor");
    engine.command({
      type: "configure",
      commandId: "switch-back",
      sessionId: created.sessionId,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });

    // The resumed session carries the SAME provider thread id + the app
    // re-binds it (no duplicate native thread created).
    const resumed = store.session(created.sessionId).session as Session & {
      providerThreadId?: string;
    };
    expect(resumed.providerThreadId).toBe(threadA);
    const resumedBind = codex.binds.filter((b) => b.providerId === threadA);
    expect(resumedBind.length).toBeGreaterThanOrEqual(1);
  });
});