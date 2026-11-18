#!/usr/bin/env node
/**
 * context-resolver.mjs — Deterministic workspace context & work-card resolver.
 *
 * Detects Project vs Universal mode, checks stack docs flags, and extracts
 * active work-card queue items in a single tool call.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const STOPWORDS = new Set([
  "dan", "atau", "serta", "yang", "untuk", "dengan", "saat", "di", "ke", "pada", "ini", "itu",
  "and", "or", "the", "with", "for", "to", "in", "on", "at", "of"
]);

function deriveSlug(title) {
  if (!title) return "feature";
  const clean = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:f|task|req|ac|us|sc|adr)[-_]?\d+\b/gi, " ")
    .replace(/\bt\d{3,}\b/gi, " ")
    .replace(/\bwf-[a-z0-9-]+\b/gi, " ")
    .toLowerCase();
  const words = clean.split(/[^a-z0-9]+/).filter(Boolean);
  const filtered = words.filter((w) => !STOPWORDS.has(w));
  const wordsToUse = filtered.length > 0 ? filtered : words;
  let slug = "";
  for (const w of wordsToUse) {
    const candidate = slug ? `${slug}-${w}` : w;
    if (candidate.length <= 50) slug = candidate;
    else break;
  }
  return slug || "feature";
}

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

  // Metadata extraction
  const idMatch = text.match(/^id:\s*([^\s\n]+)/m);
  const statusMatch = text.match(/^status:\s*([^\s\n]+)/m);
  const titleMatch = text.match(/^#\s+(?:F-\d+\s*[—–-]\s*)?([^\n]+)/m);

  const featureId = idMatch ? idMatch[1] : null;
  const status = statusMatch ? statusMatch[1].toLowerCase() : "unknown";
  const featureTitle = titleMatch ? titleMatch[1].trim() : "";
  const suggestedBranch = `feat/${deriveSlug(featureTitle)}`;

  // Clarification marker count
  const clarificationMatches = text.match(/\[NEEDS CLARIFICATION/gi) || [];
  const needsClarificationCount = clarificationMatches.length;

  // Acceptance criteria & Ref coverage analysis
  const acMatches = new Set();
  const acRegex = /\b(?:AC|REQ)-\d+\b/gi;
  let m;
  while ((m = acRegex.exec(text)) !== null) {
    acMatches.add(m[0].toUpperCase());
  }

  const referencedACs = new Set();

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
    const refMatch = line.match(/Ref:\s*([^\n]+)/i);
    if (refMatch) {
      let rm;
      const refRegex = /\b(?:AC|REQ)-\d+\b/gi;
      while ((rm = refRegex.exec(refMatch[1])) !== null) {
        referencedACs.add(rm[0].toUpperCase());
      }
    }
    if (!section) continue;
    const match = line.match(/^#{4}\s+\[\s*[x ]\s*\]\s+(TASK-\S+.*)$/i) || line.match(/^-\s+\[\s*[x ]\s*\]\s+(TASK-\S+.*)$/i);
    if (match) tasks[section].push(match[1].trim());
  }

  const uncoveredCriteria = Array.from(acMatches).filter((id) => !referencedACs.has(id));

  return {
    id: featureId,
    title: featureTitle,
    suggestedBranch,
    status,
    needsClarificationCount,
    coverageGap: uncoveredCriteria,
    ...tasks,
  };
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
