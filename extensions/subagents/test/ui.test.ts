import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ApprovalRequest } from "../src/approval.ts";
import {
  buildDashboardToolbar,
  buildSubagentInfoLines,
  formatSubagentError,
  formatSubagentStats,
  formatSubagentStatsLines,
} from "../src/ui/takeover.ts";
import { buildAgentWidgetLines } from "../src/ui/agent-widget.ts";
import { buildCompletionNotification } from "../src/ui/completion-notification.ts";
import { buildFleetViewLines } from "../src/ui/fleet-view.ts";
import { buildTranscriptLines } from "../src/ui/transcript.ts";
import { isSubagentBooting } from "../src/domain.ts";
import type { SubagentSnapshot } from "../src/domain.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

const snapshot: SubagentSnapshot = {
  id: "sa-1",
  origin: "model",
  backend: "pi",
  title: "Build feature",
  prompt: "Build feature",
  cwd: process.cwd(),
  status: "done",
  createdAt: 1,
  settledAt: 2,
  metrics: {
    runCount: 1,
    restartCount: 0,
    timeoutCount: 0,
    startedAt: 1,
    lastEventAt: 2,
  },
  eventLog: [],
  meta: {
    backend: "pi",
    mode: "build",
    modelLabel: "test-model",
    worktree: {
      jobId: "sa-1",
      repoRoot: "/repo",
      path: "/repo-wt",
      branch: "subagent/sa-1",
    },
  },
  usage: {},
  transcript: [
    {
      kind: "toolResult",
      toolId: "t1",
      name: "bash",
      isError: false,
      outputPreview: "passed",
    },
  ],
  liveTools: [],
  queued: [],
  finalText: "done",
  turns: 1,
  report: {
    outcome: "success",
    summary: "A long summary that must be bounded for a narrow terminal.",
    changes: [],
    tests: [],
    needsParentDecision: false,
  },
};

test("subagent errors are actionable and sanitized", () => {
  assert.equal(
    formatSubagentError(
      "No API key found for 9router. Use /login to log into a provider via OAuth or API key.",
    ),
    "Provider 9router belum terautentikasi. Jalankan /login, lalu retry subagent.",
  );
  assert.equal(formatSubagentError("line\nwith\tcontrol"), "line with control");
});

test("subagent info exposes mode, report, and pending approval without overflowing", () => {
  const approval = {
    id: "approval:sa-1:commit",
    jobId: "sa-1",
    operation: "commit",
    status: "pending",
    requestedAt: 1,
  } as ApprovalRequest;
  const lines = buildSubagentInfoLines(snapshot, 32, theme, {
    getApprovals: () => [approval],
  });
  assert.ok(lines.some((line) => line.includes("build/model")));
  assert.ok(lines.some((line) => line.includes("report: success")));
  assert.ok(lines.some((line) => line.includes("pending approval: commit")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 32));
});

test("dashboard toolbar exposes only contextual actions", () => {
  const approval = {
    id: "approval:sa-1:commit",
    jobId: "sa-1",
    operation: "commit",
    status: "pending",
    requestedAt: 1,
  } as ApprovalRequest;
  const toolbar = buildDashboardToolbar(
    { ...snapshot, status: "running" },
    80,
    theme,
    {
      getApprovals: () => [approval],
      onApprove: async () => {},
      onInspectTerminal: async () => {},
      onDelete: async () => {},
    },
  );
  assert.match(toolbar, /x abort/);
  assert.match(toolbar, /a approve/);
  assert.match(toolbar, /d delete/);
  assert.doesNotMatch(toolbar, /r retry/);
  assert.doesNotMatch(toolbar, /i inspect/);
  assert.ok(visibleWidth(toolbar) <= 80);
});

test("dashboard exposes useful run statistics and boot state", () => {
  assert.equal(
    formatSubagentStats(snapshot),
    "Results: not reported · Changes: 0 · Turns: 1 · Runs: 1 · Queue: empty",
  );
  const wrapped = formatSubagentStatsLines(snapshot, 28, theme);
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 28));
  assert.equal(
    isSubagentBooting({
      ...snapshot,
      status: "running",
      settledAt: undefined,
      transcript: [],
      liveTools: [],
      liveAssistant: undefined,
      metrics: { ...snapshot.metrics, runCount: 1 },
    }),
    true,
  );
});

test("agent widget contains only active subagents and stays width-safe", () => {
  const lines = buildAgentWidgetLines(
    [
      { ...snapshot, status: "running", settledAt: undefined },
      { ...snapshot, id: "done", status: "done" },
    ],
    [],
    48,
    theme,
  );
  assert.ok(lines.some((line) => line.includes("Build feature")));
  assert.ok(lines.some((line) => line.startsWith("└─")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 48));
  assert.equal(
    buildAgentWidgetLines([{ ...snapshot, status: "done" }], [], 48, theme)
      .length,
    0,
  );
});

test("FleetView requires a build lead and includes its children", () => {
  const lead: SubagentSnapshot = {
    ...snapshot,
    id: "lead-job",
    title: "Coordinate build",
    meta: {
      ...snapshot.meta,
      role: "lead",
      leadAgentId: "lead-1",
      mode: "build",
    },
    status: "running",
    settledAt: undefined,
  };
  const child: SubagentSnapshot = {
    ...snapshot,
    id: "child-job",
    title: "Add tests",
    meta: {
      ...snapshot.meta,
      role: "worker",
      leadAgentId: "lead-1",
      mode: "build",
    },
  };
  assert.equal(buildFleetViewLines([snapshot], [], false, 80, theme).length, 0);
  const lines = buildFleetViewLines([lead, child], [], true, 80, theme);
  assert.ok(lines.some((line) => line.includes("lead-build")));
  assert.ok(lines.some((line) => line.includes("Add tests")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test("completion notification includes status, preview, and detail action", () => {
  const text = buildCompletionNotification(snapshot, theme);
  assert.match(text, /Build feature completed/);
  assert.match(text, /A long summary/);
  assert.match(text, /\/subagents/);
  assert.ok(text.length < 500);
});

test("transcript tool results preserve tool names and outcomes", () => {
  const lines = buildTranscriptLines(snapshot, 80, theme);
  assert.ok(lines.some((line) => line.includes("bash")));
  assert.ok(lines.some((line) => line.includes("done")));
  assert.ok(lines.some((line) => line.includes("passed")));
});

test("Orca subagent info exposes the terminal identity for manual inspection", () => {
  const lines = buildSubagentInfoLines(
    {
      ...snapshot,
      backend: "orca",
      meta: {
        ...snapshot.meta,
        backend: "orca",
        nativeTerminalHandle: "term-login",
        nativeTabId: "tab-42",
        nativePaneKey: "pane-7",
        nativeWorktreeId: "repo::/repo-wt",
      },
    },
    120,
    theme,
  );
  assert.ok(lines.some((line) => line.includes("terminal term-login")));
});
