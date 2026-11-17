#!/usr/bin/env node
/**
 * context-resolver.mjs — Deterministic workspace context & work-card resolver.
 *
 * Detects Project vs Universal mode, checks stack docs flags, and extracts
 * active work-card queue items in a single tool call.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && argv[i + 1]) cwd = resolve(argv[++i]);
  }
  return { cwd };
}

function parseWorkCard(filePath) {
  const text = readFileSync(filePath, "utf-8");
  const tasks = { inProgress: [], queue: [] };
  let section = null;

  for (const line of text.split("\n")) {
    if (/^###\s+In Progress/i.test(line)) {
      section = "inProgress";
      continue;
    }
    if (/^###\s+Queue/i.test(line)) {
      section = "queue";
      continue;
    }
    if (/^###\s+/.test(line)) {
      section = null;
      continue;
    }
    if (!section) continue;
    const match = line.match(/^#{4}\s+\[\s*[x ]\s*\]\s+(TASK-\S+.*)$/i) || line.match(/^-\s+\[\s*[x ]\s*\]\s+(TASK-\S+.*)$/i);
    if (match) tasks[section].push(match[1].trim());
  }
  return tasks;
}

function main() {
  const { cwd } = parseArgs(process.argv.slice(2));
  const workspaceDir = join(cwd, ".workspace");
  const isProject = existsSync(workspaceDir);

  const rootDocs = {
    agentsMd: existsSync(join(cwd, "AGENTS.md")),
    adrMd: existsSync(join(cwd, "ADR.md")),
  };

  const contextDir = join(workspaceDir, "context");
  const stackDocs = {
    contextMd: existsSync(join(contextDir, "CONTEXT.md")),
    srsMd: existsSync(join(contextDir, "SRS.md")),
    trackerMd: existsSync(join(contextDir, "TRACKER.md")),
    hasCodeStyle: existsSync(join(contextDir, "CODE_STYLE.md")),
    hasSecurity: existsSync(join(contextDir, "SECURITY.md")),
    hasDatabase: existsSync(join(contextDir, "DATABASE.md")),
    hasApi: existsSync(join(contextDir, "API.md")),
  };

  const workDir = join(workspaceDir, "work");
  const workCards = [];
  if (isProject && existsSync(workDir)) {
    for (const entry of readdirSync(workDir)) {
      if (/^F-.*\.md$/i.test(entry)) {
        const full = join(workDir, entry);
        workCards.push({ file: `.workspace/work/${entry}`, ...parseWorkCard(full) });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        cwd,
        mode: isProject ? "Project" : "Universal",
        rootDocs,
        ...(isProject ? { stackDocs, workCards } : {}),
      },
      null,
      2,
    ),
  );
}

main();
