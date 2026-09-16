import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import obsidianMemoryExtension from "./index.ts";
import {
  MEMORY_RECAP_CHANNEL,
  MEMORY_STATUS_CHANNEL,
} from "../dashboard-state/dashboard-state.ts";

test("registers session_start, before_agent_start, tool_result handlers and vault-audit command", async () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const tools = new Set<string>();
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> =
    {};
  const emitted: Array<[string, unknown]> = [];
  const recapListeners = new Set<(value: unknown) => unknown>();
  let recapUnsubscribeCalls = 0;

  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      events.add(event);
      handlers[event] = handler;
    },
    registerCommand: (name: string) => commands.add(name),
    registerTool: (tool: { name: string }) => tools.add(tool.name),
    events: {
      on: (channel: string, listener: (value: unknown) => unknown) => {
        if (channel === MEMORY_RECAP_CHANNEL) recapListeners.add(listener);
        return () => {
          if (channel === MEMORY_RECAP_CHANNEL) recapUnsubscribeCalls++;
          recapListeners.delete(listener);
        };
      },
      emit: (channel: string, value: unknown) => emitted.push([channel, value]),
    },
  } as unknown as ExtensionAPI;

  obsidianMemoryExtension(api);

  assert.deepEqual(
    events,
    new Set([
      "session_start",
      "session_shutdown",
      "before_agent_start",
      "tool_result",
    ]),
  );
  assert.deepEqual(commands, new Set(["vault-audit"]));
  assert.deepEqual(tools, new Set(["search_knowledge"]));

  // Invoke session_start handler with a UI context
  await handlers["session_start"]({}, { hasUI: true });
  const memoryEmit = emitted.find(
    ([channel]) => channel === MEMORY_STATUS_CHANNEL,
  );
  assert.ok(memoryEmit, "memory status should be emitted on session_start");
  const state = memoryEmit[1] as { ok: boolean; shortPath: string };
  assert.equal(typeof state.ok, "boolean");
  assert.equal(typeof state.shortPath, "string");
  assert.equal(recapListeners.size, 1);

  await handlers["session_shutdown"]({ reason: "reload" }, {});
  assert.equal(recapListeners.size, 0);
  await handlers["session_shutdown"]({ reason: "reload" }, {});
  assert.equal(recapListeners.size, 0);
  assert.equal(recapUnsubscribeCalls, 1);
});

test("includes project directories when projects has sibling files", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-index-"));
  const vault = join(root, "vault");
  const project = join(vault, "projects", "project-alpha");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(vault, "projects", "README.md"), "# Projects\n");
  writeFileSync(join(project, "overview.md"), "# Project Alpha\n");

  const configPath = join(root, "obsidian-memory.json");
  writeFileSync(configPath, JSON.stringify({ vault, projectMap: {} }));

  const extensionUrl = new URL("./index.ts", import.meta.url).href;
  const script = `
    const handlers = new Map();
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      registerCommand() {},
      registerTool() {},
      events: { on() { return () => {}; }, emit() {} },
    };
    const extension = (await import(${JSON.stringify(extensionUrl)})).default;
    extension(pi);
    await handlers.get("session_start")({}, { hasUI: false });
  `;

  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, PI_OBSIDIAN_MEMORY_CONFIG: configPath },
      stdio: "pipe",
    },
  );

  const graph = readFileSync(join(vault, "vault-graph.md"), "utf8");
  assert.match(graph, /### project-alpha/);
  assert.ok(graph.includes("- [[projects/project-alpha/overview]]"));
});
