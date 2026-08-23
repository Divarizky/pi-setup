import assert from "node:assert/strict"
import test from "node:test"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { ApprovalRequest } from "../src/approval.ts"
import { buildSubagentInfoLines, formatSubagentError } from "../src/ui/takeover.ts"
import { buildTranscriptLines } from "../src/ui/transcript.ts"
import type { SubagentSnapshot } from "../src/domain.ts"

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme

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
  metrics: { runCount: 1, restartCount: 0, timeoutCount: 0, startedAt: 1, lastEventAt: 2 },
  eventLog: [],
  meta: {
    backend: "pi",
    mode: "build",
    modelLabel: "test-model",
    worktree: { jobId: "sa-1", repoRoot: "/repo", path: "/repo-wt", branch: "subagent/sa-1" },
  },
  usage: {},
  transcript: [{ kind: "toolResult", toolId: "t1", name: "bash", isError: false, outputPreview: "passed" }],
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
}

test("subagent errors are actionable and sanitized", () => {
  assert.equal(
    formatSubagentError("No API key found for 9router. Use /login to log into a provider via OAuth or API key."),
    "Provider 9router belum terautentikasi. Jalankan /login, lalu retry subagent.",
  )
  assert.equal(formatSubagentError("line\nwith\tcontrol"), "line with control")
})

test("subagent info exposes mode, report, and pending approval without overflowing", () => {
  const approval = {
    id: "approval:sa-1:commit",
    jobId: "sa-1",
    operation: "commit",
    status: "pending",
    requestedAt: 1,
  } as ApprovalRequest
  const lines = buildSubagentInfoLines(snapshot, 32, theme, {
    getApprovals: () => [approval],
  })
  assert.ok(lines.some((line) => line.includes("build/model")))
  assert.ok(lines.some((line) => line.includes("report: success")))
  assert.ok(lines.some((line) => line.includes("pending approval: commit")))
  assert.ok(lines.every((line) => visibleWidth(line) <= 32))
})

test("transcript tool results preserve tool names and outcomes", () => {
  const lines = buildTranscriptLines(snapshot, 80, theme)
  assert.ok(lines.some((line) => line.includes("bash")))
  assert.ok(lines.some((line) => line.includes("done")))
  assert.ok(lines.some((line) => line.includes("passed")))
})

test("Orca subagent info exposes the terminal identity for manual inspection", () => {
  const lines = buildSubagentInfoLines({
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
  }, 120, theme)
  assert.ok(lines.some((line) => line.includes("terminal term-login")))
})
