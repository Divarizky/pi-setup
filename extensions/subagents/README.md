# subagents

Personal pi extension for autonomous sub-agents and deterministic workflow orchestration.

## Features

- `Agent` with background execution, foreground joins, resume, and steering.
- Built-in types: `explore`, `build`, and `general`.
- Custom agents from `.pi/agents/<name>.md`, `.agents/agents/<name>.md`, or the global agent directory.
- Worktree isolation for parallel code changes.
- Opt-in Agent Control for durable scout/ship tasks, candidate review, approval, and transactional integration.
- `SubagentWorkflow` with `agent()`, `parallel()`, `pipeline()`, `phase()`, `gate`, and durable workflow journals.
- Nested delegation with a hard four-level depth cap; from grandchild depth onward, each parent may have at most two active children.
- Fleet view, conversation viewer, mentions, completion notifications, and cross-extension RPC.
- Per-type policy presets for model, max turns, and thinking level.

## Install

This is a private pi-setup extension. Install it from the local checkout; it is not published to npm:

```bash
pi install ./extensions/subagents
```

For development:

```bash
pi -e ./extensions/subagents/src/index.ts
```

The primary command is `/subagents`; `/agents` remains a compatibility alias.

## Quick start

```text
Agent({
  subagent_type: "explore",
  prompt: "Find every authentication entry point",
  description: "Find auth entry points"
})
```

Agents run in the background by default. Use `run_in_background: false` when the next action depends on the result immediately. Use `steer_subagent` to redirect an agent and `get_subagent_result` to read its final output.

## Agent Control

Agent Control is disabled by default to preserve legacy behavior. Enable it per project in `.pi/subagents.json`:

```json
{
  "agentControl": true
}
```

With Agent Control enabled, top-level `Agent` calls use durable task policies:

- `explore` is a read-only scout and does not create a worktree.
- `build` is an isolated ship task and requires 1–5 `validation_commands`.
- `general` requires `task_mode: "scout"` or `task_mode: "ship"`.

Open `/agents` → **Agent Control tasks** to review durable task state, candidate branch/SHA, target branch/SHA, changed files, and validation evidence. Candidate approval, rejection, and integration are interactive user actions; model output cannot substitute for confirmation. Headless mode remains read-only and refuses integration.

Task snapshots and lifecycle events are stored under the repository's Git common directory in `agent-control/`. Candidate branches are retained after rejection or integration. The legacy `firstmateLite` setting name is still accepted when reading old project settings; new writes use `agentControl`.

Built-in roles are intentionally small:

| Type | Use for |
| --- | --- |
| `explore` | Read-only repository investigation |
| `build` | Focused implementation and validation |
| `general` | General multi-step work |

## Workflows

`SubagentWorkflow` runs a deterministic JavaScript script in a worker. Scripts begin with a literal metadata block and can use `agent`, `parallel`, `pipeline`, `phase`, `log`, `gate`, and `workflow`.

```js
export const meta = {
  name: "review-panel",
  description: "Review a change from several angles",
};

const findings = await parallel([
  "Review correctness",
  "Review tests",
].map(prompt => agent(prompt, {
  description: "Review change",
  subagent_type: "explore",
  run_in_background: false,
})));

return findings;
```

Saved workflows live in `.pi/workflows/<name>.js`, `.agents/workflows/<name>.js`, or the global workflow directory. A workflow can resume from its own journal, and `gate` verifies a child command before cleanup.

See [docs/workflows.md](docs/workflows.md) for the complete grammar.

## Per-type presets

Open `/subagents` → `Settings` and edit the `model`, `max turns`, or `thinking` row for `explore`, `build`, or `general`. Changes are written to `.pi/subagents.yaml` and loaded again when Settings opens or the extension starts.

The file is also editable directly:

```yaml
explore:
  model: anthropic/claude-haiku-4-5
  thinking: low
  max_turns: 40

build:
  context: isolated
  workspace: worktree

general:
  background: true
```

Presets change operational policy only. They cannot create custom agent identities, prompts, or tools.

## Settings

Persisted settings are limited to these nine keys:

| Key | Meaning |
| --- | --- |
| `maxConcurrent` | Background concurrency limit |
| `defaultMaxTurns` | Default turn limit; `0` means unlimited |
| `worktreeIsolation` | Whether worktree isolation is available |
| `backgroundByDefault` | Default spawn mode |
| `widgetMode` | `all`, `background`, or `off` |
| `fleetView` | Show the below-editor fleet view |
| `agentMentions` | `model`, `direct`, or `off` |
| `rememberAgents` | Persist subagent sessions |
| `workflowsEnabled` | Register the workflow tool |
| `agentControl` | Enable durable scout/ship task control and candidate delivery |

Settings are project-local in `.pi/subagents.json`; global defaults are read from the pi agent directory.

## Mentions and UI

- `@explore`, `@build`, and `@general` can start or address an agent.
- `/subagents` opens the management menu.
- `/agents` is an alias for existing scripts and muscle memory.
- Fleet view is rendered below the editor and the widget is rendered above it.
- UI code is guarded by `ctx.hasUI`; print and RPC modes remain headless-safe.

## RPC

The extension exposes lifecycle-gated RPC through `pi.events`. RPC callers can ping, spawn, stop, consume results, and steer only top-level agents owned by the current session. Ownership, workspace privilege, nesting, and replay state are never forgeable through the event payload.

See [docs/rpc.md](docs/rpc.md) for the protocol details.

## Migration from the previous extension

Version 2.0 is the personal edition of the former `pi-subagents` extension. The `Plan` built-in, scheduler, and legacy durable-task facade were removed. Use `explore`, `build`, `general`, and workflows instead. Existing custom `.md` agents remain supported.

## Layout

```text
src/core/       manager and worktree infrastructure
src/ui/         widget, fleet, menus, viewers
src/workflow/   workflow runtime, journals, task state
src/presets.ts  YAML preset parser and persistence
src/index.ts    pi extension entry point
```

## Development

```bash
npm run check
npm run build
npm pack --dry-run
```

The project targets pi 0.84.0 or newer and uses Node 22 or newer.
