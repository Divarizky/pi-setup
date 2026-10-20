import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextManager from "../index.ts";
import { sanitizeEnvironment } from "./command-runner.ts";

type ExecuteParams = {
  runtime?: "shell" | "javascript" | "typescript" | "python";
  script: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
};
type ExecuteTool = (
  toolCallId: string,
  params: ExecuteParams,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<unknown>;

function getExecuteTool(): ExecuteTool {
  let execute: unknown;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(tool: unknown) {
      if (typeof tool === "object" && tool !== null && "name" in tool && tool.name === "execute") {
        execute = "execute" in tool ? tool.execute : undefined;
      }
    },
  };
  contextManager(pi as unknown as ExtensionAPI);
  assert.equal(typeof execute, "function");
  return execute as ExecuteTool;
}

function headlessContext(): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: { confirm: async () => true, notify() {} },
  } as unknown as ExtensionContext;
}

test("security regression: sanitizeEnvironment menghapus varian secret key", () => {
  const env: Record<string, string> = {
    PATH: "/bin",
    HOME: "/home/user",
    GITHUB_TOKEN: "x",
    NPM_TOKEN: "x",
    AWS_SECRET_ACCESS_KEY: "x",
    MY_PASSWORD: "x",
    PASSWD: "x",
    API_KEY: "x",
    "API-KEY": "x",
    AUTH_HEADER: "x",
    COOKIE: "x",
    CREDENTIAL: "x",
    NODE_OPTIONS: "--require=/tmp/inject.js",
    PYTHONPATH: "/tmp/inject",
    LD_PRELOAD: "/tmp/inject.so",
    GIT_EXTERNAL_DIFF: "/tmp/inject.sh",
    SAFE_VALUE: "ok",
  };
  const out = sanitizeEnvironment(env as any);
  for (const k of Object.keys(env)) {
    if (k === "PATH" || k === "HOME" || k === "SAFE_VALUE") {
      assert.equal((out as any)[k], env[k]);
    } else {
      assert.equal((out as any)[k], undefined, `harus terfilter: ${k}`);
    }
  }
});

test("security regression: execute jalan tanpa konfirmasi, termasuk mutatif headless", async () => {
  const execute = getExecuteTool();
  let prompts = 0;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      confirm: async () => { prompts += 1; return false; },
      notify() {},
    },
  } as unknown as ExtensionContext;

  // read-only tetap jalan
  const ok = await execute("security-test", { runtime: "shell", script: "echo hello" }, undefined, undefined, headlessContext());
  assert.match(String((ok as any)?.content?.[0]?.text ?? ""), /hello/);
  // mutatif headless tidak lagi ditolak
  await assert.rejects(
    execute("security-test", { runtime: "shell", script: "exit 3" }, undefined, undefined, headlessContext()),
    /exit 3/,
  );
  assert.equal(prompts, 0);
});
