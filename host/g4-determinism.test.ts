// G4 (issue #21): deterministic clock/id layer.
//
// The host reads time through a testable clock and allocates ids through a
// testable allocator (the Effect TestClock/Random analogue) instead of direct
// Date.now()/crypto.randomUUID() in the deterministic core (normalizer, node
// reducer, store) + the G-series host modules. Production still uses the real
// clock/id; tests inject the deterministic layer with no behavior change, so
// replaying the same transcript twice produces IDENTICAL durable state without
// real timers or waits.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import {
  now,
  uuid,
  setClock,
  setIdAllocator,
  resetDeterminism,
} from "./determinism";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  resetDeterminism();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-g4-determinism-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "g4",
    entries: [
      { kind: "send", sessionId: "s", text: "hello" },
      {
        kind: "event",
        sessionId: "s",
        event: { type: "session.providerBound", providerSessionId: "native-1" },
      },
      { kind: "event", sessionId: "s", event: { type: "message.delta", text: "hi" } },
      { kind: "event", sessionId: "s", event: { type: "message.completed" } },
    ],
  };
}

/** Deterministic clock: a monotonic counter starting at a fixed epoch. */
function fixedClock() {
  let t = 1_700_000_000_000;
  setClock(() => (t += 10));
  return () => t;
}

/** Deterministic id allocator: a monotonic 'id-0, id-1, ...' sequence. */
function fixedIds() {
  let i = 0;
  setIdAllocator(() => `id-${i++}`);
  return () => i;
}

describe("determinism seam (clock/id providers)", () => {
  it("defaults to the real clock/uuid in production", () => {
    // With no injection, now() tracks real time and uuid() is a real UUID.
    const t0 = now();
    expect(t0).toBeGreaterThan(1_650_000_000_000);
    const u = uuid();
    expect(u).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("injects a fixed clock and id allocator, then resets", () => {
    fixedClock();
    const a = now();
    const b = now();
    expect(b - a).toBe(10);

    fixedIds();
    expect(uuid()).toBe("id-0");
    expect(uuid()).toBe("id-1");

    // resetDeterminism restores the real providers.
    resetDeterminism();
    expect(now()).toBeLessThanOrEqual(Date.now());
    expect(uuid()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("replay determinism (no real waits)", () => {
  it("replays the same transcript twice with identical durable state", async () => {
    const directory = setupDir();
    // Deterministic time + ids for the WHOLE replay (before addProject so the
    // project id + environment id are also deterministic).
    fixedClock();
    fixedIds();
    const storeA = new HostStore(join(directory, "a.db"));
    const replayA = replayProvider(transcript());
    const engineA = new HostEngine(storeA, { codex: replayA });
    const projectA = storeA.addProject(directory, "Test");

    const createdA = engineA.command({
      type: "create",
      commandId: "create",
      projectId: projectA.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engineA.command({
      type: "send",
      commandId: "send-1",
      sessionId: createdA.sessionId,
      text: "hello",
    });
    await vi.waitFor(
      () => expect(storeA.runs(createdA.sessionId)[0]?.status).toBe("completed"),
      { timeout: 2_000 },
    );

    // Snapshot the durable state.
    const stateA = {
      projectId: projectA.id,
      sessionId: createdA.sessionId,
      environmentId: storeA.environmentId,
      runs: storeA.runs(createdA.sessionId).map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
      nodes: storeA.nodesForRun(createdA.sessionId, storeA.runs(createdA.sessionId)[0]!.id).map(
        (n) => ({ id: n.id, kind: n.kind, status: n.status, startedAt: n.startedAt }),
      ),
      sessionUpdatedAt: storeA.session(createdA.sessionId).updatedAt,
    };

    // Replay the SAME transcript into a fresh store (same deterministic clock
    // and ids), no waits.
    fixedClock();
    fixedIds();
    const storeB = new HostStore(join(directory, "b.db"));
    const replayB = replayProvider(transcript());
    const engineB = new HostEngine(storeB, { codex: replayB });
    const projectB = storeB.addProject(directory, "Test");

    const createdB = engineB.command({
      type: "create",
      commandId: "create",
      projectId: projectB.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engineB.command({
      type: "send",
      commandId: "send-1",
      sessionId: createdB.sessionId,
      text: "hello",
    });
    await vi.waitFor(
      () => expect(storeB.runs(createdB.sessionId)[0]?.status).toBe("completed"),
      { timeout: 2_000 },
    );

    // The durable state is IDENTICAL (ids, timestamps, nodes, session stamp).
    const stateB = {
      projectId: projectB.id,
      sessionId: createdB.sessionId,
      environmentId: storeB.environmentId,
      runs: storeB.runs(createdB.sessionId).map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
      nodes: storeB.nodesForRun(createdB.sessionId, storeB.runs(createdB.sessionId)[0]!.id).map(
        (n) => ({ id: n.id, kind: n.kind, status: n.status, startedAt: n.startedAt }),
      ),
      sessionUpdatedAt: storeB.session(createdB.sessionId).updatedAt,
    };

    expect(stateB).toEqual(stateA);
  });
});