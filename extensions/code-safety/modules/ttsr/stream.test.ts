import assert from "node:assert/strict";
import test from "node:test";
import { registerStreamGuard } from "./stream.ts";
import { parseRule } from "./rule.ts";
import type { Rule, TtsrDeps, ViolationEntry } from "./types.ts";

type Handler = (event: any, ctx: any) => any;

function makeRule(md: string): Rule {
  return parseRule(md, "test.md");
}

function makePi() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };
  return {
    pi,
    sent,
    async emit(name: string, event: any, ctx: any = makeCtx()): Promise<any> {
      let result: any;
      for (const h of handlers.get(name) ?? []) {
        const r = await h(event, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
  };
}

function makeCtx() {
  let aborts = 0;
  return {
    abort() {
      aborts += 1;
    },
    get abortCount() {
      return aborts;
    },
  };
}

function makeDeps(rules: Rule[], logs: ViolationEntry[] = [], disabled: string[] = []): TtsrDeps {
  return {
    getRules: () => rules,
    log: (e) => logs.push(e),
    isEnabled: (name) => !disabled.includes(name),
  };
}

function textDelta(delta: string) {
  return { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta } };
}

function assistantEnd(text: string, stopReason = "stop") {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason },
  };
}

function startAssistant() {
  return { type: "message_start", message: { role: "assistant", content: [] } };
}

const ABORT_RULE = `---
name: no-blocked
action: abort
scope: text
condition:
  - "TERLARANG"
---
Jangan gunakan kata terlarang.
`;

const STRIP_RULE = `---
name: strip-filler
action: strip
scope: text
condition:
  - "FILLER"
---
`;

const LOG_RULE = `---
name: observe
action: log
scope: text
condition:
  - "CATAT"
---
`;

const SECRET_RULE = `---
name: secret-in-write
action: abort
scope: text
condition:
  - "RAHASIA"
---
`;

test("rule abort memanggil ctx.abort tepat sekali dan mengosongkan pesan parsial", async () => {
  const { pi, emit } = makePi();
  registerStreamGuard(pi as any, makeDeps([makeRule(ABORT_RULE)]));
  const ctx = makeCtx();

  await emit("message_start", startAssistant(), ctx);
  await emit("message_update", textDelta("ini TERLARANG dan "), ctx);
  await emit("message_update", textDelta("TERLARANG lagi"), ctx);
  const end = await emit("message_end", assistantEnd("ini TERLARANG dan TERLARANG lagi"), ctx);

  assert.equal(ctx.abortCount, 1);
  assert.deepEqual(end.message.content, []);
});

test("pesan parsial yang di-abort tidak lolos dari filter context", async () => {
  const { pi, emit } = makePi();
  registerStreamGuard(pi as any, makeDeps([makeRule(ABORT_RULE)]));
  const ctx = makeCtx();

  await emit("message_start", startAssistant(), ctx);
  await emit("message_update", textDelta("TERLARANG"), ctx);

  const abortedPartial = { role: "assistant", content: [{ type: "text", text: "TERLARANG" }], stopReason: "aborted" };
  const user = { role: "user", content: "halo" };
  const result = await emit("context", { messages: [user, abortedPartial] });

  assert.deepEqual(result.messages, [user]);
});

test("koreksi dikirim setelah agent_settled dengan nama rule dan teks koreksi", async () => {
  const { pi, sent, emit } = makePi();
  registerStreamGuard(pi as any, makeDeps([makeRule(ABORT_RULE)]));
  const ctx = makeCtx();

  await emit("message_start", startAssistant(), ctx);
  await emit("message_update", textDelta("TERLARANG"), ctx);
  await emit("message_end", assistantEnd("TERLARANG"), ctx);
  assert.equal(sent.length, 0, "koreksi tidak boleh dikirim sebelum agent_settled");

  await emit("agent_settled", { type: "agent_settled", aborted: true });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.triggerTurn, true);
  const content = sent[0].message.content;
  assert.match(content, /<system-interrupt reason="rule_violation" rule="no-blocked">/);
  assert.match(content, /Jangan gunakan kata terlarang\./);
});

test("retry koreksi berhenti setelah 2 kali pada satu pesan user, lalu direset oleh pesan user baru", async () => {
  const { pi, sent, emit } = makePi();
  registerStreamGuard(pi as any, makeDeps([makeRule(ABORT_RULE)]));

  const violate = async () => {
    const ctx = makeCtx();
    await emit("message_start", startAssistant(), ctx);
    await emit("message_update", textDelta("TERLARANG"), ctx);
    await emit("message_end", assistantEnd("TERLARANG"), ctx);
    await emit("agent_settled", { type: "agent_settled", aborted: true });
  };

  await emit("before_agent_start", { messageType: "user", prompt: "satu" });
  await violate();
  await violate();
  await violate();
  assert.equal(sent.length, 2, "koreksi ketiga tidak boleh dikirim");

  await emit("before_agent_start", { messageType: "user", prompt: "dua" });
  await violate();
  assert.equal(sent.length, 3, "pesan user baru harus mereset counter");
});

test("rule strip mengubah teks final tanpa abort dan tanpa koreksi", async () => {
  const { pi, sent, emit } = makePi();
  registerStreamGuard(pi as any, makeDeps([makeRule(STRIP_RULE)]));
  const ctx = makeCtx();

  await emit("message_start", startAssistant(), ctx);
  await emit("message_update", textDelta("awal FILLER akhir"), ctx);
  const end = await emit("message_end", assistantEnd("awal FILLER akhir"), ctx);
  await emit("agent_settled", { type: "agent_settled", aborted: false });

  assert.equal(ctx.abortCount, 0);
  assert.equal(sent.length, 0);
  assert.equal(end.message.content[0].text, "awal  akhir");
});

test("rule log hanya mencatat dan tidak mengubah pesan atau memanggil abort", async () => {
  const { pi, sent, emit } = makePi();
  const logs: ViolationEntry[] = [];
  registerStreamGuard(pi as any, makeDeps([makeRule(LOG_RULE)], logs));
  const ctx = makeCtx();

  await emit("message_start", startAssistant(), ctx);
  await emit("message_update", textDelta("ada CATAT di sini"), ctx);
  const end = await emit("message_end", assistantEnd("ada CATAT di sini"), ctx);
  await emit("agent_settled", { type: "agent_settled", aborted: false });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].rule, "observe");
  assert.equal(ctx.abortCount, 0);
  assert.equal(sent.length, 0);
  assert.equal(end, undefined);
});

test("rule secret-in-write tidak menulis excerpt ke log", async () => {
  const { pi, emit } = makePi();
  const logs: ViolationEntry[] = [];
  registerStreamGuard(pi as any, makeDeps([makeRule(SECRET_RULE)], logs));
  const ctx = makeCtx();

  await emit("message_start", startAssistant(), ctx);
  await emit("message_update", textDelta("kunci RAHASIA"), ctx);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].excerpt, undefined);
});

test("exception di dalam handler tidak keluar dari handler", async () => {
  const { pi, emit } = makePi();
  const deps: TtsrDeps = {
    getRules: () => {
      throw new Error("rule store rusak");
    },
    log: () => {},
    isEnabled: () => true,
  };
  registerStreamGuard(pi as any, deps);

  await assert.doesNotReject(emit("message_start", startAssistant()));
});

test("rule dengan enabled false tidak diproses", async () => {
  const { pi, emit } = makePi();
  const logs: ViolationEntry[] = [];
  const disabledRule = makeRule(ABORT_RULE.replace("name: no-blocked", "name: no-blocked\nenabled: false"));
  registerStreamGuard(pi as any, makeDeps([disabledRule], logs));
  const ctx = makeCtx();

  await emit("message_start", startAssistant(), ctx);
  await emit("message_update", textDelta("TERLARANG"), ctx);

  assert.equal(logs.length, 0);
  assert.equal(ctx.abortCount, 0);
});

test("rule yang dinonaktifkan lewat isEnabled tidak diproses", async () => {
  const { pi, emit } = makePi();
  const logs: ViolationEntry[] = [];
  registerStreamGuard(pi as any, makeDeps([makeRule(LOG_RULE)], logs, ["observe"]));
  const ctx = makeCtx();

  await emit("message_start", startAssistant(), ctx);
  await emit("message_update", textDelta("CATAT"), ctx);

  assert.equal(logs.length, 0);
});
