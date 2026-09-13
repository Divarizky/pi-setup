import assert from "node:assert/strict";
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
