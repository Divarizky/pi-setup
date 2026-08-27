import assert from "node:assert/strict";
import test from "node:test";
import { OrcaCli, OrcaTerminalAdapter } from "../src/transports/orca-cli.ts";

class FakeOrcaCli extends OrcaCli {
  readonly calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  output = JSON.stringify({ ok: true, result: { terminals: [] } });

  override async run(command: string, args: ReadonlyArray<string>) {
    this.calls.push({ command, args });
    return this.output;
  }
}

test("Orca CLI uses typed terminal list and control arguments", async () => {
  const cli = new FakeOrcaCli("orca-test");
  cli.output = JSON.stringify({
    ok: true,
    result: {
      terminals: [
        {
          handle: "term-1",
          worktreeId: "repo::C:/work",
          connected: true,
          writable: true,
          orphaned: false,
        },
      ],
    },
  });
  const terminals = await cli.listTerminals("repo::C:/work");
  assert.equal(terminals[0]?.handle, "term-1");
  assert.deepEqual(cli.calls[0], {
    command: "orca-test",
    args: ["terminal", "list", "--worktree", "id:repo::C:/work", "--json"],
  });
  cli.output = JSON.stringify({
    ok: true,
    result: { lines: [], nextCursor: 10 },
  });
  await cli.read("term-1", { cursor: 5, limit: 100 });
  assert.deepEqual(cli.calls[1]?.args, [
    "terminal",
    "read",
    "--terminal",
    "term-1",
    "--cursor",
    "5",
    "--limit",
    "100",
    "--json",
  ]);
  await cli.send("term-1", "continue");
  assert.deepEqual(cli.calls[2]?.args, [
    "terminal",
    "send",
    "--terminal",
    "term-1",
    "--text",
    "continue",
    "--enter",
    "--json",
  ]);
  await cli.removeWorktree("repo::C:/work");
  assert.deepEqual(cli.calls[3]?.args, [
    "worktree",
    "rm",
    "--worktree",
    "id:repo::C:/work",
    "--json",
  ]);
});

test("Orca CLI launches Pi only through documented agent-first worktree create", async () => {
  const cli = new FakeOrcaCli("orca-test");
  cli.output = JSON.stringify({
    ok: true,
    result: {
      worktree: {
        id: "repo::C:/work",
        path: "C:/work",
        branch: "task",
        repoId: "repo",
      },
      agentTerminalHandle: "term-pi",
    },
  });
  const created = await cli.createPiWorktree({
    repoPath: "C:/repo",
    name: "task",
    prompt: "implement",
  });
  assert.equal(created.terminalHandle, "term-pi");
  const args = cli.calls[0]?.args ?? [];
  assert.deepEqual(args.slice(0, 9), [
    "worktree",
    "create",
    "--repo",
    "path:C:/repo",
    "--name",
    "task",
    "--agent",
    "pi",
    "--prompt",
  ]);
  assert.match(args[9] ?? "", /You are a build subagent/);
  assert.match(args[9] ?? "", /implement/);
  assert.deepEqual(args.slice(10), ["--setup", "inherit", "--json"]);
});

test("Orca terminal adapter is fail-closed and scopes control to attached jobs", async () => {
  const calls: string[] = [];
  const adapter = new OrcaTerminalAdapter({
    listTerminals: async () => [
      {
        handle: "term-2",
        worktreeId: "wt-2",
        connected: true,
        writable: true,
        orphaned: false,
      },
    ],
    read: async () => ({ lines: [] }),
    send: async (handle, text) => {
      calls.push(`send:${handle}:${text}`);
    },
    waitForIdle: async (handle) => {
      calls.push(`wait:${handle}`);
    },
    stop: async (worktreeId) => {
      calls.push(`stop:${worktreeId}`);
    },
  });
  await assert.rejects(
    adapter.send("sa-missing", "continue"),
    /No Orca terminal/,
  );

  adapter.attach({
    jobId: "sa-2",
    terminalHandle: "term-2",
    worktreeId: "wt-2",
  });
  assert.equal((await adapter.probe("sa-2", 10))?.status, "unknown");
  await adapter.send("sa-2", "continue");
  await adapter.waitForIdle("sa-2", 1_000);
  await adapter.stop("sa-2");
  assert.deepEqual(calls, ["send:term-2:continue", "wait:term-2", "stop:wt-2"]);
});

test("Orca terminal adapter refuses control after a terminal disconnects", async () => {
  const adapter = new OrcaTerminalAdapter({
    listTerminals: async () => [
      {
        handle: "term-4",
        worktreeId: "wt-4",
        connected: false,
        writable: true,
        orphaned: false,
      },
    ],
    read: async () => ({ lines: [] }),
    send: async () => {},
    waitForIdle: async () => {},
    stop: async () => {},
  });
  adapter.attach({
    jobId: "sa-4",
    terminalHandle: "term-4",
    worktreeId: "wt-4",
  });
  await assert.rejects(adapter.send("sa-4", "continue"), /disconnected/i);
});

test("Orca terminal adapter reports missing or disconnected terminal as dead", async () => {
  const adapter = new OrcaTerminalAdapter({
    listTerminals: async () => [],
    read: async () => ({ lines: [] }),
    send: async () => {},
    waitForIdle: async () => {},
    stop: async () => {},
  });
  adapter.attach({
    jobId: "sa-3",
    terminalHandle: "term-3",
    worktreeId: "wt-3",
  });
  assert.equal((await adapter.probe("sa-3", 20))?.status, "dead");
});

test("Orca CLI gates readiness and splits typed input from submit", async () => {
  const cli = new FakeOrcaCli("orca-test");
  cli.output = JSON.stringify({
    ok: true,
    result: { runtime: { reachable: false, state: "starting" } },
  });
  await assert.rejects(cli.assertReady(), /not ready/);
  cli.output = JSON.stringify({
    ok: true,
    result: { runtime: { reachable: true, state: "ready" } },
  });
  await cli.assertReady();
  assert.deepEqual(cli.calls[1]?.args, ["status", "--json"]);

  await cli.type("term-1", "typed only");
  assert.deepEqual(cli.calls[2]?.args, [
    "terminal",
    "send",
    "--terminal",
    "term-1",
    "--text",
    "typed only",
    "--json",
  ]);
  await cli.submit("term-1");
  assert.deepEqual(cli.calls[3]?.args, [
    "terminal",
    "send",
    "--terminal",
    "term-1",
    "--text",
    "",
    "--enter",
    "--json",
  ]);
  await cli.interruptKey("term-1");
  assert.deepEqual(cli.calls[4]?.args, [
    "terminal",
    "send",
    "--terminal",
    "term-1",
    "--interrupt",
    "--json",
  ]);
});

test("Orca terminal adapter routes literal typing through verified bindings", async () => {
  const calls: string[] = [];
  const adapter = new OrcaTerminalAdapter({
    listTerminals: async () => [
      {
        handle: "term-9",
        worktreeId: "wt-9",
        connected: true,
        writable: true,
        orphaned: false,
      },
    ],
    read: async () => ({ lines: [] }),
    send: async (handle, text) => {
      calls.push(`send:${handle}:${text}`);
    },
    type: async (handle, text) => {
      calls.push(`type:${handle}:${text}`);
    },
    submit: async (handle) => {
      calls.push(`submit:${handle}`);
    },
    waitForIdle: async () => {},
    stop: async () => {},
  });
  assert.equal(adapter.supportsLiteralTyping, true);
  adapter.attach({
    jobId: "sa-9",
    terminalHandle: "term-9",
    worktreeId: "wt-9",
  });
  await adapter.type("sa-9", "hello");
  await adapter.submit("sa-9");
  assert.deepEqual(calls, ["type:term-9:hello", "submit:term-9"]);

  const legacy = new OrcaTerminalAdapter({
    listTerminals: async () => [],
    read: async () => ({ lines: [] }),
    send: async (handle, text) => {
      calls.push(`send:${handle}:${text}`);
    },
    waitForIdle: async () => {},
    stop: async () => {},
  });
  assert.equal(legacy.supportsLiteralTyping, false);
});

test("Orca CLI verifies worktree identity before cleanup", async () => {
  const cli = new FakeOrcaCli("orca-test");
  cli.output = JSON.stringify({
    ok: true,
    result: { worktree: { id: "wt-1", path: "C:/repo/worktree" } },
  });
  assert.deepEqual(await cli.showWorktree("wt-1"), {
    id: "wt-1",
    path: "C:/repo/worktree",
  });
  assert.deepEqual(cli.calls[0]?.args, [
    "worktree",
    "show",
    "--worktree",
    "id:wt-1",
    "--json",
  ]);
});
