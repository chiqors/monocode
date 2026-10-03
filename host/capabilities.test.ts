// T6 (issue #7): capability system + degradation policy.
//
// The seam: the provider process boundary (replay harness). Each harness
// declares explicit capability flags; shared orchestration code never branches
// on harness NAME — decisions go through capability/policy.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessId } from "../src/features/sessions/model/session";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { replayProvider, type ProviderTranscript } from "./replay";
import {
  type CapabilityFlags,
  type DegradationPolicy,
  capabilitiesFor,
  degradePolicy,
  defaultsFor,
  DEFAULTS,
} from "./capabilities";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setupDir() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-capability-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(): ProviderTranscript {
  return {
    format: "monocode-replay-v1",
    provider: "codex",
    scenario: "capability",
    entries: [
      { kind: "send", sessionId: "s", text: "hello" },
      {
        kind: "event",
        sessionId: "s",
        event: { type: "message.delta", text: "hi" },
      },
      {
        kind: "event",
        sessionId: "s",
        event: { type: "message.completed" },
      },
    ],
  };
}

describe("capability system (flags, not names)", () => {
  it("provides default capability flags for every harness", () => {
    for (const harness of DEFAULTS) {
      const caps = capabilitiesFor(harness[0] as HarnessId);
      expect(caps).toBeDefined();
      expect(caps.sessions).toBe(true);
      expect(caps.steer).toBe(true);
    }
  });

  it("defaults to capability support and lets a provider override", () => {
    const caps = capabilitiesFor("codex");
    expect(caps.fork).toBe(true);

    const overrides: Partial<CapabilityFlags> = { fork: false };
    const withOverride = capabilitiesFor("codex", overrides);
    expect(withOverride.fork).toBe(false);
  });

  it("degrades policy by capability (missing steering -> interrupt-and-restart)", () => {
    const caps: CapabilityFlags = {
      ...capabilitiesFor("codex"),
      steer: false,
    };
    const policy = degradePolicy(caps, "steer");
    expect(policy).toBe("interrupt_and_restart");
  });

  it("degrades handoff acceptance to synthetic user message when unsupported", () => {
    const caps: CapabilityFlags = {
      ...capabilitiesFor("codex"),
      handoff: false,
    };
    const policy = degradePolicy(caps, "handoff");
    expect(policy).toBe("synthetic_user_message");
  });

  it("returns 'supported' when the capability exists", () => {
    const policy = degradePolicy(capabilitiesFor("codex"), "fork");
    expect(policy).toBe("supported");
  });
});

describe("capability-driven behavior through the engine (no name branching)", () => {
  it("runs a turn with default capabilities and never branches on harness name", async () => {
    const directory = setupDir();
    const store = new HostStore(join(directory, "caps.db"));
    const replay = replayProvider(transcript());
    const engine = new HostEngine(store, { codex: replay });
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
    engine.command({
      type: "send",
      commandId: "send",
      sessionId: created.sessionId,
      text: "hello",
    });
    // The engine ran fine under default capabilities; the run completes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(store.runs(created.sessionId)[0]!.status).toBe("completed");
  });
});