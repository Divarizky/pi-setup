import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialState,
  DEFAULT_DOC_EXTENSIONS,
  DEFAULT_VALIDATION_PATTERNS,
  evaluateRun,
  isDocumentFile,
  isValidationCommand,
  recordEdit,
  recordValidation,
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
    "npm run check 2>&1 | tail -5",
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

