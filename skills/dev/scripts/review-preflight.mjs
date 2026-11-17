#!/usr/bin/env node
/**
 * review-preflight.mjs — Deterministic preflight for code-review & git-commit.
 *
 * Checks git status completeness, records HEAD/MERGE_HEAD + git write-tree
 * snapshot, and calculates diff size & sensitivity for Fast-Path Review routing.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SENSITIVE_PATH_RE = /(auth|security|secret|token|permission|rbac|schema|migration|database|api|route|endpoint|controller|middleware|\.sql$)/i;
const FAST_PATH_MAX_LINES = 50;

function parseArgs(argv) {
  const args = { cwd: process.cwd(), source: "staged", verifyTree: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && argv[i + 1]) args.cwd = resolve(argv[++i]);
    else if (argv[i] === "--source" && argv[i + 1]) args.source = argv[++i];
    else if (argv[i] === "--verify-tree" && argv[i + 1]) args.verifyTree = argv[++i];
  }
  return args;
}

function runGit(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cmd, cwd) {
  try {
    return runGit(cmd, cwd);
  } catch {
    return "";
  }
}

function main() {
  const { cwd, source, verifyTree } = parseArgs(process.argv.slice(2));

  if (!existsSync(join(cwd, ".git")) && !tryGit("git rev-parse --git-dir", cwd)) {
    console.log(JSON.stringify({ ok: false, reason: "not_a_git_repo" }, null, 2));
    process.exit(1);
  }

  const head = tryGit("git rev-parse -q --verify HEAD", cwd);
  const mergeHead = tryGit("git rev-parse -q --verify MERGE_HEAD", cwd);
  const parents = [head, mergeHead].filter(Boolean).join(" ");
  const tree = source === "staged" ? tryGit("git write-tree", cwd) : undefined;

  if (verifyTree !== undefined) {
    const matches = tree === verifyTree;
    console.log(JSON.stringify({ ok: matches, expectedTree: verifyTree, actualTree: tree, parents }, null, 2));
    process.exit(matches ? 0 : 1);
  }

  const porcelain = tryGit("git status --porcelain=v1", cwd);
  const lines = porcelain ? porcelain.split("\n").filter(Boolean) : [];

  const unstagedFiles = [];
  const untrackedFiles = [];
  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).trim();
    if (x === "?" && y === "?") untrackedFiles.push(file);
    else if (y !== " ") unstagedFiles.push(file);
  }

  const diffTarget = source === "staged" ? "--cached" : source === "uncommitted" ? "HEAD" : source;
  const numstatRaw = tryGit(`git diff ${diffTarget} --numstat`, cwd);
  let addedLines = 0;
  let deletedLines = 0;
  const changedFiles = [];

  for (const row of numstatRaw ? numstatRaw.split("\n") : []) {
    const [a, d, file] = row.split("\t");
    if (!file) continue;
    const add = a === "-" ? 0 : Number(a) || 0;
    const del = d === "-" ? 0 : Number(d) || 0;
    addedLines += add;
    deletedLines += del;
    changedFiles.push(file);
  }

  const totalChangedLines = addedLines + deletedLines;
  const sensitiveFiles = changedFiles.filter((f) => SENSITIVE_PATH_RE.test(f));
  const fastPathEligible =
    changedFiles.length > 0 &&
    totalChangedLines < FAST_PATH_MAX_LINES &&
    sensitiveFiles.length === 0;

  const result = {
    ok: changedFiles.length > 0,
    source,
    parents,
    ...(tree ? { tree } : {}),
    isMerge: Boolean(mergeHead),
    completeness: {
      cleanWorkingTreeForStaged: unstagedFiles.length === 0 && untrackedFiles.length === 0,
      unstagedFiles,
      untrackedFiles,
    },
    diffStats: {
      filesCount: changedFiles.length,
      addedLines,
      deletedLines,
      totalChangedLines,
      sensitiveFiles,
    },
    reviewRouting: fastPathEligible ? "fast-path" : "multi-axis",
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(changedFiles.length > 0 ? 0 : 2);
}

main();
