/**
 * fleet-wiring.test.ts — end-to-end wiring of the FleetView through the REAL
 * extension (src/index.ts), not the FleetList class in isolation.
 *
 * The unit tests in fleet-list.test.ts drive FleetList with a fake ui/manager.
 * These prove the bits only the extension can: that `tool_execution_start`
 * hands the fleet the live UI (so it captures input), that spawning a background
 * agent actually registers the footer-chain composite once the agent has a session,
 * and that `session_shutdown` tears it down. runAgent is mocked (no LLM); the
 * manager, settings load, completion routing, and lifecycle handlers are real.
 *
 * The fleet chains via setFooter: fleet rows above + published custom footer
 * below (footer-chain protocol). Restore returns the custom factory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { CUSTOM_FOOTER_CHAIN_KEY } from "../src/ui/footer-chain.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

/** A UI context with the surfaces the widget + fleet touch; setFooter spied. */
function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setFooter: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>) {
  return {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("FleetView wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    // async join → completion routes straight to sendIndividualNudge (no batch
    // debounce), so fleet.onAgentFinished fires synchronously on the result.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ defaultJoinMode: "async" }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("captures terminal input on tool_execution_start (fleet hooked into the UI)", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("chains fleet rows above the published custom footer, then restores it on shutdown", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    // Footer custom yang dipublish ui-customization via protokol footer-chain.
    const customFactory = vi.fn((_tui: any, _theme: any, _fd: any) => ({
      render: (_w: number) => ["CUSTOM-FOOTER"],
      invalidate: () => {},
    }));
    (globalThis as any)[CUSTOM_FOOTER_CHAIN_KEY] = customFactory;
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);

      const ui = uiCtx();
      await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui)); // fleet captures THIS ui

      const spawn = await tools.get("Agent").execute(
        "tc",
        { prompt: "go", description: "live one", subagent_type: "general", run_in_background: true },
        undefined,
        undefined,
        ctxWith(uiCtx()),
      );
      expect(textOf(spawn)).toMatch(/Agent ID:/);
      await flush(); // completion → fleet.onAgentFinished → update → composite registers

      const fleetRegs = ui.setFooter.mock.calls.filter(c => typeof c[0] === "function");
      expect(fleetRegs.length, "fleet should register a footer composite").toBeGreaterThan(0);
      // Composite render: fleet rows di atas, footer custom di bawah.
      const lastFactory = fleetRegs[fleetRegs.length - 1][0];
      const fakeTheme = { fg: (_c: string, s: string) => s };
      const lines = lastFactory({}, fakeTheme, { getExtensionStatuses: () => new Map() }).render(120);
      expect(lines.join("\n")).toContain("CUSTOM-FOOTER");

      await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
      // Restore ke factory custom ASLI (bukan undefined).
      expect(ui.setFooter).toHaveBeenLastCalledWith(customFactory);
    } finally {
      delete (globalThis as any)[CUSTOM_FOOTER_CHAIN_KEY];
    }
  });

  it("renders fleet alone when no custom footer is published", async () => {
    delete (globalThis as any)[CUSTOM_FOOTER_CHAIN_KEY];
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    const spawn = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "live one", subagent_type: "general", run_in_background: true },
      undefined,
      undefined,
      ctxWith(uiCtx()),
    );
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush();

    const fleetRegs = ui.setFooter.mock.calls.filter(c => typeof c[0] === "function");
    expect(fleetRegs.length, "fleet should register a footer factory").toBeGreaterThan(0);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    // Tanpa custom: restore = footer bawaan.
    expect(ui.setFooter).toHaveBeenLastCalledWith(undefined);
  });
});
