import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import type { TaskRecord } from "../src/task-control/task-state.js";
import { TaskStore } from "../src/task-control/task-store.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

describe("Agent Control task view wiring", () => {
  let hermetic: Hermetic;
  let commonDir: string | undefined;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { agentControl: true } });
  });

  afterEach(() => {
    hermetic.restore();
    if (commonDir) rmSync(commonDir, { recursive: true, force: true });
    commonDir = undefined;
  });

  it("registers a durable task reader when Agent Control is enabled", () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    expect(booted.tools.has("agent_control_tasks")).toBe(true);
  });

  it("requires UI confirmation and persists approval against the displayed candidate", async () => {
    commonDir = mkdtempSync(join(tmpdir(), "agent-control-ui-"));
    const candidate: TaskRecord = {
      id: "task-1",
      mode: "ship",
      policy: "ship",
      agentType: "build",
      objective: "Ship review",
      repositoryPath: hermetic.dir,
      status: "candidate_ready",
      createdAt: 1,
      updatedAt: 2,
      baseSha: "b".repeat(40),
      targetBranch: "main",
      candidateBranch: "agent/task-1",
      candidateSha: "a".repeat(40),
      changedFiles: ["src/index.ts"],
    };
    new TaskStore(commonDir, () => 10).createTask(candidate);

    const booted = makePi();
    booted.pi.exec = vi.fn(async () => ({ stdout: commonDir, stderr: "", code: 0, killed: false }));
    subagentsExtension(booted.pi);
    const command = booted.commands.get("subagents");
    const confirm = vi.fn(async () => true);
    let agentsMenuRound = 0;
    const commandContext = ctx({
      cwd: hermetic.dir,
      hasUI: true,
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          if (title === "Agents") {
            agentsMenuRound += 1;
            return agentsMenuRound === 1 ? options.find(option => option.startsWith("Agent Control tasks")) : undefined;
          }
          return options[0];
        }),
        custom: vi.fn(async (factory: (...args: unknown[]) => any) => {
          const instance = factory({ requestRender: () => {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, () => {});
          instance.handleInput?.("a");
        }),
        confirm,
        notify: vi.fn(),
      },
    });

    await command.handler("", commandContext);

    expect(confirm).toHaveBeenCalledWith(
      "Approve Agent Control candidate",
      expect.stringContaining(`Candidate SHA: ${"a".repeat(40)}`),
    );
    expect(new TaskStore(commonDir).load().tasks["task-1"].approval).toMatchObject({
      actor: "user",
      decision: "approved",
      taskId: "task-1",
    });
  });

  it("rejects headless integration before reading or mutating Git", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const result = await booted.tools.get("agent_control_tasks").execute(
      "task-view-1",
      { action: "integrate", task_id: "task-1" },
      undefined,
      undefined,
      ctx({ hasUI: false }),
    );

    expect(textOf(result)).toContain("headless");
    expect(booted.pi.exec).not.toHaveBeenCalled();
  });
});
