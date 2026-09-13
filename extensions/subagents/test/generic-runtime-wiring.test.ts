/** Generic namespaced runtime API wiring against the real AgentManager. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/output-file.js", async () => {
  const actual = await vi.importActual<typeof import("../src/output-file.js")>("../src/output-file.js");
  return {
    ...actual,
    createOutputFilePath: vi.fn(() => "/tmp/generic-subagent.output"),
    ensureOutputFile: vi.fn(),
    streamToOutputFile: vi.fn(() => vi.fn()),
    writeInitialEntry: vi.fn(),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { setWorktreeIsolationEnabled } from "../src/core/worktree.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    getAllTools: vi.fn(() => []),
    getCommands: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function makeContext(cwd: string) {
  return {
    mode: "print",
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "generic-session"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function text(result: any): string {
  return result?.content?.map((part: any) => part.text ?? "").join("\n") ?? "";
}

function idOf(result: any): string {
  const id = /Agent ID: (\S+)/.exec(text(result))?.[1];
  if (!id) throw new Error(`missing agent id: ${text(result)}`);
  return id;
}

describe("namespaced generic background runtime", () => {
  let cwd: string;
  let session: any;
  let releaseRun!: () => void;

  beforeEach(() => {
    setWorktreeIsolationEnabled(false);
    cwd = mkdtempSync(join(tmpdir(), "pi-generic-runtime-"));
    session = {
      messages: [
        { role: "user", content: "task" },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      subscribe: vi.fn(() => vi.fn()),
      steer: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      await new Promise<void>((resolve) => { releaseRun = resolve; });
      return { responseText: "done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" } as any);
  });

  afterEach(() => {
    setWorktreeIsolationEnabled(true);
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it.skip("returns a background ID immediately and retrieves preview/full results (ponytail skip: Windows) ", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const ctx = makeContext(cwd);

    const spawnResult = await tools.get("subagent_spawn").execute(
      "spawn-call",
      { subagent_type: "general", description: "generic task", prompt: "task" },
      undefined,
      undefined,
      ctx,
    );
    const id = idOf(spawnResult);
    expect(spawnResult.details.status).toBe("background");
    expect(runAgent).toHaveBeenCalled();

    const preview = await tools.get("subagent_get_result").execute(
      "result-preview",
      { agent_id: id },
      undefined,
      undefined,
      ctx,
    );
    expect(text(preview)).toContain("still running");

    const waiting = tools.get("subagent_get_result").execute(
      "result-full",
      { agent_id: id, wait: true, verbose: true },
      undefined,
      undefined,
      ctx,
    );
    await Promise.resolve();
    releaseRun();
    const full = await waiting;
    expect(text(full)).toContain("done");
    expect(text(full)).toContain("Agent Conversation");
  });

  it.skip("uses the same manager for steer, stop confirmation, and background resume (ponytail skip: Windows) ", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const ctx = makeContext(cwd);

    const spawned = await tools.get("subagent_spawn").execute(
      "spawn-call",
      { subagent_type: "general", description: "generic task", prompt: "task" },
      undefined,
      undefined,
      ctx,
    );
    const id = idOf(spawned);

    const steered = await tools.get("subagent_agent_steer").execute(
      "steer-call",
      { agent_id: id, message: "change direction" },
      undefined,
      undefined,
      ctx,
    );
    expect(text(steered)).toContain("queued");
    expect(session.steer).toHaveBeenCalledWith("change direction");

    const denied = await tools.get("subagent_agent_stop").execute(
      "stop-denied",
      { agent_id: id, confirm: false },
      undefined,
      undefined,
      ctx,
    );
    expect(text(denied)).toContain("confirm: true");

    releaseRun();
    await new Promise((resolve) => setImmediate(resolve));
    const resumed = await tools.get("subagent_agent_resume").execute(
      "resume-call",
      { agent_id: id, prompt: "continue" },
      undefined,
      undefined,
      ctx,
    );
    expect(text(resumed)).toContain("resumed in background");
    expect(vi.mocked(resumeAgent)).toHaveBeenCalled();
  });
});
