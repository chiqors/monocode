# MonoCode

MonoCode is a desktop app for running coding agents. It drives existing agent
CLIs ("harnesses") on the user's machine from a tabbed composer UI.

## Language

**Session**:
A tab in the composer. One user-visible conversation backed by one harness
provider. Owns the message blocks and per-session state persisted by the host.
_Avoid_: Thread, conversation (as synonyms)

**Run**:
One user-visible agent turn. Identified by a `runId` in the host engine; a
session's live turn is keyed by its run. The atomic unit of "agent working".
_Avoid_: Turn (ambiguous with provider-native turns)

**Run attempt**:
One provider execution attempt under a run. Most runs have exactly one; a
steering restart or provider recovery may add another under the same run.
_Avoid_: Retry (loses the "same run, different attempt" meaning)

**App thread**:
The canonical user-visible conversation, stable across runs and providers.
MonoCode's tab (Session) is the current manifestation; the thread is the
identity that survives provider switches.
_Avoid_: Conversation (ambiguous with provider transcripts)

**Execution node**:
A unit of provider/runtime work inside a run — a root turn, a tool call, an
approval, a worker. Only the root node's completion completes the run.
_Avoid_: Task (overloaded with lead/worker tasks), item

**Harness**:
A provider-native agent CLI that MonoCode drives (claude, codex, cursor, grok,
opencode, pi, omp, fx, hermes, antigravity).
_Avoid_: Provider (overloaded: means both the CLI and the cloud service)

**Lead**:
The single orchestration session that plans a task and owns workers. One lead
run, one planning pass, a proposed task list.
_Avoid_: Orchestrator (means the whole feature), manager

**Worker**:
A session spawned by a lead to execute one planned task in an isolated
checkout, with its results integrated back into the lead workspace.
_Avoid_: Sub-agent (provider-native concept, different lifecycle), child

**Scope**:
A set of files a worker is responsible for, compared across checkouts to
schedule non-overlapping work and detect violations.
_Avoid_: File list, ownership

**Workspace**:
The checkout a run executes in: the main checkout or a worktree with a branch.
Identity includes the project cwd and checkout cwd.

**Handoff**:
The act of continuing a conversation across a provider boundary: the composer
records `pendingSwitch` and the handoff runs on the next send. Covers provider
switches, forks, and worker delegation, all through one auditable artifact.
_Avoid_: Context transfer (t3code term; deliberately not adopted), switch,
migration

**Handoff summary**:
The materialized context artifact a target provider receives — a delta of the
runs that happened while it was absent, or a full thread summary when the delta
is impossible. Attached per-run and consumed at dispatch; the delta is derived
from the normalized run event store, not stored as a chain. Auditable app data,
never hidden prompt concatenation.
_Avoid_: Context handoff (t3code term), summary injection

**Normalizer**:
The host-side transform that turns raw harness events into normalized run
lifecycle events (run started/terminal, node created/completed, request
created/resolved). Content-agnostic: message content stays in blocks, only
lifecycle and identity are normalized.
_Avoid_: Adapter (overloaded: also the provider CLI integration), parser

**Block**:
A message unit in a session's transcript: user, assistant, image, reasoning,
tool, approval, tasks, plan, system, handoff.