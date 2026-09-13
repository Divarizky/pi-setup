import { describe, expect, it } from "vitest";
import { resolveTaskPolicy } from "../src/task-control/task-policy.js";
import type { AgentConfig } from "../src/types.js";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "custom",
    description: "Custom agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "",
    promptMode: "replace",
    ...overrides,
  };
}

describe("Agent Control task policy resolver", () => {
  it("leaves legacy calls unchanged when Agent Control is disabled", () => {
    expect(resolveTaskPolicy({ enabled: false, agentType: "general", requestedMode: undefined })).toEqual({
      enabled: false,
    });
  });

  it("classifies explore as scout without requiring a task mode", () => {
    expect(resolveTaskPolicy({
      enabled: true,
      agentType: "explore",
      agentConfig: config({ name: "explore", isDefault: true, taskPolicy: "scout" }),
    })).toEqual({ enabled: true, policy: "scout", mode: "scout" });
  });

  it("rejects general without an explicit task mode", () => {
    expect(resolveTaskPolicy({
      enabled: true,
      agentType: "general",
      agentConfig: config({ name: "general", taskPolicy: "flexible" }),
    })).toEqual({
      enabled: true,
      ok: false,
      message: 'Agent type "general" requires task_mode: "scout" or "ship" when Agent Control is enabled.',
    });
  });

  it("rejects a task mode that conflicts with a fixed policy", () => {
    expect(resolveTaskPolicy({
      enabled: true,
      agentType: "explore",
      requestedMode: "ship",
      agentConfig: config({ name: "explore", isDefault: true, taskPolicy: "scout" }),
    })).toEqual({
      enabled: true,
      ok: false,
      message: 'Agent type "explore" has fixed task policy "scout" and cannot run as "ship".',
    });
  });

  it("rejects a custom agent without declared task policy", () => {
    expect(resolveTaskPolicy({
      enabled: true,
      agentType: "custom",
      agentConfig: config(),
    })).toEqual({
      enabled: true,
      ok: false,
      message: 'Agent type "custom" must declare task_policy: "scout", "ship", or "flexible".',
    });
  });
});
