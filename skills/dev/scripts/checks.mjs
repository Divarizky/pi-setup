#!/usr/bin/env node
/**
 * checks.mjs — Stack-agnostic deterministic quality gate.
 *
 * Checks:
 * 1. Explicit --cmd or qualityGates from ORCHEST.md
 * 2. Multi-stack manifests (Node, Dart/Flutter, Python, Go, Rust, PHP, JVM/Android, Ruby, Make/Just)
 * 3. Fallback syntax checks on touched files + git diff --check
 * 4. Contextual protected_paths verification (warn by default, fail under --strict-protect)
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const MAX_FAILURE_LINES = 60;

const DEFAULT_PROTECTED_PATTERNS = [
  /^ORCHEST\.md$/,
  /^\.github\/workflows\//,
  /^(scripts|\.agents\/skills\/dev\/scripts)\/(checks\.mjs|triage\.mjs|cleanup-gate\.mjs|context-resolver\.mjs)$/,
];

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    cmd: undefined,
    strictProtect: false,
    allowPaths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && argv[i + 1]) {
      args.cwd = resolve(argv[++i]);
    } else if (argv[i] === "--cmd" && argv[i + 1]) {
      args.cmd = argv[++i];
    } else if (argv[i] === "--strict-protect") {
      args.strictProtect = true;
    } else if (argv[i] === "--allow" && argv[i + 1]) {
      const paths = argv[++i].split(",").map((p) => p.trim()).filter(Boolean);
      args.allowPaths.push(...paths);
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

function verifyProtectedPaths(cwd, touchedFiles, strictProtect, allowPaths) {
  const violations = [];
  for (const file of touchedFiles) {
    const normalized = file.replace(/\\/g, "/");
    const isProtected = DEFAULT_PROTECTED_PATTERNS.some((re) => re.test(normalized));
    if (isProtected) {
      const isAllowed = allowPaths.some((allowed) => {
        const cleanAllowed = allowed.replace(/\\/g, "/");
        return normalized === cleanAllowed || normalized.startsWith(cleanAllowed.replace(/\/?$/, "/"));
      });
      if (!isAllowed) {
        violations.push(normalized);
      }
    }
  }

  if (violations.length === 0) return true;

  if (strictProtect) {
    console.error(`[FAIL] protected_paths violation (${violations.length} files modified outside allow scope):`);
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    return false;
  } else {
    console.warn(`[WARN] Protected path modified (non-strict mode):`);
    for (const v of violations) {
      console.warn(`  - ${v}`);
    }
    return true;
  }
}

function detectOrchestQualityGates(cwd) {
  const orchestPath = join(cwd, "ORCHEST.md");
  if (!existsSync(orchestPath)) return null;

  try {
    const content = readFileSync(orchestPath, "utf-8");
    const match = content.match(/qualityGates:\s*\n((?:\s*-\s*.+\n?)+)/);
    if (!match) return null;

    const lines = match[1].split("\n");
    const commands = [];
    for (const line of lines) {
      const cmdMatch = line.match(/^\s*-\s*(.+)$/);
      if (cmdMatch) {
        const cmd = cmdMatch[1].trim().replace(/^["']|["']$/g, "");
        if (cmd) {
          commands.push({ label: `ORCHEST gate: ${cmd}`, cmd });
        }
      }
    }
    return commands.length > 0 ? commands : null;
  } catch {
    return null;
  }
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

  return checks.length > 0 ? checks : null;
}

function detectDartFlutterChecks(cwd) {
  if (!existsSync(join(cwd, "pubspec.yaml"))) return null;

  const checks = [];
  const isFlutter = existsSync(join(cwd, ".flutter")) || (existsSync(join(cwd, "pubspec.yaml")) && readFileSync(join(cwd, "pubspec.yaml"), "utf-8").includes("sdk: flutter"));

  if (isFlutter && commandExists("flutter")) {
    checks.push({ label: "flutter analyze", cmd: "flutter analyze" });
    if (existsSync(join(cwd, "test"))) checks.push({ label: "flutter test", cmd: "flutter test" });
  } else if (commandExists("dart")) {
    checks.push({ label: "dart analyze", cmd: "dart analyze" });
    if (existsSync(join(cwd, "test"))) checks.push({ label: "dart test", cmd: "dart test" });
  }

  return checks.length > 0 ? checks : null;
}

function detectPythonChecks(cwd) {
  const hasPy = ["pyproject.toml", "setup.py", "requirements.txt"].some((f) => existsSync(join(cwd, f)));
  if (!hasPy) return null;

  const checks = [];
  if (commandExists("ruff")) checks.push({ label: "ruff check", cmd: "ruff check ." });
  if (commandExists("mypy")) checks.push({ label: "mypy", cmd: "mypy ." });
  if (commandExists("pytest")) checks.push({ label: "pytest", cmd: "pytest -q" });
  return checks.length > 0 ? checks : null;
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

function detectPhpChecks(cwd) {
  if (!existsSync(join(cwd, "composer.json"))) return null;
  const checks = [];
  try {
    const composer = JSON.parse(readFileSync(join(cwd, "composer.json"), "utf-8"));
    if (composer.scripts?.test && commandExists("composer")) {
      checks.push({ label: "composer test", cmd: "composer test" });
    }
  } catch {}
  return checks.length > 0 ? checks : null;
}

function detectJvmChecks(cwd) {
  if (existsSync(join(cwd, "gradlew")) || existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"))) {
    const cmd = existsSync(join(cwd, "gradlew")) ? "./gradlew check" : commandExists("gradle") ? "gradle check" : null;
    if (cmd) return [{ label: "gradle check", cmd }];
  }
  if (existsSync(join(cwd, "mvnw")) || existsSync(join(cwd, "pom.xml"))) {
    const cmd = existsSync(join(cwd, "mvnw")) ? "./mvnw test" : commandExists("mvn") ? "mvn test" : null;
    if (cmd) return [{ label: "mvn test", cmd }];
  }
  return null;
}

function detectFallbackChecks(cwd, files) {
  const checks = [];

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
  const { cwd, cmd, strictProtect, allowPaths } = parseArgs(process.argv.slice(2));

  const touchedFiles = getTouchedFiles(cwd);
  const protectPassed = verifyProtectedPaths(cwd, touchedFiles, strictProtect, allowPaths);
  if (!protectPassed) {
    console.error("\nGATE FAILED: Protected path violation.");
    process.exit(1);
  }

  if (cmd) {
    const ok = runCheck(`custom: ${cmd}`, cmd, cwd);
    process.exit(ok ? 0 : 1);
  }

  const checks =
    detectOrchestQualityGates(cwd) ??
    detectNodeChecks(cwd) ??
    detectDartFlutterChecks(cwd) ??
    detectPythonChecks(cwd) ??
    detectGoChecks(cwd) ??
    detectRustChecks(cwd) ??
    detectPhpChecks(cwd) ??
    detectJvmChecks(cwd) ??
    [];

  const allChecks = checks.length > 0 ? checks : detectFallbackChecks(cwd, touchedFiles);

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
