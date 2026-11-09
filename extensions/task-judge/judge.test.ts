import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createInitialState,
  DEFAULT_DOC_EXTENSIONS,
  DEFAULT_VALIDATION_PATTERNS,
  evaluateRun,
  extractShellCommand,
  isDocumentFile,
  isTrackedEditPath,
  isValidationCommand,
  recordEdit,
  recordValidation,
  resolveValidationSuccess,
} from "./judge.ts";

test("run tanpa edit menghasilkan dikecualikan", () => {
  const state = createInitialState();
  const result = evaluateRun(state);
  assert.equal(result.decision, "dikecualikan");
  assert.equal(result.editCount, 0);
  assert.equal(result.hasSuccessfulValidation, false);
});

test("hanya edit dokumen (.md, .mdx, .txt, .rst) menghasilkan dikecualikan", () => {
  let state = createInitialState();
  state = recordEdit(state, "README.md");
  state = recordEdit(state, "docs/guide.mdx");
  state = recordEdit(state, "notes.TXT");
  state = recordEdit(state, "index.rst");

  const result = evaluateRun(state);
  assert.equal(result.decision, "dikecualikan");
  assert.equal(result.editCount, 4);
  assert.equal(result.hasSuccessfulValidation, false);
});

test("edit kode tanpa validasi menghasilkan tidak terverifikasi", () => {
  let state = createInitialState();
  state = recordEdit(state, "src/index.ts");

  const result = evaluateRun(state);
  assert.equal(result.decision, "tidak_terverifikasi");
  assert.equal(result.editCount, 1);
  assert.equal(result.hasSuccessfulValidation, false);
  assert.equal(result.unverifiedReason, "no_successful_validation");
});

test("edit kode lalu validasi sukses menghasilkan terverifikasi", () => {
  let state = createInitialState();
  state = recordEdit(state, "src/index.ts");
  state = recordValidation(state, "npm test", true);

  const result = evaluateRun(state);
  assert.equal(result.decision, "terverifikasi");
  assert.equal(result.editCount, 1);
  assert.equal(result.hasSuccessfulValidation, true);
});

test("validasi sukses sebelum edit terakhir tetap tidak terverifikasi", () => {
  let state = createInitialState();
  state = recordEdit(state, "src/first.ts");
  state = recordValidation(state, "npm test", true);
  state = recordEdit(state, "src/second.ts");

  const result = evaluateRun(state);
  assert.equal(result.decision, "tidak_terverifikasi");
  assert.equal(result.editCount, 2);
  assert.equal(result.hasSuccessfulValidation, true);
  assert.equal(result.unverifiedReason, "validation_before_last_edit");
});

test("validasi gagal tidak dihitung sebagai terverifikasi", () => {
  let state = createInitialState();
  state = recordEdit(state, "src/index.ts");
  state = recordValidation(state, "npm test", false);

  const result = evaluateRun(state);
  assert.equal(result.decision, "tidak_terverifikasi");
  assert.equal(result.editCount, 1);
  assert.equal(result.hasSuccessfulValidation, false);
  assert.equal(result.unverifiedReason, "no_successful_validation");
});

test("edit dokumen setelah validasi sukses tidak membatalkan status terverifikasi", () => {
  let state = createInitialState();
  state = recordEdit(state, "src/index.ts");
  state = recordValidation(state, "npm run check", true);
  state = recordEdit(state, "README.md");

  const result = evaluateRun(state);
  assert.equal(result.decision, "terverifikasi");
  assert.equal(result.editCount, 2);
  assert.equal(result.hasSuccessfulValidation, true);
});

test("fail-closed pada state yang rusak atau tidak lengkap", () => {
  // @ts-expect-error Pengujian input rusak
  const resultNull = evaluateRun(null);
  assert.equal(resultNull.decision, "dikecualikan");
  assert.equal(resultNull.unverifiedReason, "invalid_state");

  // @ts-expect-error Pengujian input rusak
  const resultCorrupt = evaluateRun({ edits: "bukan-array" });
  assert.equal(resultCorrupt.decision, "dikecualikan");
  assert.equal(resultCorrupt.unverifiedReason, "invalid_state");
});

test("pola perintah validasi default cocok dengan contoh nyata", () => {
  const matchingCommands = [
    "npm run check",
    "npm run test",
    "npm run lint",
    "npm run build",
    "npm test",
    "npm test -- -u",
    "npx tsc",
    "npx tsc --noEmit",
    "tsc --noEmit",
    "node --test",
    "node --test --experimental-strip-types judge.test.ts",
    "pytest",
    "pytest -v tests/",
    "py -m pytest",
    "python -m pytest",
    "python3 -m pytest",
    "gradlew test",
    "./gradlew test",
    "gradlew.bat build",
    "gradlew check",
    "cargo test",
    "cargo check",
    "cargo build",
    "go test",
    "go test ./...",
  ];

  for (const cmd of matchingCommands) {
    assert.equal(
      isValidationCommand(cmd),
      true,
      `Harusnya cocok dengan pola validasi: ${cmd}`,
    );
  }
});

test("pola perintah validasi default tidak cocok dengan perintah non-validasi dan false positives", () => {
  const nonMatchingCommands = [
    "ls",
    "ls -la",
    "git status",
    "git diff",
    "git commit -m 'test'",
    "npm install",
    "npm run dev",
    "npm run start",
    "cat README.md",
    "echo 'hello world'",
    // Kasus false positive yang disebutkan owner:
    "echo npm test",
    "grep -r 'pytest' .",
    'git commit -m "run npm run check later"',
    "cat package.json # npm test",
  ];

  for (const cmd of nonMatchingCommands) {
    assert.equal(
      isValidationCommand(cmd),
      false,
      `Tidak boleh cocok dengan pola validasi: ${cmd}`,
    );
  }
});

test("pola perintah validasi cocok untuk chaining, pipe, dan multi-line", () => {
  const trueCases = [
    "npm run check",
    "cd x && npm run check",
    "set -o pipefail; npm run check 2>&1 | tail -5",
    "git diff | head; npm test",
    "node --test a.test.ts",
    "npm test && echo ok",
  ];

  for (const cmd of trueCases) {
    assert.equal(
      isValidationCommand(cmd),
      true,
      `Harusnya cocok sebagai validasi: ${cmd}`,
    );
  }
});

test("validasi yang dipipe ke perintah aktif non-filter tanpa pipefail tidak dihitung", () => {
  for (const cmd of [
    "npm test | node runner.js",
    "npm test | rm -rf dist",
    "npm test | tail -5 | rm -rf dist",
    "npm test | grep x | sh",
  ]) {
    assert.equal(isValidationCommand(cmd), false, `Tidak boleh dihitung: ${cmd}`);
  }
});

test("validasi yang dipipe ke filter pasif tetap diakui tanpa pipefail", () => {
  for (const cmd of [
    "node --test tests/*.test.js 2>&1 | tail -5",
    'npm test 2>&1 | grep -E "^# (pass|fail)"',
    "npm run check | head -n 20",
    "python -m pytest 2>&1 | cat",
    "npm run check 2>&1 | tail -5",
    "cd x && pytest -q | tail -3",
    "npm test | grep -v warn | wc -l",
  ]) {
    assert.equal(isValidationCommand(cmd), true, `Harusnya cocok: ${cmd}`);
  }
});

test("validasi yang dipipe tetap diakui jika pipefail atau PIPESTATUS diperiksa", () => {
  assert.equal(
    isValidationCommand("set -o pipefail; npm test | node runner.js"),
    true,
  );
  assert.equal(
    isValidationCommand('npm test | node runner.js; echo "${PIPESTATUS[0]}"'),
    true,
  );
  assert.equal(
    isValidationCommand("npm test | node runner.js; echo $pipestatus[1]"),
    true,
  );
});

test("validasi yang dipipe ke sed -i tidak dihitung sebagai filter pasif", () => {
  assert.equal(
    isValidationCommand("npm test | sed -i 's/a/b/' log.txt"),
    false,
  );
});

test("node --check diakui sebagai perintah validasi", () => {
  for (const cmd of [
    "node --check index.js",
    "node --check index.js 2>&1 | tail -2",
  ]) {
    assert.equal(isValidationCommand(cmd), true, `Harusnya cocok: ${cmd}`);
  }
});

test("perintah validasi nyata dari sesi Pi Windows dikenali", () => {
  for (const cmd of [
    "npm.cmd run test:task-judge",
    "npm.cmd test",
    'cmd /c "node --test tests/dashboard*.test.js"',
    "cmd /c npm test",
    "timeout 120 npm test",
    "npm --prefix extensions/task-judge test",
    "py -3 -m pytest",
    "./gradlew :app:testDebugUnitTest",
    "pnpm test",
    "npx vitest run",
  ]) {
    assert.equal(isValidationCommand(cmd), true, `Harusnya cocok: ${cmd}`);
  }
  assert.equal(isValidationCommand("cmd /c dir"), false);
  assert.equal(isValidationCommand("timeout 5 echo npm test"), false);
});

test("extractShellCommand membaca bash dan execute shell, mengabaikan runtime non-shell", () => {
  assert.equal(extractShellCommand("bash", { command: "npm test" }), "npm test");
  assert.equal(extractShellCommand("execute", { script: "npm test" }), "npm test");
  assert.equal(
    extractShellCommand("execute", { runtime: "powershell", script: "npm test" }),
    "npm test",
  );
  assert.equal(
    extractShellCommand("execute", { runtime: "python", script: "npm test" }),
    undefined,
  );
  assert.equal(extractShellCommand("read", { command: "npm test" }), undefined);
});

test("edit di luar cwd atau di dalam .git tidak dihitung sebagai edit proyek", () => {
  const cwd = process.platform === "win32" ? "C:\\proj\\app" : "/proj/app";
  assert.equal(isTrackedEditPath("src/a.ts", cwd), true);
  assert.equal(isTrackedEditPath("../other/a.ts", cwd), false);
  assert.equal(
    isTrackedEditPath(process.platform === "win32" ? "C:\\tmp\\x.js" : "/tmp/x.js", cwd),
    false,
  );
  assert.equal(isTrackedEditPath(".git/worktrees/T1/ultron-os/STATUS", cwd), false);
});

test("pola perintah validasi sadar tanda kutip yang memuat pemisah shell", () => {
  // Simbol && atau ; di dalam tanda kutip bukan pemisah segmen
  assert.equal(
    isValidationCommand('git commit -m "fix && npm test"'),
    false,
    "&& di dalam kutip tidak boleh memicu validasi",
  );
  assert.equal(
    isValidationCommand("git commit -m 'test; npm test'"),
    false,
    "; di dalam kutip tidak boleh memicu validasi",
  );
  assert.equal(
    isValidationCommand('echo "npm test && cargo test"'),
    false,
    "perintah di dalam echo ber-quote tidak boleh dihitung",
  );
  assert.equal(
    isValidationCommand('node -e "const x = 1; console.log(x);" && npm test'),
    true,
    "; di dalam -e string tidak boleh memotong sebelum && npm test",
  );
});

test("pola perintah validasi Gradle mendukung task spesifik (test, build, check, assemble, lint)", () => {
  const gradleTrueCases = [
    "./gradlew testDebugUnitTest",
    "gradlew.bat testDebugUnitTest",
    ".\\gradlew testDebugUnitTest",
    "gradlew assembleDebug",
    "./gradlew lintDebug",
    "gradlew test",
    "./gradlew test",
    "gradlew.bat build",
    "gradlew check",
  ];

  for (const cmd of gradleTrueCases) {
    assert.equal(
      isValidationCommand(cmd),
      true,
      `Harusnya cocok sebagai validasi Gradle: ${cmd}`,
    );
  }

  const gradleFalseCases = [
    "./gradlew clean",
    "./gradlew tasks",
    "echo gradlew testDebugUnitTest",
    "cat gradlew # testDebugUnitTest",
  ];

  for (const cmd of gradleFalseCases) {
    assert.equal(
      isValidationCommand(cmd),
      false,
      `Tidak boleh cocok sebagai validasi Gradle: ${cmd}`,
    );
  }
});



test("pola runner validasi tambahan dikenali sebagai validasi", () => {
  const runnerCases = [
    "mvn test",
    "mvnw verify",
    "./mvnw.cmd test",
    "dotnet test",
    "make test",
    "make check",
    "make lint",
    "make verify",
    "phpunit",
    "vendor/bin/phpunit --filter Foo",
    "rspec spec/models",
    "bundle exec rspec",
    "mix test",
    "swift test",
    "flutter test",
    "deno test",
    "deno check main.ts",
    "deno lint",
    "ctest --output-on-failure",
    "tox -e py312",
    "eslint src",
    "npx eslint .",
    "ruff check .",
    "mypy src",
    "biome check .",
    "npx biome ci",
    "prettier --check .",
    "npx prettier --check src",
    "python -m unittest",
    "python3 -m unittest discover",
    "bun test",
  ];

  for (const cmd of runnerCases) {
    assert.equal(
      isValidationCommand(cmd),
      true,
      `Harusnya cocok sebagai validasi: ${cmd}`,
    );
  }
});

test("perintah baca-saja yang menyebut runner baru tidak dihitung sebagai validasi", () => {
  const readOnlyCases = [
    "echo test",
    "echo mvn test",
    "echo make test",
    "echo eslint .",
    "cat tests.log",
    "cat mypy.ini",
    "ls tests/",
    "ls ctest",
    "grep -r pytest .",
    "grep -rn mvn test pom.xml",
    "rg eslint src",
    "make --version",
    "make build",
    "prettier --write .",
    "ruff format .",
    "bun run dev",
    "dotnet build",
  ];

  for (const cmd of readOnlyCases) {
    assert.equal(
      isValidationCommand(cmd),
      false,
      `Tidak boleh dihitung sebagai validasi: ${cmd}`,
    );
  }
});

test("dukungan konfigurasi kustom untuk docExtensions dan validationPatterns", () => {
  assert.equal(isDocumentFile("foo.custom", [".custom"]), true);
  assert.equal(isDocumentFile("foo.md", [".custom"]), false);

  const customPatterns = [String.raw`\bvitest\b`];
  assert.equal(isValidationCommand("vitest run", customPatterns), true);
  assert.equal(isValidationCommand("npm test", customPatterns), false);

  let state = createInitialState();
  state = recordEdit(state, "foo.custom");
  const result = evaluateRun(state, { docExtensions: [".custom"] });
  assert.equal(result.decision, "dikecualikan");
});

test("logger: appendJudgeLog menulis baris JSON dengan struktur yang valid", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { appendJudgeLog } = await import("./logger.ts");

  const tmpFile = path.join(
    os.tmpdir(),
    `task-judge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  );

  try {
    appendJudgeLog(
      {
        timestamp: "2026-03-30T10:00:00.000Z",
        sessionId: "sess-123",
        decision: "tidak_terverifikasi",
        editCount: 3,
        hasSuccessfulValidation: false,
        mode: "warn",
      },
      tmpFile,
    );

    assert.equal(fs.existsSync(tmpFile), true);
    const content = fs.readFileSync(tmpFile, "utf-8").trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.sessionId, "sess-123");
    assert.equal(parsed.decision, "tidak_terverifikasi");
    assert.equal(parsed.editCount, 3);
    assert.equal(parsed.hasSuccessfulValidation, false);
    assert.equal(parsed.mode, "warn");
    assert.equal(parsed.timestamp, "2026-03-30T10:00:00.000Z");
    assert.equal("command" in parsed, false);
    assert.equal("path" in parsed, false);
  } finally {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  }
});


function withTaskJudgeConfig<T>(
  config: string | null,
  run: () => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-judge-cfg-"));
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    if (config !== null) {
      fs.mkdirSync(path.join(dir, "task-judge"), { recursive: true });
      fs.writeFileSync(path.join(dir, "task-judge", "config.json"), config);
    }
    process.env.XDG_CONFIG_HOME = dir;
    return run();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("getJudgeMode mengenali mode enforce dari config", async () => {
  const { getJudgeMode } = await import("./config.ts");
  const mode = withTaskJudgeConfig('{"mode":"enforce"}', () => getJudgeMode());
  assert.equal(mode, "enforce");
});

test("getJudgeMode mengembalikan off dan warn untuk nilai yang dikenal", async () => {
  const { getJudgeMode } = await import("./config.ts");
  assert.equal(withTaskJudgeConfig('{"mode":"off"}', () => getJudgeMode()), "off");
  assert.equal(withTaskJudgeConfig('{"mode":"warn"}', () => getJudgeMode()), "warn");
});

test("getJudgeMode fallback ke warn untuk mode tidak valid atau kosong", async () => {
  const { getJudgeMode } = await import("./config.ts");
  assert.equal(withTaskJudgeConfig('{"mode":"ENFORCE"}', () => getJudgeMode()), "warn");
  assert.equal(withTaskJudgeConfig('{"mode":"strict"}', () => getJudgeMode()), "warn");
  assert.equal(withTaskJudgeConfig('{"mode":42}', () => getJudgeMode()), "warn");
  assert.equal(withTaskJudgeConfig("{}", () => getJudgeMode()), "warn");
  assert.equal(withTaskJudgeConfig(null, () => getJudgeMode()), "warn");
});

test("getPrewalkTemplate membaca templates.json dan memuat tiga cek verifikasi", async () => {
  const { getPrewalkTemplate } = await import("./config.ts");
  const text = getPrewalkTemplate();
  assert.match(text, /Konsistensi Kontrak & State/);
  assert.match(text, /Batasan Lingkup \(Scope Isolation\)/);
  assert.match(text, /Bukti Validasi Nyata/);
});

test("readPrewalkTemplate fail-safe ke fallback saat berkas hilang atau rusak", async () => {
  const { readPrewalkTemplate } = await import("./config.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-judge-tpl-"));
  try {
    const missing = readPrewalkTemplate(path.join(dir, "absent.json"));
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    const brokenText = readPrewalkTemplate(broken);
    const empty = path.join(dir, "empty.json");
    fs.writeFileSync(empty, JSON.stringify({ prewalkChecklist: "   " }));
    const emptyText = readPrewalkTemplate(empty);
    assert.equal(missing, brokenText);
    assert.equal(missing, emptyText);
    assert.match(missing, /MUST menjalankan validasi/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type JudgeHandler = (event: any, ctx: any) => unknown;

/** Memuat extension terhadap pi palsu dan mengembalikan handler yang terdaftar. */
async function loadTaskJudgeHandlers(): Promise<Record<string, JudgeHandler>> {
  const { default: taskJudgeExtension } = await import("./index.ts");
  const handlers: Record<string, JudgeHandler> = {};
  taskJudgeExtension({
    on: (name: string, handler: JudgeHandler) => {
      handlers[name] = handler;
    },
  } as never);
  return handlers;
}

/** Menjalankan fungsi dengan config mode dan direktori log sementara, lalu memulihkan env. */
async function withJudgeSandbox<T>(
  mode: string,
  run: (logPath: string) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-judge-hook-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    fs.mkdirSync(path.join(dir, "config", "task-judge"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config", "task-judge", "config.json"),
      JSON.stringify({ mode }),
    );
    process.env.XDG_CONFIG_HOME = path.join(dir, "config");
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
    return await run(path.join(dir, "agent", "task-judge.log"));
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeCtx(sid: string) {
  const notices: Array<{ message: string; type?: string }> = [];
  return {
    notices,
    ctx: {
      cwd: "/tmp/task-judge-hook-project",
      sessionManager: {
        getSessionId: () => sid,
        getHeader: () => ({}),
      },
      ui: {
        notify: (message: string, type?: string) => notices.push({ message, type }),
      },
    },
  };
}

/** Satu edit kode tanpa validasi sesudahnya: keputusan tidak_terverifikasi. */
async function runUnverifiedEdit(handlers: Record<string, JudgeHandler>, ctx: unknown) {
  await handlers.agent_start({ type: "agent_start" }, ctx);
  await handlers.tool_result(
    { toolName: "edit", input: { path: "src/app.ts" }, isError: false },
    ctx,
  );
}

function settleEvent(entries: unknown[] = []) {
  return {
    type: "agent_before_settle",
    outcome: "completed",
    entries,
    continue: false,
    context: { llmMessages: [], contextMessages: [] },
  };
}

test("hook enforce menolak settle dengan continue true dan memuat checklist prewalk", async () => {
  await withJudgeSandbox("enforce", async () => {
    const handlers = await loadTaskJudgeHandlers();
    const { ctx, notices } = makeCtx("sess-enforce");
    await runUnverifiedEdit(handlers, ctx);
    const existing = { type: "custom", customType: "other", data: 1 };
    const result = (await handlers.agent_before_settle(settleEvent([existing]), ctx)) as any;

    assert.equal(result.continue, true);
    assert.equal(result.entries[0], existing);
    const enforcement = result.entries[1];
    assert.equal(enforcement.type, "custom_message");
    assert.equal(enforcement.customType, "task-judge-enforcement");
    assert.match(enforcement.content, /Mode Enforce/);
    assert.match(enforcement.content, /Konsistensi Kontrak & State/);
    assert.match(enforcement.content, /Bukti Validasi Nyata/);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "error");
  });
});

test("hook warn hanya menampilkan peringatan dan tidak menolak settle", async () => {
  await withJudgeSandbox("warn", async () => {
    const handlers = await loadTaskJudgeHandlers();
    const { ctx, notices } = makeCtx("sess-warn");
    await runUnverifiedEdit(handlers, ctx);
    const result = await handlers.agent_before_settle(settleEvent(), ctx);

    assert.equal(result, undefined);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "warning");
  });
});

test("hook off tidak menampilkan notifikasi dan tidak menolak settle", async () => {
  await withJudgeSandbox("off", async () => {
    const handlers = await loadTaskJudgeHandlers();
    const { ctx, notices } = makeCtx("sess-off");
    await runUnverifiedEdit(handlers, ctx);
    const result = await handlers.agent_before_settle(settleEvent(), ctx);

    assert.equal(result, undefined);
    assert.equal(notices.length, 0);
  });
});

test("hook enforce berhenti menolak setelah batas retry tercapai", async () => {
  await withJudgeSandbox("enforce", async () => {
    const handlers = await loadTaskJudgeHandlers();
    const { ctx } = makeCtx("sess-loop");
    await runUnverifiedEdit(handlers, ctx);

    const results: any[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await handlers.agent_before_settle(settleEvent(), ctx));
    }
    const continued = results.filter((r) => r?.continue === true).length;
    assert.equal(continued, 2);
    assert.equal(results[2], undefined);
    assert.equal(results[4], undefined);
  });
});

test("hitungan retry direset oleh prompt user baru tetapi tidak oleh continuation", async () => {
  await withJudgeSandbox("enforce", async () => {
    const handlers = await loadTaskJudgeHandlers();
    const { ctx } = makeCtx("sess-reset");
    await runUnverifiedEdit(handlers, ctx);
    await handlers.agent_before_settle(settleEvent(), ctx);
    await handlers.agent_before_settle(settleEvent(), ctx);
    assert.equal(await handlers.agent_before_settle(settleEvent(), ctx), undefined);

    // Continuation Pi memancarkan agent_start lagi; counter tidak boleh ikut reset.
    // agent_start mengosongkan state, jadi edit dicatat ulang agar keputusan tetap tidak_terverifikasi.
    await runUnverifiedEdit(handlers, ctx);
    assert.equal(await handlers.agent_before_settle(settleEvent(), ctx), undefined);

    // Prompt custom tidak memulai budget baru.
    await handlers.before_agent_start({ messageType: "custom" }, ctx);
    await runUnverifiedEdit(handlers, ctx);
    assert.equal(await handlers.agent_before_settle(settleEvent(), ctx), undefined);

    // Prompt user baru memulai budget retry baru.
    await handlers.before_agent_start({ messageType: "user" }, ctx);
    await runUnverifiedEdit(handlers, ctx);
    const afterUserPrompt = (await handlers.agent_before_settle(settleEvent(), ctx)) as any;
    assert.equal(afterUserPrompt?.continue, true);
  });
});

test("hook enforce fail-open saat handler melempar error", async () => {
  await withJudgeSandbox("enforce", async () => {
    const handlers = await loadTaskJudgeHandlers();
    const { ctx } = makeCtx("sess-failopen");
    await runUnverifiedEdit(handlers, ctx);
    const brokenCtx = {
      ...ctx,
      ui: {
        notify: () => {
          throw new Error("ui rusak");
        },
      },
    };
    const result = await handlers.agent_before_settle(settleEvent(), brokenCtx);
    assert.equal(result, undefined);
  });
});

test("validasi dipipe tanpa pipefail gagal dicatat gagal bila output memuat penanda kegagalan", () => {
  const piped = "node --check broken.js 2>&1 | tail -3";
  assert.equal(
    resolveValidationSuccess(piped, false, "SyntaxError: Unexpected token"),
    false,
  );
  assert.equal(
    resolveValidationSuccess("node --test t.js 2>&1 | tail -5", false, "# fail 2"),
    false,
  );
  assert.equal(resolveValidationSuccess(piped, false, ""), true);
});

test("pipefail atau PIPESTATUS membuat exit code dipercaya, tanpa membaca output", () => {
  assert.equal(
    resolveValidationSuccess("set -o pipefail; npm test | tail", false, "# fail 2"),
    true,
  );
  assert.equal(resolveValidationSuccess("npm test", true, ""), false);
});

test("pola kegagalan runner go/gradle/kompilasi juga dikenali pada pipeline tanpa pipefail", () => {
  assert.equal(
    resolveValidationSuccess("go test ./... | grep FAIL", false, "--- FAIL: TestSomething (0.01s)"),
    false,
  );
  assert.equal(
    resolveValidationSuccess("./gradlew test | tail", false, "BUILD FAILED in 2s"),
    false,
  );
});
