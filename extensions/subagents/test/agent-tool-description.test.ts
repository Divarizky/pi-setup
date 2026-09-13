// Agent tool description and schema tests. Instantiates the real extension
// with a mock pi inside a temporary cwd, then inspects the registered tool.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWorktreeIsolationEnabled } from "../src/core/worktree.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

describe("Agent tool description", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function setup(settings?: Record<string, unknown>, beforeInstantiate?: () => void) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    // Isolate global settings (getAgentDir / ~/.pi) so the dev's real
    // subagents.json can't leak into the "default is full" assertion.
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    if (settings) {
      writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(settings));
    }
    beforeInstantiate?.();
    process.chdir(tmpDir);

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    // applySettings only applies keys that are PRESENT, so a subagents.json
    // without `worktreeIsolation` leaves the module singleton wherever the
    // previous test left it. Reset it so each setup()'s settings decide, and
    // so the "default" assertions below really test the default.
    setWorktreeIsolationEnabled(true);
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it("compact mode swaps in the short description with one-line type list", () => {
    const tools = setup();
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("Launch an autonomous agent");
    expect(desc).not.toContain("## Usage notes");
    expect(desc).not.toContain("## Writing the prompt");
    // Type list keeps every agent but only the first sentence of each description.
    expect(desc).toContain("- general:");
    expect(desc).toContain("- explore: Fast read-only search agent for locating code. (Tools:");
    expect(desc).toContain("- build: Focused implementation agent for making code changes");
    expect(desc).not.toContain("very thorough");
    // The point of the feature: materially smaller than the full version.
    expect(desc.length).toBeLessThan(1600);
  });

  it("keeps every load-bearing contract in the compact description", () => {
    const tools = setup();
    const desc: string = tools.get("Agent").description;
    // One keyword per behavioral contract the orchestrator must know about.
    // If you change one of these behaviors, update BOTH descriptions.
    for (const contract of [
      "run_in_background",
      "resume",
      "steer_subagent",
      'isolation: "worktree"',
      ".pi/agents/",
      "self-contained",
    ]) {
      expect(desc).toContain(contract);
    }
  });

  // The compact test above pins the prose alone, which is right for compact —
  // it is the only place that mode states these. `full` is different: several
  // contracts are stated twice, in the description AND in the param schema, so
  // pinning prose alone would block a legitimate move of one into the other
  // while missing the failure that actually matters — a contract that ends up
  // in neither. Asserting over description + schema is the invariant that
  // survives either choice. The second test then keeps the schema half honest,
  // so "it's also in the schema" can never degrade to an empty stub.
  it("full states every load-bearing contract in the description or the schema", () => {
    const tool = setup().get("Agent");
    const visible = `${tool.description}\n${JSON.stringify(tool.parameters)}`;
    for (const contract of [
      "run_in_background",
      "resume",
      "steer_subagent",
      "worktree",
      ".pi/agents/",
      "self-contained",
      "model",
      "thinking",
      "inherit_context",
    ]) {
      expect(visible).toContain(contract);
    }
  });

  it("every strategy param carries a real description of its own", () => {
    const props = setup().get("Agent").parameters?.properties ?? {};
    for (const name of ["run_in_background", "model", "thinking", "inherit_context"]) {
      // Long enough to be an explanation the model can act on, not a bare label.
      expect(props[name]?.description?.length ?? 0).toBeGreaterThan(40);
    }
  });

  // The schema half of `worktreeIsolation: false` shipped without the prose
  // half: `isolationParam` dropped the field while both descriptions kept
  // telling the model to pass it. Nothing rejects the undeclared key (TypeBox
  // sets no additionalProperties: false) and, by design, nothing notes the
  // downgrade on the result — so the model had every reason to report a
  // `pi-agent-*` branch that was never created. Schema and prose have to move
  // together, which is why both are asserted here.
  describe("worktreeIsolation gates the isolation parameter and its prose", () => {
    const props = (tools: Map<string, any>) =>
      Object.keys(tools.get("Agent").parameters?.properties ?? {});

    it("drops both when worktree isolation is disabled", () => {
      const tools = setup({ worktreeIsolation: false });
      const names = props(tools);
      expect(names).not.toContain("isolation");
      expect(tools.get("Agent").description).not.toContain("isolation");
      // One field, not the tool — and the neighbouring gate is unaffected.
      expect(names).toEqual(expect.arrayContaining(["prompt", "description", "subagent_type"]));
    });

    it("drops the compact description's bullet too", () => {
      const enabled = setup();
      expect(enabled.get("Agent").description).toContain('isolation: "worktree"');
    });

    it("compact mode says nothing about isolation when disabled", () => {
      const tools = setup({ worktreeIsolation: false });
      expect(tools.get("Agent").description).not.toContain("isolation");
      // The bullet above it survives — the gate trims a suffix, not the list.
      expect(tools.get("Agent").description).toContain("resume continues a previous agent by ID");
    });
  });

  // The tool description is the only thing the orchestrator LLM knows about an
  // agent's capabilities before spawning it. `tools: none` and an `ext:`-only
  // `tools:` both parse to zero built-ins (custom-agents.ts parseToolsField),
  // and test/fixtures/.pi/agents/tools-none.md pins that the *runtime* really
  // does drop every built-in. So the description must not claim otherwise —
  // an agent advertised as having `bash` that cannot run `bash` gets routed
  // work it can only fail at.
  describe("tool scope suffix reflects the real built-in set", () => {
    function withAgent(name: string, frontmatter: string, settings?: Record<string, unknown>) {
      const extra = frontmatter ? `${frontmatter}\n` : "";
      return setup(settings, () => {
        mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
        writeFileSync(
          join(tmpDir, ".pi", "agents", `${name}.md`),
          `---\ndescription: ${name} agent.\n${extra}---\n\nBody.\n`,
        );
      });
    }

    it("`tools: none` never claims the full built-in set", () => {
      const tools = withAgent("quiet", "tools: none");
      const desc: string = tools.get("Agent").description;
      expect(desc).not.toContain("- quiet: quiet agent. (Tools: *)");
    });

    it("`tools: none` says none only when the agent can call nothing at all", () => {
      // extensions: false and isolated: true both leave the agent with zero
      // built-ins AND zero extension tools — the one case "none" is true.
      for (const fm of ["tools: none\nextensions: false", "tools: none\nisolated: true"]) {
        const tools = withAgent("silent", fm);
        expect(tools.get("Agent").description).toContain("- silent: silent agent. (Tools: none)");
      }
    });

    it("`tools: none` with extensions loaded is not described as having no tools", () => {
      // Zero built-ins is not zero tools: test/fixtures/.pi/agents/tools-none.md
      // pins that such an agent still surfaces alpha_read, alpha_write, beta_tool.
      // Saying "none" understates it and routes work away from the only agent
      // that could do it — the mirror of the bug this suffix used to have.
      const tools = withAgent("probe", 'tools: none\nextensions: "./ext-alpha.mjs"');
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- probe: probe agent. (Tools: no built-ins, extension tools only)");
      expect(desc).not.toContain("- probe: probe agent. (Tools: *)");
      expect(desc).not.toContain("- probe: probe agent. (Tools: none)");
    });

    it("an ext:-only `tools:` is described by what it actually has", () => {
      const tools = withAgent("extonly", 'tools: "ext:probe.mjs"');
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- extonly: extonly agent. (Tools: no built-ins, extension tools only)");
      expect(desc).not.toContain("- extonly: extonly agent. (Tools: *)");
    });

    it("compact mode shares the suffix builder and must not diverge", () => {
      const tools = withAgent("quiet", "tools: none\nextensions: false");
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- quiet: quiet agent. (Tools: none)");
      expect(desc).not.toContain("- quiet: quiet agent. (Tools: *)");
    });

    it("an omitted `tools:` still renders as * — absent means all built-ins", () => {
      // Guards the fix from over-correcting: undefined (inherit everything,
      // as the shipped defaults do) is not the same as [] (explicitly zero).
      const tools = withAgent("broad", "");
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- broad: broad agent. (Tools: *)");
    });

    it("a narrowed `tools:` still lists the names it actually has", () => {
      const tools = withAgent("narrow", "tools: read, grep");
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("- narrow: narrow agent. (Tools: read, grep)");
    });
  });
});
