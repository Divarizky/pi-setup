import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectProjectValidationPatterns,
  escapeRegex,
} from "./project-validation.ts";

function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-judge-pv-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
  }
  return dir;
}

function matchesAny(patterns: string[], command: string): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern}`).test(command));
}

const readUtf8 = (file: string): string => fs.readFileSync(file, "utf-8");

test("script verify di package.json cocok dengan npm run verify", () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ scripts: { verify: "node verify.js" } }),
  });
  try {
    const patterns = detectProjectValidationPatterns(dir, readUtf8);
    assert.equal(matchesAny(patterns, "npm run verify"), true);
    assert.equal(matchesAny(patterns, "pnpm run verify --silent"), true);
    assert.equal(matchesAny(patterns, "npm run verifyall"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("script yang tidak termasuk daftar tidak menghasilkan pola", () => {
  const dir = makeProject({
    "package.json": JSON.stringify({ scripts: { start: "node index.js" } }),
  });
  try {
    assert.deepEqual(detectProjectValidationPatterns(dir, readUtf8), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Makefile dengan target test cocok dengan make test", () => {
  const dir = makeProject({
    Makefile: "build:\n\tcc main.c\n\ntest: build\n\t./run-tests\n",
  });
  try {
    const patterns = detectProjectValidationPatterns(dir, readUtf8);
    assert.equal(matchesAny(patterns, "make test"), true);
    assert.equal(matchesAny(patterns, "make tests"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("justfile dengan recipe check cocok dengan just check", () => {
  const dir = makeProject({
    justfile: "check: lint\n    cargo check\n",
  });
  try {
    const patterns = detectProjectValidationPatterns(dir, readUtf8);
    assert.equal(matchesAny(patterns, "just check"), true);
    assert.equal(matchesAny(patterns, "just checkout"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pyproject dengan [tool.pytest] menghasilkan pola pytest", () => {
  const dir = makeProject({
    "pyproject.toml": "[project]\nname = \"x\"\n\n[tool.pytest.ini_options]\naddopts = \"-q\"\n",
  });
  try {
    const patterns = detectProjectValidationPatterns(dir, readUtf8);
    assert.equal(matchesAny(patterns, "pytest -q"), true);
    assert.equal(matchesAny(patterns, "ruff check ."), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json rusak menghasilkan daftar kosong tanpa melempar", () => {
  const dir = makeProject({ "package.json": "{ \"scripts\": { \"verify\": " });
  try {
    assert.deepEqual(detectProjectValidationPatterns(dir, readUtf8), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("direktori tanpa berkas konfigurasi menghasilkan daftar kosong", () => {
  const dir = makeProject({});
  try {
    assert.deepEqual(detectProjectValidationPatterns(dir, readUtf8), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("error baca dari readFile menghasilkan daftar kosong tanpa melempar", () => {
  const failingRead = (): string => {
    throw new Error("EACCES");
  };
  assert.deepEqual(detectProjectValidationPatterns("/proyek/fiktif", failingRead), []);
});

test("nama target dengan karakter regex khusus di-escape dan tidak merusak pola", () => {
  const escaped = escapeRegex("a.b+c(d)");
  assert.equal(new RegExp(`^${escaped}$`).test("a.b+c(d)"), true);
  assert.equal(new RegExp(`^${escaped}$`).test("axbbc(d)"), false);

  const dir = makeProject({
    Makefile: "test.*: x\n\ntest: x\n",
    justfile: "verify+x: y\n",
  });
  try {
    const patterns = detectProjectValidationPatterns(dir, readUtf8);
    assert.equal(matchesAny(patterns, "make test"), true);
    assert.equal(matchesAny(patterns, "just verify+x"), false);
    assert.doesNotThrow(() => patterns.forEach((p) => new RegExp(p)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
