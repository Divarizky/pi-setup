#!/usr/bin/env node
/**
 * pre-review-gate.mjs — Stack-agnostic deterministic pre-review gate.
 *
 * Detects project manifest (or falls back to touched-file syntax checks),
 * runs verification commands, and exits 0 only when all checks pass.
 * Keeps output concise to avoid flooding LLM context windows.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const MAX_FAILURE_LINES = 60;

function parseArgs(argv) {
  const args = { cwd: process.cwd(), cmd: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && argv[i + 1]) {
      args.cwd = resolve(argv[++i]);
    } else if (argv[i] === "--cmd" && argv[i + 1]) {
      args.cmd = argv[++i];
    }
  }
  return args;
}

function commandExists(cmd) {
  const res = spawnSync("which", [cmd], { encoding: "utf-8" });
  return res.status === 0;
}

function runCheck(label, command, cwd) {
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (res.status === 0) {
    console.log(`[PASS] ${label}`);
    return true;
  }

  console.error(`[FAIL] ${label} (exit ${res.status ?? 1})`);
  const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  if (combined) {
    const lines = combined.split("\n");
    const tail = lines.slice(-MAX_FAILURE_LINES);
    if (lines.length > MAX_FAILURE_LINES) {
      console.error(`... (${lines.length - MAX_FAILURE_LINES} earlier lines omitted) ...`);
    }
    console.error(tail.join("\n"));
  }
  return false;
}

function detectNodeChecks(cwd) {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return [{ label: "package.json parse", cmd: "node -e \"JSON.parse(require('fs').readFileSync('package.json','utf8'))\"" }];
  }

  const scripts = pkg.scripts ?? {};
  const checks = [];

  for (const key of ["typecheck", "check", "lint", "test"]) {
    const val = scripts[key];
    if (!val || typeof val !== "string") continue;
    if (key === "test" && val.includes("no test specified")) continue;
    checks.push({ label: `npm run ${key}`, cmd: `npm run ${key}` });
  }

  if (!scripts.typecheck && existsSync(join(cwd, "tsconfig.json")) && commandExists("npx")) {
    checks.unshift({ label: "tsc --noEmit", cmd: "npx tsc --noEmit" });
  }

  return checks;
}

function detectPythonChecks(cwd) {
  const hasPy = ["pyproject.toml", "setup.py", "requirements.txt"].some((f) => existsSync(join(cwd, f)));
  if (!hasPy) return null;

  const checks = [];
  if (commandExists("ruff")) checks.push({ label: "ruff check", cmd: "ruff check ." });
  if (commandExists("mypy")) checks.push({ label: "mypy", cmd: "mypy ." });
  if (commandExists("pytest")) checks.push({ label: "pytest", cmd: "pytest -q" });
  return checks;
}

function detectGoChecks(cwd) {
  if (!existsSync(join(cwd, "go.mod"))) return null;
  return [
    { label: "go vet", cmd: "go vet ./..." },
    { label: "go test", cmd: "go test ./..." },
  ];
}

function detectRustChecks(cwd) {
  if (!existsSync(join(cwd, "Cargo.toml"))) return null;
  return [
    { label: "cargo check", cmd: "cargo check" },
    { label: "cargo test", cmd: "cargo test" },
  ];
}

function getTouchedFiles(cwd) {
  try {
    const out = execSync("git status --porcelain=v1", { cwd, encoding: "utf-8" });
    return out
      .split("\n")
      .filter((line) => line.length > 3)
      .filter((line) => !line.startsWith(" D") && !line.startsWith("D "))
      .map((line) => line.slice(3).trim().replace(/^.* -> /, ""));
  } catch {
    return [];
  }
}

function detectFallbackChecks(cwd) {
  const checks = [];
  const files = getTouchedFiles(cwd);

  for (const file of files) {
    const abs = join(cwd, file);
    if (!existsSync(abs)) continue;
    const ext = extname(file);
    if (ext === ".py" && commandExists("python3")) {
      checks.push({ label: `py_compile ${file}`, cmd: `python3 -m py_compile ${JSON.stringify(file)}` });
    } else if ((ext === ".js" || ext === ".mjs" || ext === ".cjs") && commandExists("node")) {
      checks.push({ label: `node --check ${file}`, cmd: `node --check ${JSON.stringify(file)}` });
    } else if (ext === ".sh" && commandExists("bash")) {
      checks.push({ label: `bash -n ${file}`, cmd: `bash -n ${JSON.stringify(file)}` });
    }
  }

  if (existsSync(join(cwd, ".git"))) {
    checks.push({ label: "git diff --check", cmd: "git diff --check" });
  }

  return checks;
}

function main() {
  const { cwd, cmd } = parseArgs(process.argv.slice(2));

  if (cmd) {
    const ok = runCheck(`custom: ${cmd}`, cmd, cwd);
    process.exit(ok ? 0 : 1);
  }

  const checks =
    detectNodeChecks(cwd) ??
    detectPythonChecks(cwd) ??
    detectGoChecks(cwd) ??
    detectRustChecks(cwd) ??
    [];

  const allChecks = checks.length > 0 ? checks : detectFallbackChecks(cwd);

  if (allChecks.length === 0) {
    console.log("[PASS] No manifest checks or touched files to verify.");
    process.exit(0);
  }

  for (const check of allChecks) {
    const ok = runCheck(check.label, check.cmd, cwd);
    if (!ok) {
      console.error("\nGATE FAILED: Fix errors above before staging or code-review.");
      process.exit(1);
    }
  }

  console.log(`\nGATE PASSED (${allChecks.length}/${allChecks.length} checks).`);
  process.exit(0);
}

main();
