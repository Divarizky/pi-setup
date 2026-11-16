import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionBoundaryDraft,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  MUTATION_TOOLS,
  VERIFICATION_COMMAND_REGEX,
  extractLastUserText,
  matchToolCondition,
  matchesUnlessUserSays,
  registerToolGuard,
  sanitizeExcerpt,
} from "./guards.ts";
import { loadRules, parseRule } from "./rule.ts";
import type { Rule, TtsrDeps, ViolationEntry } from "./types.ts";

interface MockPi extends ExtensionAPI {
  handlers: Map<string, ExtensionHandler<any, any>[]>;
  emit<TEvent, TResult>(event: string, payload: TEvent, ctx?: ExtensionContext): TResult | void;
}

function createMockPi(): MockPi {
  const handlers = new Map<string, ExtensionHandler<any, any>[]>();

  const pi: any = {
    handlers,
    on(event: string, handler: ExtensionHandler<any, any>) {
      let list = handlers.get(event);
      if (!list) {
        list = [];
        handlers.set(event, list);
      }
      list.push(handler);
      return () => {
        const idx = list!.indexOf(handler);
        if (idx >= 0) list!.splice(idx, 1);
      };
    },
    emit(event: string, payload: any, ctx: any = {}) {
      const list = handlers.get(event) ?? [];
      let lastResult: any = undefined;
      for (const h of list) {
        lastResult = h(payload, ctx);
      }
      return lastResult;
    },
  };

  return pi as MockPi;
}

function createMockContext(lastUserText?: string): ExtensionContext {
  const entries: any[] = [];
  if (lastUserText !== undefined) {
    entries.push({
      type: "message",
      message: {
        role: "user",
        content: lastUserText,
      },
    });
  }

  return {
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
    },
  } as unknown as ExtensionContext;
}

function createMockContextWithAskUser(
  userText: string,
  askDetails: { answer: string | null; options?: string[]; wasCustom?: boolean },
): ExtensionContext {
  const entries = [
    { type: "message", message: { role: "user", content: userText } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "ask_user",
        details: { question: "Lanjut?", ...askDetails },
      },
    },
  ];
  return {
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
    },
  } as unknown as ExtensionContext;
}

function createDeps(rules: Rule[], logSink: ViolationEntry[] = []): TtsrDeps {
  const enabledMap = new Map<string, boolean>();
  for (const r of rules) {
    enabledMap.set(r.name, r.enabled ?? true);
  }

  return {
    getRules: () => rules,
    log: (entry) => {
      logSink.push(entry);
    },
    isEnabled: (name) => enabledMap.get(name) ?? true,
  };
}

test("Guard Git membatasi operasi aktual pada shell dan menjaga izin terpisah", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - 'git\\s+commit'
  - 'git\\s+push'
unlessUserSays:
  - '\\b(commit|push)\\b'
---
Izin diperlukan.
`);
  const cases: Array<{ prompt: string; command: string; blocked: boolean; tool?: string; answer?: string; selected?: boolean }> = [
    { prompt: "Tolong rapikan", command: "git -C /tmp commit -m x", blocked: true },
    { prompt: "Tolong rapikan", command: "git -C /tmp push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: 'git "push" origin main', blocked: true },
    { prompt: "Tolong rapikan", command: "g\\it commit -m x", blocked: true },
    { prompt: "Tolong rapikan", command: "g''it push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "bash -c 'git commit -m x'", blocked: true },
    { prompt: "Tolong rapikan", command: "bash -c 'echo git commit'", blocked: false },
    { prompt: "Tolong rapikan", command: "echo git commit", blocked: false },
    { prompt: "Tolong rapikan", command: "echo selesai\ngit push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "echo \"$(git commit -m x)\"", blocked: true },
    { prompt: "Tolong rapikan", command: "echo '$(git commit -m x)'", blocked: false },
    { prompt: "Tolong rapikan", command: "echo `git push origin main`", blocked: true },
    { prompt: "Tolong rapikan", command: "if git push origin main; then :; fi", blocked: true },
    { prompt: "Tolong rapikan", command: "f() { git push origin main; }; f", blocked: true },
    { prompt: "Please commit this, but do not push.", command: "git commit -m reviewed", blocked: false },
    { prompt: "Please commit this, but do not push.", command: "git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: `python3 -c 'import subprocess; subprocess.run("git push origin main", shell=True)'`, blocked: true },
    { prompt: "Tolong rapikan", command: `python3 -c 'import subprocess; subprocess.run(["/usr/bin/git", "push", "origin", "main"])'`, blocked: true },
    { prompt: "Tolong rapikan", command: `python3 -c 'import subprocess; subprocess.run(["git", "push", "origin", "main"])'`, blocked: true },
    { prompt: "Tolong rapikan", command: "git credential fill", blocked: false },
    { prompt: "Tolong rapikan", command: "git -c alias.ci=commit ci -m x", blocked: true },
    { prompt: "Tolong rapikan", command: "git -c alias.publish=push publish origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "git status", blocked: false },
    { prompt: "Tolong rapikan", command: "sudo -u deploy git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: ">/dev/null git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "2>&1 git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "2>& 1 git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "nice git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "nice -n 10 git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "! git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "bash --noprofile -c 'git push origin main'", blocked: true },
    { prompt: "Tolong rapikan", command: "env --unset HOME git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "env -u HOME FOO=1 git commit -m x", blocked: true },
    { prompt: "Tolong rapikan", command: "/usr/bin/python3 -c 'import subprocess; subprocess.run([\"git\", \"push\"])'", blocked: true },
    { prompt: "Tolong rapikan", command: "git rev-list --count HEAD", blocked: false },
    { prompt: "Tolong rapikan", command: "git show-ref --head", blocked: false },
    { prompt: "Tolong rapikan", command: "git symbolic-ref HEAD", blocked: false },
    { prompt: "Tolong rapikan", command: "git rev-parse --show-toplevel", blocked: false },
    { prompt: "Tolong rapikan", command: "git ls-files", blocked: false },
    { prompt: "Please commit", command: "git commit -m x && git rev-parse HEAD", blocked: false },
    { prompt: "Tolong rapikan", command: "> /dev/null git commit -m x", blocked: true },
    { prompt: "Tolong rapikan", command: "timeout 30 git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "timeout -k 5 30 git commit -m x", blocked: true },
    { prompt: "Tolong rapikan", command: "/usr/bin/env git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "/bin/bash -c 'git push origin main'", blocked: true },
    { prompt: "Please commit", command: ">/dev/null timeout 30 git commit -m x", blocked: false },
    { prompt: "Tolong rapikan", command: ">/dev/null timeout 30 git status", blocked: false },
    { prompt: "Tolong rapikan", command: "env -i git commit -m x", blocked: true },
    { prompt: "Tolong rapikan", command: "eval 'git commit -m x'", blocked: true },
    { prompt: "Tolong rapikan", command: "eval git push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "env -S 'git push origin main'", blocked: true },
    { prompt: "Tolong rapikan", command: "printf 'origin main' | xargs git push", blocked: true },
    { prompt: "Tolong rapikan", command: "printf 'origin main' | xargs -n 1 git push", blocked: true },
    { prompt: "Tolong rapikan", command: "g=git; $g push origin main", blocked: true },
    { prompt: "Tolong rapikan", command: "GIT=git; $GIT commit -m x", blocked: true },
    { prompt: "Tolong rapikan", command: "x='git push'; $x", blocked: true },
    { prompt: "Please push", command: "git -c alias.publish=push publish origin main", blocked: false },
    { prompt: "Tolong rapikan", command: "git -c alias.review=log review", blocked: false },
    { prompt: "Please commit or push", command: "git commit -m x", blocked: true },
    { prompt: "Tolong rapikan", answer: "Commit or push", selected: true, command: "git commit -m x", blocked: true },
    { prompt: "Please commit", command: 'git commit -m "fix push notifications"', blocked: false },
    { prompt: "Tolong commit dan push perubahan ini", command: "git commit -m x && git push origin main", blocked: false },
    { prompt: "Tolong commit lalu push", command: "git commit -m x && git push origin main", blocked: false },
    { prompt: "Please commit and push notifications are broken", command: "git commit -m x && git push origin main", blocked: true },
    { prompt: "Please commit and push later", command: "git push origin main", blocked: true },
    { prompt: "Tolong rapikan", answer: "Commit or push", selected: true, command: "git commit -m x && git push origin main", blocked: true },
    { prompt: "Tolong rapikan", answer: "Ya, commit or push", command: "git commit -m x && git push origin main", blocked: true },
    { prompt: "Tolong rapikan", answer: "Ya, lakukan commit", command: "git commit -m x", blocked: false },
  ];
  for (const item of cases) {
    const pi = createMockPi();
    registerToolGuard(pi, createDeps([rule]));
    const ctx = item.answer === undefined ? createMockContext(item.prompt) : createMockContextWithAskUser(item.prompt, {
      answer: item.answer,
      wasCustom: !item.selected,
      options: item.selected ? [item.answer, "Batal"] : [],
    });
    const tool = item.tool ?? "bash";
    const result = pi.emit<ToolCallEvent, ToolCallEventResult>("tool_call", {
      type: "tool_call", toolCallId: "regression", toolName: tool,
      input: tool === "execute" ? { script: item.command } : { command: item.command },
    } as any, ctx);
    assert.equal(result?.block === true, item.blocked, `${item.prompt} / ${item.command} / ${item.answer ?? tool}`);
  }
});

test("AC-1: Perintah bash git commit diblokir bila pesan user tidak menyebut commit/push, dan lolos bila menyebutnya", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);

  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  const deps = createDeps([rule], logEntries);
  registerToolGuard(pi, deps);

  // 1. Kasus tanpa instruksi user (pesan user umum)
  const ctxNoPermission = createMockContext("Tolong rapikan kode ini");
  const callBlocked = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_1",
      toolName: "bash",
      input: { command: "git commit -m 'selesai'" },
    } as any,
    ctxNoPermission,
  );

  assert.ok(callBlocked, "Harus mengembalikan hasil blokir");
  assert.equal(callBlocked?.block, true);
  assert.match(
    callBlocked?.reason ?? "",
    /Operasi commit atau push dilarang/,
  );
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].rule, "git-commit-push");
  assert.equal(logEntries[0].action, "block");

  // 2. Kasus dengan instruksi user yang menyebutkan 'commit'
  const ctxWithPermission = createMockContext("Silakan commit perubahan ini");
  const callAllowed = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_2",
      toolName: "bash",
      input: { command: "git commit -m 'selesai'" },
    } as any,
    ctxWithPermission,
  );

  assert.equal(callAllowed, undefined, "Tidak boleh diblokir saat user mengizinkan");
  assert.equal(logEntries.length, 1, "Log tidak boleh bertambah saat diizinkan");
});

test("AC-1b: Hasil ask_user 'selected' yang setuju mengizinkan bash commit", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);

  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));

  // Pesan user umum tidak menyebut commit; izin hanya datang dari pilihan ask_user.
  const ctx = createMockContextWithAskUser("Tolong rapikan kode ini", {
    answer: "Ya, commit sekarang",
  });
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_ask_selected",
      toolName: "bash",
      input: { command: "git commit -m 'selesai'" },
    } as any,
    ctx,
  );

  assert.equal(result, undefined, "Pilihan ask_user yang setuju harus mengizinkan commit");
  assert.equal(logEntries.length, 0, "Izin dari ask_user tidak boleh dicatat sebagai pelanggaran");
});

test("AC-1k: Penyebutan commit dalam larangan langsung tidak memberi izin", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));
  const ctx = createMockContext("Jangan commit perubahan ini");
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_negated_direct_commit",
      toolName: "bash",
      input: { command: "git commit -m x" },
    } as any,
    ctx,
  );
  assert.equal(result?.block, true, "Larangan eksplisit user harus tetap memblokir commit");
  assert.equal(logEntries.length, 1);
});

test("AC-1l: Pertanyaan dan kalimat bernada larangan bukan izin langsung", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  for (const prompt of [
    "Should I commit this?",
    "Can I commit this?",
    "Please commit this. Don’t commit.",
    "Yes, commit is a bad idea.",
    "Commit may be needed.",
    "Commit?",
    "I said not to commit",
    "I can't commit",
    "I cannot commit",
    "Don’t commit this",
    "Ya, ora commit",
    "Ya, ogah commit",
  ]) {
    const pi = createMockPi();
    const logEntries: ViolationEntry[] = [];
    registerToolGuard(pi, createDeps([rule], logEntries));
    const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: `call_direct_nonpermission_${prompt}`,
        toolName: "bash",
        input: { command: "git commit -m x" },
      } as any,
      createMockContext(prompt),
    );
    assert.equal(result?.block, true, `Pesan non-izin harus memblokir commit: ${prompt}`);
  }
});

test("AC-1n: Pertanyaan push terpisah tidak mengizinkan perintah majemuk", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  for (const prompt of [
    "Can you commit? Should I push?",
    "Please commit the change. The word push appears in the README.",
    "Please commit. Push command is mentioned in docs.",
    "Please commit. Push has been mentioned.",
    "Please commit and include the word push in the commit message.",
    "Please commit, push command is mentioned in docs.",
  ]) {
    const pi = createMockPi();
    const logEntries: ViolationEntry[] = [];
    registerToolGuard(pi, createDeps([rule], logEntries));
    const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: `call_commit_question_push_question_${prompt}`,
        toolName: "bash",
        input: { command: "git commit -m x && git push origin main" },
      } as any,
      createMockContext(prompt),
    );
    assert.equal(result?.block, true, `Izin commit tidak boleh membuka push yang hanya disebut: ${prompt}`);
    assert.equal(logEntries.length, 1);
  }
});

test("AC-1o: Permintaan langsung commit-and-push mengizinkan kedua operasi", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_direct_commit_and_push",
      toolName: "bash",
      input: { command: "git commit -m x && git push origin main" },
    } as any,
    createMockContext("Please commit and push these changes."),
  );
  assert.equal(result, undefined, "Permintaan eksplisit kedua operasi harus mengizinkan perintah majemuk");
  assert.equal(logEntries.length, 0);
});

test("AC-1m: Permintaan langsung dan pemanggilan skill mengizinkan commit", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  for (const prompt of ["Can you commit these changes?", "/skill:git-commit", "Jalankan skill git-commit"]) {
    const pi = createMockPi();
    const logEntries: ViolationEntry[] = [];
    registerToolGuard(pi, createDeps([rule], logEntries));
    const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: `call_direct_permission_${prompt}`,
        toolName: "bash",
        input: { command: "git commit -m x" },
      } as any,
      createMockContext(prompt),
    );
    assert.equal(result, undefined, `Permintaan langsung harus mengizinkan commit: ${prompt}`);
  }
});

test("AC-1b1: Pilihan draft commit dari skill mengizinkan commit tanpa allowlist kata", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));
  const ctx = createMockContextWithAskUser("Jalankan skill git-commit", {
    answer: "Commit Lengkap",
    options: ["Commit Lengkap", "Commit Ringkas", "Batal"],
    wasCustom: false,
  });
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_skill_commit_choice",
      toolName: "bash",
      input: { command: "git commit -F -" },
    } as any,
    ctx,
  );
  assert.equal(result, undefined, "Pilihan commit yang benar-benar ditampilkan harus mengizinkan commit");
  assert.equal(logEntries.length, 0);
});

test("AC-1b2: Pilihan commit dari ask_user tidak mengizinkan push", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));
  const ctx = createMockContextWithAskUser("Tolong rapikan kode ini", {
    answer: "Commit Lengkap",
    options: ["Commit Lengkap", "Batal"],
    wasCustom: false,
  });
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_skill_commit_cannot_push",
      toolName: "bash",
      input: { command: "git push origin main" },
    } as any,
    ctx,
  );
  assert.equal(result?.block, true, "Pilihan commit tidak boleh memberi izin push");
  assert.equal(logEntries.length, 1);
});

test("AC-1b3: Pilihan ask_user bernada penolakan tidak mengizinkan commit", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));
  const ctx = createMockContextWithAskUser("Tolong rapikan kode ini", {
    answer: "I refuse to commit",
    options: ["Commit Lengkap", "I refuse to commit"],
    wasCustom: false,
  });
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_selected_refusal",
      toolName: "bash",
      input: { command: "git commit -m x" },
    } as any,
    ctx,
  );
  assert.equal(result?.block, true, "Pilihan yang berbunyi menolak harus tetap memblokir commit");
  assert.equal(logEntries.length, 1);
});

test("AC-1d: Jawaban ask_user yang memuat negasi (panjang atau singkatan) tidak mengizinkan commit", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);

  // Label memuat kata commit tetapi bernegasi, atau tanpa kata afirmatif. Keduanya harus diblokir.
  const negatedAnswers = [
    "Tidak, jangan commit", "Jgn commit", "Ga commit", "Gk commit", "Ngga commit", "Tdk commit", "Ora commit",
    "Belum commit", "Ndak commit", "Kagak commit", "Ogah commit", "Stop commit", "Nope, commit",
    "Hold off commit", "Dilarang commit", "Tanpa commit",
    "Engga commit", "Blm commit", "Bkn commit", "Nda commit", "Ngk commit",
    "Lewati commit", "Menunda commit", "Nanti aja commit", "Commit nanti dulu",
    "don\u2019t commit", "Ya, don't commit", "Yes, I can't commit", "Yes, I cannot commit",
    "Ya, ora commit", "Ya, ogah commit", "Commit sekarang",
    "Ya, batalkan commit", "Ya, dibatalkan commit", "Ya, tunda commit", "Oke, gausah commit",
    "Ya, cancelled commit", "Ya, ditolak commit", "Ya, urungkan commit", "Ya, jangan commit",
    "Ya, nggak usah commit", "Ya, belum commit", "Ya, kagak commit", "Ya, commit nanti",
    "Yes, I refuse to commit", "Yes, I can't commit", "Yes, I cannot commit",
  ];
  for (const answer of negatedAnswers) {
    const pi = createMockPi();
    const logEntries: ViolationEntry[] = [];
    registerToolGuard(pi, createDeps([rule], logEntries));

    const ctx = createMockContextWithAskUser("Tolong rapikan kode ini", { answer });
    const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: `call_ask_negated_${answer}`,
        toolName: "bash",
        input: { command: "git commit -m 'selesai'" },
      } as any,
      ctx,
    );

    assert.equal(result?.block, true, `Jawaban bernegasi "${answer}" tidak boleh memberi izin`);
    assert.equal(logEntries.length, 1, `Pemblokiran harus dicatat untuk "${answer}"`);
  }
});

test("AC-1e: Label ask_user afirmatif (Ya, commit sekarang / Silakan commit) mengizinkan commit", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);

  const affirmativeAnswers = [
    "Ya, commit sekarang", "Silakan commit", "Lanjutkan commit", "Oke commit",
    "Yes, commit and push", "Iya, commit ya", "Sure, go ahead and commit",
  ];
  for (const answer of affirmativeAnswers) {
    const pi = createMockPi();
    const logEntries: ViolationEntry[] = [];
    registerToolGuard(pi, createDeps([rule], logEntries));

    const ctx = createMockContextWithAskUser("Tolong rapikan kode ini", { answer });
    const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: `call_ask_affirm_${answer}`,
        toolName: "bash",
        input: { command: "git commit -m 'selesai'" },
      } as any,
      ctx,
    );

    assert.equal(result, undefined, `Label afirmatif "${answer}" harus mengizinkan commit`);
    assert.equal(logEntries.length, 0, `Izin untuk "${answer}" tidak boleh dicatat`);
  }
});

test("AC-1f: Jawaban ask_user 'push' tidak mengizinkan git commit, tetapi mengizinkan git push", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);

  // Jawaban "Ya, push saja" hanya menyetujui push, bukan commit.
  const pi = createMockPi();
  const commitLog: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], commitLog));
  const ctxCommit = createMockContextWithAskUser("Tolong rapikan kode ini", {
    answer: "Ya, push saja",
  });
  const commitResult = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_ask_push_commit",
      toolName: "bash",
      input: { command: "git commit -m 'selesai'" },
    } as any,
    ctxCommit,
  );
  assert.equal(commitResult?.block, true, "Jawaban 'push' tidak boleh mengizinkan git commit");

  const pushPi = createMockPi();
  const pushLog: ViolationEntry[] = [];
  registerToolGuard(pushPi, createDeps([rule], pushLog));
  const ctxPush = createMockContextWithAskUser("Tolong rapikan kode ini", {
    answer: "Ya, push saja",
  });
  const pushResult = pushPi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_ask_push_push",
      toolName: "bash",
      input: { command: "git push origin main" },
    } as any,
    ctxPush,
  );
  assert.equal(pushResult, undefined, "Jawaban 'push' harus mengizinkan git push");
});

test("AC-1g: Perintah majemuk 'git commit && git push' tidak dibuka oleh jawaban yang hanya menyetujui commit", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);

  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));
  const ctx = createMockContextWithAskUser("Tolong rapikan kode ini", {
    answer: "Ya, commit saja",
  });
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_ask_chain",
      toolName: "bash",
      input: { command: "git commit -m x && git push origin main" },
    } as any,
    ctx,
  );

  assert.equal(result?.block, true, "Jawaban commit saja tidak boleh membuka push dalam perintah yang sama");
  assert.equal(logEntries.length, 1);
});

test("AC-1h: Jawaban ask_user tidak membuka rule block non-git bila input tidak memuat verba commit/push", () => {
  const rule = parseRule(`---
name: generic-block
action: block
scope: tool:bash
condition:
  - "rm\\s+-rf"
unlessUserSays:
  - "\\b(hapus|ya)\\b"
---
Penghapusan rekursif dilarang kecuali atas permintaan langsung user.
`);

  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));
  const ctx = createMockContextWithAskUser("Tolong bersihkan build", { answer: "Ya" });
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_ask_no_verb",
      toolName: "bash",
      input: { command: "rm -rf build" },
    } as any,
    ctx,
  );

  assert.equal(result?.block, true, "Tanpa verba commit/push, jawaban ask_user tidak boleh membuka blokir");
  assert.equal(logEntries.length, 1);
});

test("AC-1i: Jawaban commit tidak membuka rule non-git yang kondisinya cocok di perintah yang sama", () => {
  const gitRule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
  const rmRule = parseRule(`---
name: generic-block
action: block
scope: tool:bash
condition:
  - "rm\\s+-rf"
unlessUserSays:
  - "\\b(hapus)\\b"
---
Penghapusan rekursif dilarang kecuali atas permintaan langsung user.
`);

  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([gitRule, rmRule], logEntries));
  const ctx = createMockContextWithAskUser("Tolong bersihkan build", { answer: "Ya, commit" });
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_ask_rm_commit",
      toolName: "bash",
      input: { command: "rm -rf build && git commit -m x" },
    } as any,
    ctx,
  );

  assert.equal(result?.block, true, "Izin commit tidak boleh membuka penghapusan rm -rf");
  assert.ok(logEntries.some((e) => e.rule === "generic-block"), "Pelanggaran rm -rf harus tercatat");
});

test("AC-1j: Jawaban ask_user dengan karakter non-huruf (CJK, emoji) ditolak meski memuat kata afirmatif", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);

  for (const answer of ["Ya, commit 不要", "Ya, commit ❌"]) {
    const pi = createMockPi();
    const logEntries: ViolationEntry[] = [];
    registerToolGuard(pi, createDeps([rule], logEntries));
    const ctx = createMockContextWithAskUser("Tolong rapikan kode ini", { answer });
    const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: `call_ask_cjk_${answer}`,
        toolName: "bash",
        input: { command: "git commit -m x" },
      } as any,
      ctx,
    );
    assert.equal(result?.block, true, `Jawaban "${answer}" harus diblokir`);
  }
});

test("AC-1c: Hasil ask_user dismissed (answer null) tetap memblokir dan dicatat", () => {
  const rule = parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);

  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([rule], logEntries));

  // Pertanyaan memuat kata commit, tetapi user menutupnya tanpa menjawab.
  const ctx = createMockContextWithAskUser("Tolong rapikan kode ini", {
    answer: null,
  });
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_ask_dismissed",
      toolName: "bash",
      input: { command: "git commit -m 'selesai'" },
    } as any,
    ctx,
  );

  assert.equal(result?.block, true, "Dismissed ask_user tidak boleh memberi izin");
  assert.equal(logEntries.length, 1, "Pemblokiran harus dicatat ke log");
  assert.equal(logEntries[0].action, "block");
});

test("AC-2: Write berkas yang memuat secret diblokir dan baris log TIDAK memuat excerpt (FR-10)", () => {
  const rule = parseRule(`---
name: secret-in-write
action: block
scope: tool:write
condition:
  - "(api[_-]?key|secret|token)\\s*[:=]\\s*['\"][A-Za-z0-9_-]{8,}['\"]"
---
Penyimpanan secret atau token sensitif ke berkas dilarang.
`);

  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  const deps = createDeps([rule], logEntries);
  registerToolGuard(pi, deps);

  const ctx = createMockContext("Buat berkas konfigurasi");
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_write_secret",
      toolName: "write",
      input: {
        path: ".env",
        content: "API_KEY='SuperSecretToken12345678'",
      },
    } as any,
    ctx,
  );

  assert.ok(result);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /Penyimpanan secret/);

  // Verifikasi log: TIDAK boleh ada kutipan secret sama sekali
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].rule, "secret-in-write");
  assert.equal(logEntries[0].action, "block");
  assert.equal(
    logEntries[0].excerpt,
    undefined,
    "Baris log untuk secret-in-write DILARANG memuat potongan isi (FR-10)",
  );
});

test("AC-3: Rule bertipe log pada tool hanya mencatat dan tidak memblokir eksekusi (FR-8)", () => {
  const rule = parseRule(`---
name: audit-read
action: log
scope: tool:read
condition:
  - "sensitive"
---
Pencatatan akses berkas sensitif.
`);

  const pi = createMockPi();
  const logEntries: ViolationEntry[] = [];
  const deps = createDeps([rule], logEntries);
  registerToolGuard(pi, deps);

  const ctx = createMockContext("Baca file konfigurasi");
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_read_1",
      toolName: "read",
      input: { path: "sensitive.txt" },
    } as any,
    ctx,
  );

  assert.equal(result, undefined, "Aksi log tidak boleh memblokir");
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].rule, "audit-read");
  assert.equal(logEntries[0].action, "log");
  assert.ok(logEntries[0].excerpt?.includes("sensitive"));
});

test("AC-4: Settle-gate menolak penutupan sekali bila ada mutasi tanpa verifikasi, dan penutupan kedua lolos", () => {
  const pi = createMockPi();
  const deps = createDeps([]);
  registerToolGuard(pi, deps);

  // Inisialisasi awal run
  pi.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "Ubah kode ini",
    systemPrompt: "",
    systemPromptOptions: {} as any,
  } as BeforeAgentStartEvent);

  // Simulasi mutasi via edit
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_edit",
      toolName: "edit",
      input: { path: "src/app.ts", edits: [] },
    } as any,
    createMockContext(),
  );

  const eventSettle1: AgentBeforeSettleEvent = {
    type: "agent_before_settle",
    outcome: "completed",
    continue: false,
    entries: [],
    context: {} as any,
  };

  // Settle pertama: harus ditolak satu kali dengan permintaan verifikasi
  const settleResult1 = pi.emit<
    AgentBeforeSettleEvent,
    AgentBeforeSettleEventResult
  >("agent_before_settle", eventSettle1);

  assert.ok(settleResult1);
  assert.equal(settleResult1?.continue, true);
  assert.equal(settleResult1?.entries?.length, 1);
  assert.equal(
    (settleResult1?.entries?.[0] as any)?.customType,
    "ttsr-settle-gate",
  );

  // Settle kedua (tanpa perintah verifikasi baru): harus lolos
  const eventSettle2: AgentBeforeSettleEvent = {
    type: "agent_before_settle",
    outcome: "completed",
    continue: false,
    entries: settleResult1?.entries ?? [],
    context: {} as any,
  };

  const settleResult2 = pi.emit<
    AgentBeforeSettleEvent,
    AgentBeforeSettleEventResult
  >("agent_before_settle", eventSettle2);

  assert.equal(
    settleResult2,
    undefined,
    "Penolakan kedua harus lolos agar tidak terjadi infinite loop",
  );
});

test("AC-4b: Mutasi diikuti oleh perintah verifikasi bash tidak ditolak saat settle", () => {
  const pi = createMockPi();
  const deps = createDeps([]);
  registerToolGuard(pi, deps);

  pi.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "Ubah dan uji",
    systemPrompt: "",
    systemPromptOptions: {} as any,
  } as BeforeAgentStartEvent);

  // 1. Mutasi dengan write
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_write",
      toolName: "write",
      input: { path: "src/utils.ts", content: "export const x = 1;" },
    } as any,
    createMockContext(),
  );

  // 2. Verifikasi dengan bash test
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_bash_test",
      toolName: "bash",
      input: { command: "npm test" },
    } as any,
    createMockContext(),
  );

  // 3. Settle pertama langsung lolos karena sudah ada verifikasi
  const eventSettle: AgentBeforeSettleEvent = {
    type: "agent_before_settle",
    outcome: "completed",
    continue: false,
    entries: [],
    context: {} as any,
  };

  const settleResult = pi.emit<
    AgentBeforeSettleEvent,
    AgentBeforeSettleEventResult
  >("agent_before_settle", eventSettle);

  assert.equal(
    settleResult,
    undefined,
    "Tidak boleh ditolak jika verifikasi sudah dijalankan",
  );
});

test("AC-5: Tanpa mutasi, settle-gate tidak melakukan apa-apa", () => {
  const pi = createMockPi();
  const deps = createDeps([]);
  registerToolGuard(pi, deps);

  pi.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "Hanya baca berkas",
    systemPrompt: "",
    systemPromptOptions: {} as any,
  } as BeforeAgentStartEvent);

  // Hanya memanggil read, tidak ada mutasi
  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_read_only",
      toolName: "read",
      input: { path: "README.md" },
    } as any,
    createMockContext(),
  );

  const eventSettle: AgentBeforeSettleEvent = {
    type: "agent_before_settle",
    outcome: "completed",
    continue: false,
    entries: [],
    context: {} as any,
  };

  const result = pi.emit<
    AgentBeforeSettleEvent,
    AgentBeforeSettleEventResult
  >("agent_before_settle", eventSettle);

  assert.equal(result, undefined, "Harus langsung lolos tanpa mutasi");
});

test("AC-6: Handler agent_before_settle lain tetap berjalan dan entri keduanya dipertahankan", () => {
  const pi = createMockPi();
  const deps = createDeps([]);

  // Handler pertama dari modul lain (misal: review reminder / failure-recovery)
  pi.on("agent_before_settle", (event: AgentBeforeSettleEvent) => {
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "other-handler",
          content: "Pesan dari handler lain",
          display: false,
        } as SessionBoundaryDraft,
      ],
      continue: false,
    };
  });

  // Daftarkan ttsr guard
  registerToolGuard(pi, deps);

  // Picu mutasi
  pi.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt: "Edit kode",
    systemPrompt: "",
    systemPromptOptions: {} as any,
  } as BeforeAgentStartEvent);

  pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: "call_hash_edit",
      toolName: "hash_edit",
      input: { path: "file.ts" },
    } as any,
    createMockContext(),
  );

  // Jalankan rantai handler agent_before_settle
  const handlers = pi.handlers.get("agent_before_settle") ?? [];
  let currentEvent: AgentBeforeSettleEvent = {
    type: "agent_before_settle",
    outcome: "completed",
    continue: false,
    entries: [],
    context: {} as any,
  };

  for (const h of handlers) {
    const res = h(currentEvent, {} as any);
    if (res) {
      currentEvent = {
        ...currentEvent,
        entries: res.entries ?? currentEvent.entries,
        continue: res.continue ?? currentEvent.continue,
      };
    }
  }

  // Kedua entri harus ada
  assert.equal(currentEvent.continue, true);
  assert.equal(currentEvent.entries.length, 2);
  const types = currentEvent.entries.map((e: any) => e.customType);
  assert.ok(types.includes("other-handler"), "Entri handler lain harus dipertahankan");
  assert.ok(types.includes("ttsr-settle-gate"), "Entri settle-gate harus ada");
});

test("AC-7: Exception di dalam handler ditangkap aman dan tidak keluar (NFR-2)", () => {
  const pi = createMockPi();
  // Deps yang melempar error sengaja
  const throwingDeps: TtsrDeps = {
    getRules: () => {
      throw new Error("Simulasi crash database rules");
    },
    log: () => {},
    isEnabled: () => true,
  };

  registerToolGuard(pi, throwingDeps);

  // tool_call tidak boleh throw
  assert.doesNotThrow(() => {
    pi.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "call_err",
        toolName: "bash",
        input: { command: "ls" },
      } as any,
      createMockContext(),
    );
  });

  // agent_before_settle tidak boleh throw
  assert.doesNotThrow(() => {
    pi.emit(
      "agent_before_settle",
      {
        type: "agent_before_settle",
        outcome: "completed",
        continue: false,
        entries: [],
        context: {} as any,
      } as any,
      createMockContext(),
    );
  });
});

test("Guard: secret-in-write bawaan tidak memblokir bash dan tetap memblokir write, edit, hash_edit", () => {
  // Mencegah dua kegagalan: false positive pada bash, dan hilangnya blokir pada tool penulisan.
  const rules = loadRules(new URL("./rules", import.meta.url).pathname);
  const secretRule = rules.find((r) => r.name === "secret-in-write");
  assert.ok(secretRule, "rule secret-in-write harus ada di direktori rules bawaan");

  const secretInput = { path: ".env", content: "API_KEY=abcdefgh12345678" };
  const cases: Array<{ toolName: string; input: unknown; blocked: boolean }> = [
    {
      toolName: "bash",
      input: { command: "node --test auth.test.ts # password: verifikasi-alur-login" },
      blocked: false,
    },
    { toolName: "write", input: secretInput, blocked: true },
    { toolName: "edit", input: secretInput, blocked: true },
    { toolName: "hash_edit", input: secretInput, blocked: true },
  ];

  for (const c of cases) {
    const pi = createMockPi();
    const logEntries: ViolationEntry[] = [];
    registerToolGuard(pi, createDeps([secretRule], logEntries));
    const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
      "tool_call",
      { type: "tool_call", toolCallId: `call_${c.toolName}`, toolName: c.toolName, input: c.input } as any,
      createMockContext("Tulis konfigurasi"),
    );
    const blockedByRule = result?.block === true && logEntries.some((e) => e.rule === "secret-in-write");
    assert.equal(blockedByRule, c.blocked, `tool ${c.toolName}: blocked harus ${c.blocked}`);
  }
});

function gitCommitRule(): Rule {
  return parseRule(`---
name: git-commit-push
action: block
scope: tool:bash
condition:
  - "git\\s+commit"
  - "git\\s+push"
unlessUserSays:
  - "\\b(commit|push)\\b"
---
Operasi commit atau push dilarang kecuali atas permintaan langsung user.
`);
}

function createBranchedContext(
  branch: any[],
  all: any[] = branch,
): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => all,
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
}

const bashCommit = (id: string, command = "git commit -m x") =>
  ({ type: "tool_call", toolCallId: id, toolName: "bash", input: { command } }) as any;

const askEntry = (answer: string | null, options?: string[], wasCustom = true) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolName: "ask_user",
    details: { question: "Commit sekarang?", answer, options, wasCustom },
  },
});

test("AC-8: Jawaban ask_user di cabang lain tidak memberi izin commit", () => {
  const pi = createMockPi();
  const logs: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([gitCommitRule()], logs));
  const userMsg = { type: "message", message: { role: "user", content: "Rapikan kode" } };
  const otherBranchApproval = askEntry("Ya, commit sekarang");
  const ctx = createBranchedContext([userMsg], [userMsg, otherBranchApproval]);
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>("tool_call", bashCommit("c_branch"), ctx);
  assert.equal(result?.block, true, "Jawaban di cabang lain tidak boleh membuka izin");
  assert.equal(logs.length, 1);
});

test("AC-8b: Jawaban ask_user di cabang aktif memberi izin commit", () => {
  const pi = createMockPi();
  const logs: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([gitCommitRule()], logs));
  const userMsg = { type: "message", message: { role: "user", content: "Rapikan kode" } };
  const ctx = createBranchedContext([userMsg, askEntry("Ya, commit sekarang")]);
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>("tool_call", bashCommit("c_active"), ctx);
  assert.equal(result, undefined, "Jawaban afirmatif di cabang aktif harus mengizinkan commit");
  assert.equal(logs.length, 0);
});

test("AC-8c: Penolakan ask_user terbaru membatalkan izin commit sebelumnya", () => {
  const pi = createMockPi();
  const logs: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([gitCommitRule()], logs));
  const userMsg = { type: "message", message: { role: "user", content: "Rapikan kode" } };
  const ctx = createBranchedContext([
    userMsg,
    askEntry("Ya, commit sekarang"),
    askEntry("Jangan commit", undefined, true),
  ]);
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>("tool_call", bashCommit("c_denied"), ctx);
  assert.equal(result?.block, true, "Penolakan terbaru harus membatalkan izin lama");
  assert.equal(logs.length, 1);
});

test("AC-8d: Jawaban ask_user ambigu (commit dan push untuk satu perintah majemuk) tidak memberi izin", () => {
  const pi = createMockPi();
  const logs: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([gitCommitRule()], logs));
  const userMsg = { type: "message", message: { role: "user", content: "Rapikan kode" } };
  const ctx = createBranchedContext([userMsg, askEntry("Ya, commit saja", ["Ya, commit saja"], false)]);
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    bashCommit("c_partial", "git commit -m x && git push"),
    ctx,
  );
  assert.equal(result?.block, true, "Izin commit saja tidak boleh membuka git push");
});

test("AC-8e: Ya pada ask_user yang menyebut commit dan push mengizinkan perintah commit && push", () => {
  const pi = createMockPi();
  const logs: ViolationEntry[] = [];
  registerToolGuard(pi, createDeps([gitCommitRule()], logs));
  const userMsg = { type: "message", message: { role: "user", content: "Rapikan kode" } };
  const ctx = createBranchedContext([userMsg, askEntry("Ya, commit dan push sekarang")]);
  const result = pi.emit<ToolCallEvent, ToolCallEventResult>(
    "tool_call",
    bashCommit("c_both", "git commit -m x && git push"),
    ctx,
  );
  assert.equal(result, undefined, "Ya yang mencakup kedua operasi harus mengizinkan keduanya");
});
