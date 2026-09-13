import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import contextManager from "../index.ts";
import { isPotentiallyMutating, sanitizeEnvironment } from "./command-runner.ts";

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

test("security regression: allowlist tidak boleh mengizinkan command wrapper mutatif", () => {
  const mutatif = [
    "rm -rf node_modules",
    "del /f dist",
    "mv a b",
    "cp -r a b",
    "mkdir -p /tmp/x",
    "chmod 777 file",
    "Remove-Item -Recurse dist",
    "Set-Content out.txt 'hi'",
    "npm install",
    "pnpm i",
    "yarn update",
    "git reset --hard",
    "git clean -fd",
    "git checkout main",
    "terraform apply",
    "kubectl apply -f deploy.yaml",
    "docker push my/image",
    "./deploy.sh",
    "bash ./script.sh",
    "powershell -File ./x.ps1",
    "node ./scripts/migrate.js",
    "echo hi > out.txt",
    "echo hi | tee out.txt",
    "env rm -rf ./target",
    "command rm -rf ./target",
    "timeout 1 rm -rf ./target",
    "find . -exec rm {} \\;",
    "awk 'BEGIN { system(\"rm -rf ./target\") }'",
    "node --version -e \"process.exit(1)\"",
  ];
  for (const cmd of mutatif) {
    assert.equal(isPotentiallyMutating("shell", cmd), true, `harus mutatif: ${cmd}`);
  }
});

test("security regression: read-only yang diizinkan tidak boleh melebar", () => {
  const allowed = [
    "ls -la",
    "cat package.json",
    "grep -R foo .",
    "git status --short",
    "git diff --stat",
    "git log --oneline -n 5",
    "git show HEAD --stat",
    "npm ls",
    "pnpm list",
    "yarn list",
    "node --version",
    "python --version",
    "echo hello",
    "printf hello",
    "ls -la && cat index.ts",
    "git status | cat",
  ];
  for (const cmd of allowed) {
    assert.equal(isPotentiallyMutating("shell", cmd), false, `harus read-only: ${cmd}`);
  }
});

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

test("security regression: js/ts/python read-only lolos, tulis/IO butuh konfirmasi", () => {
  assert.equal(isPotentiallyMutating("javascript", "1+1"), false);
  assert.equal(isPotentiallyMutating("typescript", "1+1"), false);
  assert.equal(isPotentiallyMutating("python", "print(1)"), false);
  assert.equal(isPotentiallyMutating("javascript", "process.exit(1)"), true);
  assert.equal(isPotentiallyMutating("typescript", "fetch('https://x')"), true);
  assert.equal(isPotentiallyMutating("python", "import os"), true);
  assert.equal(isPotentiallyMutating("python", "open('x','w')"), true);
});

test("security regression: execute menolak mutasi dalam mode headless", async () => {
  const execute = getExecuteTool();
  await assert.rejects(
    execute("security-test", { runtime: "shell", script: "rm -rf ./target" }, undefined, undefined, headlessContext()),
    /mode headless/,
  );
});

test("security regression: execute meminta konfirmasi dan menghormati penolakan", async () => {
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

  await assert.rejects(
    execute("security-test", { runtime: "shell", script: "npm install" }, undefined, undefined, ctx),
    /konfirmasi ditolak/,
  );
  assert.equal(prompts, 1);
});
