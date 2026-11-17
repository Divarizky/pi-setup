#!/usr/bin/env node
/**
 * cleanup-gate.mjs — Deterministic git diff scanner for debug probes,
 * placeholder stubs, and accidental secrets on added lines.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const RULES = [
  { name: "debug-probe", regex: /\[DEBUG-[^\]]*\]/ },
  { name: "placeholder-stub", regex: /throw new Error\(["']Not implemented["']\)|NotImplementedError|TODO:\s*implement/i },
  { name: "secret-token", regex: /\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function parseArgs(argv) {
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && argv[i + 1]) cwd = resolve(argv[++i]);
  }
  return { cwd };
}

function scanDiff(diffText) {
  const findings = [];
  let currentFile = "<unknown>";
  let currentLine = 0;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      currentLine = Number(hunk[1]) - 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLine++;
      if (currentFile.endsWith("cleanup-gate.mjs")) continue;
      const content = line.slice(1);
      for (const rule of RULES) {
        if (rule.regex.test(content)) {
          findings.push({
            file: currentFile,
            line: currentLine,
            rule: rule.name,
            snippet: content.trim().slice(0, 100),
          });
        }
      }
    }
  }
  return findings;
}

function main() {
  const { cwd } = parseArgs(process.argv.slice(2));
  let diff = "";
  try {
    diff = execSync("git diff HEAD -U0", { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  } catch {
    try {
      diff = execSync("git diff --cached -U0", { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    } catch {
      console.log("[PASS] Not a git repository or no diff available.");
      process.exit(0);
    }
  }

  const findings = scanDiff(diff);
  if (findings.length === 0) {
    console.log("[PASS] Cleanup gate clean: no debug probes, stubs, or secrets in diff.");
    process.exit(0);
  }

  console.error(`[FAIL] Cleanup gate found ${findings.length} issue(s):`);
  for (const f of findings) {
    console.error(`  - [${f.rule}] ${f.file}:${f.line} -> ${f.snippet}`);
  }
  process.exit(1);
}

main();
