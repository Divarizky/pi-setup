# subagents

Subagents extension for pi. Runs AI subagents through the in-process Pi child-session backend and can normalize Orca terminal status as external session evidence.

## Structure

```
index.ts                  # extension entry point: tools, commands, renderers
src/
  domain.ts               # normalized event/snapshot/transcript types
  backend.ts              # SubagentBackend + SubagentSession interface
  manager.ts              # SubagentManager service (cap 4, lifecycle, read model)
  job-queue.ts            # durable dependency/priority job queue + restart re-enqueue
  lead-agent.ts           # durable Lead Agent registry
  runtime.ts              # ManagedRuntime + runTool boundary
  prompt.ts               # model-facing tool descriptions
  result-delivery.ts      # deferred result message queue
  worktree.ts             # isolated Git worktree validation and cleanup
  execution-policy.ts     # scout/build backend and worktree policy
  workflow/
    state.ts              # workflow status machine and transition validation
    wake-queue.ts         # durable append-only events and actionable wakes
    lead-agent-proposals.ts # approval-gated Lead Agent child proposals
    orchestration.ts       # structured Lead Agent event protocol
    coordinator.ts         # event-driven orchestration coordinator
    task-ledger.ts         # canonical durable task/event ledger
  format.ts               # context % + status bar formatting
  subagent-monitor.ts     # zero-token lifecycle and external evidence monitor
  state-lock.ts           # single-runtime lease for durable state
  action-queue.ts         # durable monitor actions and receipts
  approval.ts             # durable delivery approval state machine
  delivery.ts             # verified Git delivery operations
  persistence.ts          # restart-safe job and event persistence
  report.ts               # structured subagent report parsing
  security.ts             # bounded and sanitized external text
  spawn-claims.ts         # duplicate spawn claim registry
  quick-ask.ts            # /quick-ask title helper + visibility filter
  transports/
    orca-cli.ts           # typed Orca terminal CLI client + job binding adapter
    composer.ts           # fail-closed Orca composer detection and submission
  backends/
    pi.ts                 # in-process Pi backend with native session identity
    orca.ts               # Pi-in-Orca-terminal backend
    stub.ts               # scripted backend for tests
  ui/
    takeover.ts           # /subagents picker + takeover view
    transcript.ts         # transcript rendering
  types/                  # stub declarations for @earendil-works/* (dev only)
test/                    # focused unit/integration coverage for lifecycle, workflow, Orca, delivery, UI, and worktrees
```

## Development

```bash
npm install
npm run typecheck
npm test
```

Local `node_modules/@earendil-works/*` stubs exist only so the skeleton compiles and tests without the real pi SDK packages. **Remove them before installing this extension in a real pi environment** — the real `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` packages will provide types and runtime.

## Tools

- `subagent_spawn` — spawn a background subagent; build uses Pi in an Orca-managed worktree, while scout uses read-only Pi in the parent cwd without a worktree
- `subagent_wait` — block until listed subagents settle
- `subagent_cancel` — abort running subagents
- `subagent_check` — non-blocking subagent status peek
- `subagent_list` — list all subagents
- `subagent_approve` — explicitly approve or reject a pending build delivery operation
- `subagent_deliver` — request or execute approved commit, merge, push, or PR delivery
- `subagent_action_list` — list durable action items from Subagent Monitor
- `subagent_action_confirm` — record an action receipt; this does not approve delivery
- `subagent_wake_list` — list durable actionable workflow wakes
- `subagent_wake_ack` — acknowledge a handled workflow wake
- `subagent_retry` — retry a failed subagent or explicitly re-enqueue a blocked durable job with bounded backoff
- `subagent_retire` — request approval to permanently delete a settled subagent and its worktree
- `subagent_delete` — permanently delete a Thread, its session/chat history, durable events, approvals, actions, and managed worktree after confirmation
- `subagent_lead_create` — create a named persistent Lead Agent
- `subagent_lead_send` — send a follow-up, reopening its persisted Pi session when needed
- `subagent_lead_stop` — stop and unregister a Lead Agent
- `subagent_lead_event` — emit structured proposal, completion, escalation, ask, or reply events
- `subagent_lead_propose` — record a child task proposed for a Lead Agent
- `subagent_lead_approve` — approve a Lead Agent child proposal before dispatch
- `subagent_lead_reject` — reject a Lead Agent child proposal with a reason

## Modes

- `scout` — read-only investigation in a separate in-process Pi session, sharing the parent cwd without a worktree; mutating tools are excluded
- `build` — Pi runs in an Orca-managed isolated worktree and reports validation; delivery requires explicit parent review and approval

`subagent_spawn` accepts optional `depends_on` and `priority`. Dependent jobs enter the durable job queue, dispatch only after dependencies finish successfully, and become blocked when a dependency fails. Approved Lead Agent proposals retain a parent-task link in the task ledger through dispatch and settlement.

Orca spawns fail closed on runtime readiness: `orca status --json` must report `reachable=true` with `state=ready` before any worktree, terminal, or repo registration is created. Once an agent TUI has produced output, follow-up input is typed literally through `terminal send --text` (no Enter), verified against the bottom-most composer shape (`empty`/`pending`/`unknown`; `unknown` refuses to blind-submit), and submitted with Enter — popup placeholder fills get the required second Enter without retyping. Steering sent while a worker is busy is persisted to a durable per-job inbox under `workspace/state/orca-inbox/<jobId>`; only a short doorbell line reaches the terminal, queued messages drain as one follow-up turn after the next successful settle, and messages left on disk are restored after restarts.

Build worktrees use readable conventional branch names in the form `<type>/<slug>` by default, for example `chore/recover-missing-session`. An optional `branch_scope` produces `<type>/<scope>/<slug>`, for example `fix/subagents/recover-missing-session`; there is no default scope. `branch_type` can override the type. Branch collisions are rejected rather than silently renamed. The durable `jobId` remains an internal identity for persistence, retry, and recovery.

## Identity vocabulary

- `jobId` identifies one subagent execution and is the meaning of `SubagentSnapshot.id` and the queue record's compatibility `id` field.
- `taskId` identifies a workflow task and must not be passed to manager or subagent execution APIs.
- `leadAgentId` identifies a persistent Lead Agent; `proposalId` identifies a child-task proposal.
- Public tools may retain the generic `id` parameter for compatibility, but internal code should name the value according to its identity.

Scout runs only on the `pi` backend. Build runs only on the `orca` backend, where Orca creates the checkout with its agent-first worktree CLI and launches Pi in the visible Orca terminal. Explicit mode/backend mismatches are rejected. Orca terminal identity is bound to the canonical job id and persisted; startup attempts to reattach running Orca jobs to a still-connected terminal. Connected terminals remain `unknown` until terminal status is verified, while missing or disconnected terminals produce durable recovery actions and preserve the job/worktree. Orca control fails closed when the CLI does not return a worktree identity.

`subagent_deliver` first requires a parent-approved review operation that validates the diff, then supports approved commit, merge, push, and GitHub PR operations. Merge/push require consumed commit approval, and PR requires consumed commit plus push approvals. Failures leave the approval available for a retry. Retirement is the approval-gated full-delete alias and force-deletes the managed worktree, branch, session, and durable metadata.

Lead Agents are persistent subagents with durable charter/scope metadata. They use a stable name and Pi session identity; child proposals are persisted and require parent approval before `subagent_spawn` dispatch. Follow-ups reuse the live session when available and reopen the preserved worktree after restart. `subagent_lead_event` provides structured `proposal`, `worker_done`, `escalation`, `ask`, and `reply` events; the Coordinator deduplicates and replays them from the canonical task ledger.

The zero-token Subagent Monitor classifies CLI-derived terminal evidence as `busy`, `idle`, `unknown`, or `dead`, rejects stale, future, and conflicting evidence, and emits explicit identity-mismatch actions before writing records to the durable `action queue`. An `action receipt` changes the item to `action confirmed`; confirmation is separate from delivery approval. `OrcaCli` supports Orca's documented agent-first launch (`worktree create --agent pi --prompt`) and typed `worktree rm` plus `terminal list/read/send/wait/stop` through `execFile` (never a shell). `OrcaTerminalAdapter` permits terminal control only for a terminal explicitly attached to a job. A connected terminal is still `unknown` until terminal status verifies its lifecycle state; a missing, orphaned, or disconnected terminal is `dead`.

## Commands

- `/subagents` — Thread dashboard + takeover (the command name is intentionally retained)
  - Deleting a Thread from the dashboard deletes its session history, durable records, branch, and managed worktree after confirmation; terminal/session loss instead remains recoverable.
  - Dashboard defaults to active and needs-attention Threads, shows project/worktree context, and uses a list-left/detail-right layout.
  - `h` toggles settled history (successes and failures), `r` retries a failed/recovery-required Thread or re-enqueues a blocked durable job, `a` approves the selected delivery/delete action after confirmation, `c` confirms a monitor action, `i` shows Orca terminal identity, `d` opens an in-place confirmation overlay and permanently deletes the selected Thread, and `x` aborts a running session.
  - `↑/↓` selects a Thread; confirm opens takeover. Takeover sends follow-ups and the configured PageUp/PageDown bindings scroll transcript pages.
  - The dashboard marks booting, queued, recovery-required, and parent-decision states. The detail view shows test pass ratio, changed files, turns/runs, restarts/timeouts, and queue depth instead of only zero-valued test/file counters.
  - The takeover header shows mode/origin, worktree branch, report state, queued messages, pending approvals, pending monitor actions, and inbox persistence errors when available.
  - Orca build Threads also show the native terminal, tab/pane, and worktree identities so the user can inspect the same visible worker directly in Orca. Manual follow-ups from the takeover view remain scoped through the verified job binding.
  - The view collapses metadata/help on short terminals and keeps multiline input available.
- `/quick-ask` — durable one-off side question; its origin remains `quick-ask` after restart

## Orca subagent visibility

For an Orca build, `/subagents` is the extension-side dashboard and takeover view; Orca remains the terminal-side subagent view. Use the displayed native terminal/worktree identity to locate the worker in Orca. The dashboard can observe the normalized transcript and send a verified follow-up, while direct typing in Orca remains an explicit user action outside the extension lifecycle.

## Result delivery

When a subagent settles, its result is delivered to the parent as a new turn automatically (firstmate-style "never left blind" delivery). Results stay marked as untrusted agent data. Set `SUBAGENT_AUTO_WAKE=0` to restore queue-only delivery that waits for the next user interaction.

## Task reports

Subagents must finish with exactly one strict JSON report wrapped in `<subagent-report>` tags. Required fields are `outcome`, `summary`, `changes`, `tests`, and boolean `needsParentDecision`; non-success outcomes must also include a non-empty `error` string or `{phase,message,cause?,recovery?}` object. Runtime failures and timeouts are converted into actionable reports for the parent; results remain untrusted agent data, while the normalized report is also available as structured delivery metadata. Orca reads terminal output with cursor-based incremental reads so follow-up turns cannot reuse an earlier turn's report. Each snapshot also exposes bounded `metrics` and an `eventLog` for diagnosing restarts, timeouts, and backend failures. Pi steering/follow-up prompts are limited to 32,000 characters; while streaming, the queue is limited to 16 prompts or 256 KiB. Orca's durable inbox limits each message to 32 KiB, the queue to 64 messages, and total pending payloads to 256 KiB; rejected or failed persistence is reported as a backend error. Restarting an idle subagent counts against the concurrency limit.
