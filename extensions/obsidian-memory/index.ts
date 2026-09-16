import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MEMORY_RECAP_CHANNEL,
  MEMORY_STATUS_CHANNEL,
} from "../dashboard-state/dashboard-state.ts";
import { Type } from "typebox";
import {
  loadMemoryConfig,
  resolveProjectSlug,
  type MemoryConfig,
} from "./src/config.ts";
import { writeInboxEntry, type MemoryInboxPayload } from "./src/inbox.ts";

const MEMORY_CONFIG: MemoryConfig = loadMemoryConfig();
const VAULT = MEMORY_CONFIG.vault;

const TZ = "Asia/Jakarta";
const HARD_CAP_CHARS = 4096 * 3;
const PREF_MAX = 400;
const DAILY_MAX = 500;
const OVERVIEW_MAX = 500;
const DECISIONS_MAX = 2;
const DECISION_MAX_CHARS = 250;
const LEARNINGS_MAX = 400;
const KNOWLEDGE_MAX = 800;
const DAILY_BLOAT_KB = 10;

function wibDate(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}
function slurp(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

function isVaultFile(p: string): boolean {
  if (!MEMORY_CONFIG.valid) return false;
  try {
    const root = resolve(VAULT);
    const target = resolve(p);
    const rel = relative(root, target);
    return (
      rel !== "" &&
      !isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      target.endsWith(".md")
    );
  } catch {
    return false;
  }
}

function tagsForPath(filePath: string): string | null {
  const rel = relative(VAULT, filePath).replace(/\\/g, "/");
  if (rel.startsWith("daily/")) return "#daily";
  if (rel.startsWith("knowledge/")) return "#knowledge";
  if (rel.startsWith("projects/"))
    return `#project #${basename(filePath, ".md")}`;
  if (rel.startsWith("agent/")) return "#agent";
  if (rel.startsWith("summaries/")) return "#summary";
  if (rel.startsWith("meta/")) return "#meta";
  if (rel === "vault-graph.md") return "#vault #graph";
  return null;
}

function hasAnyTag(content: string): boolean {
  return /^#[\w-]+/m.test(content);
}

function ensureTags(filePath: string): void {
  if (!isVaultFile(filePath)) return;
  const content = slurp(filePath);
  if (!content || hasAnyTag(content)) return;
  const tagLine = tagsForPath(filePath);
  if (!tagLine) return;
  const tagBlock = `${tagLine}\n\n`;
  const frontmatter = content.match(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/);
  if (frontmatter) {
    const insertAt = frontmatter[0].length;
    writeFileSync(
      filePath,
      content.slice(0, insertAt) + tagBlock + content.slice(insertAt),
      "utf8",
    );
    return;
  }
  writeFileSync(filePath, tagBlock + content, "utf8");
}

function generateVaultIndex(): void {
  if (!MEMORY_CONFIG.valid || !existsSync(VAULT)) return;
  const outPath = join(VAULT, "vault-graph.md");
  const lines: string[] = [];
  lines.push("# Vault Index");
  lines.push("");
  lines.push("## Knowledge");
  try {
    for (const f of readdirSync(join(VAULT, "knowledge"))
      .filter((f) => f.endsWith(".md"))
      .sort())
      lines.push(`- [[knowledge/${f.replace(/\.md$/, "")}]]`);
  } catch {
    /* ignore */
  }
  lines.push("");
  lines.push("## Projects");
  try {
    for (const slug of readdirSync(join(VAULT, "projects"))
      .filter((slug) => {
        try {
          return statSync(join(VAULT, "projects", slug)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()) {
      const dir = join(VAULT, "projects", slug);
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      if (!files.length) continue;
      lines.push(`### ${slug}`);
      for (const f of files)
        lines.push(`- [[projects/${slug}/${f.replace(/\.md$/, "")}]]`);
    }
  } catch {
    /* ignore */
  }
  lines.push("");
  lines.push("## Daily Notes");
  try {
    for (const f of readdirSync(join(VAULT, "daily"))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse())
      lines.push(`- [[daily/${f.replace(/\.md$/, "")}]]`);
  } catch {
    /* ignore */
  }
  lines.push("");
  lines.push("## Weekly Summaries");
  try {
    for (const f of readdirSync(join(VAULT, "summaries"))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse())
      lines.push(`- [[summaries/${f.replace(/\.md$/, "")}]]`);
  } catch {
    /* ignore */
  }
  lines.push("");
  const content = lines.join("\n");
  if (slurp(outPath) === content) return;
  writeFileSync(outPath, content, "utf8");
}

function extractTLDR(text: string, maxChars: number): string | null {
  if (!text) return null;
  const m = text.match(/^(##\s*(?:TL;DR|TLDR|Summary))\b/im);
  if (m) {
    const rest = text.slice(m.index! + m[0].length);
    const next = rest.search(/\n##\s+/);
    let body = (next === -1 ? rest : rest.slice(0, next)).trim();
    if (body.length > maxChars) body = body.slice(0, maxChars) + "…";
    return body;
  }
  const lines = text
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 2)
    .join("\n")
    .trim();
  if (!lines) return null;
  return lines.length > maxChars ? lines.slice(0, maxChars) + "…" : lines;
}

function extractFirstDecisions(
  text: string,
  count = DECISIONS_MAX,
  maxChars = DECISION_MAX_CHARS,
): string[] {
  if (!text) return [];
  const matches = Array.from(text.matchAll(/^##\s+(.*)/gm)).filter(
    (m) => !/^(?:TL;DR|TLDR|Summary)\b/i.test(m[1]),
  );
  const out: string[] = [];
  for (let i = 0; i < Math.min(count, matches.length); i++) {
    const start = matches[i].index!;
    const rest = text.slice(start + matches[i][0].length);
    const next = rest.match(/\n##\s+/);
    let body = next ? rest.slice(0, next.index!) : rest;
    body = body.trim();
    if (body.length > maxChars) body = body.slice(0, maxChars) + "…";
    out.push(`### ${matches[i][1]}\n${body}`);
  }
  return out;
}

function extractTLDRBullets(text: string, maxBullets = 2): string[] {
  const m = text.match(/^##\s*(?:TL;DR|TLDR|Summary)\b/im);
  if (!m) return [];
  const rest = text.slice(m.index! + m[0].length);
  const next = rest.search(/\n##\s+/);
  let body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"))
    .slice(0, maxBullets);
}

function extractOverviewShort(text: string, maxChars = 100): string | null {
  const m = text.match(/^##\s*Overview\b/im);
  if (!m) return null;
  const rest = text.slice(m.index! + m[0].length);
  const next = rest.search(/\n##\s+/);
  let body = (next === -1 ? rest : rest.slice(0, next)).trim();
  if (body.length > maxChars) return null;
  return body;
}

function listTopicsWithDesc(maxTotalChars = KNOWLEDGE_MAX): string[] {
  try {
    const files = readdirSync(join(VAULT, "knowledge"))
      .filter((f) => f.endsWith(".md") && f !== "knowledge-template.md")
      .sort();
    const out: string[] = [];
    let used = 0;
    for (const f of files) {
      const raw = slurp(join(VAULT, "knowledge", f));
      let desc = "";
      if (raw) {
        const bullets = extractTLDRBullets(raw, 2);
        const overview = extractOverviewShort(raw, 100);
        const parts: string[] = [];
        if (bullets.length)
          parts.push(bullets.map((b) => b.replace(/^-\s*/, "")).join(". "));
        if (overview) parts.push(`(ov: ${overview})`);
        if (parts.length) desc = ` — ${parts.join(" ")}`;
      }
      const entry = `- ${f}${desc}`;
      if (used + entry.length > maxTotalChars && out.length > 0) break;
      out.push(entry);
      used += entry.length + 1;
    }
    return out;
  } catch {
    return [];
  }
}

function detectVaultSlug(cwd: string): string | null {
  if (!MEMORY_CONFIG.valid) return null;
  return resolveProjectSlug(cwd, MEMORY_CONFIG);
}

function buildProjectBlock(cwd: string): string | null {
  const slug = detectVaultSlug(cwd);
  if (!slug) return null;
  const dir = join(VAULT, "projects", slug);
  if (!existsSync(dir)) return null;
  const overview = slurp(join(dir, "overview.md"));
  const decisions = slurp(join(dir, "decisions.md"));
  const learnings = slurp(join(dir, "learnings.md"));
  const parts: string[] = [];
  const tldr = overview ? extractTLDR(overview, OVERVIEW_MAX) : null;
  if (tldr) parts.push(`## Project Overview (${slug})\n${tldr}`);
  const adrs = decisions ? extractFirstDecisions(decisions) : [];
  if (adrs.length) parts.push(`## Recent Decisions\n${adrs.join("\n\n")}`);
  const learn = learnings ? extractTLDR(learnings, LEARNINGS_MAX) : null;
  if (learn) parts.push(`## Project Learnings\n${learn}`);
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

function buildBlock(cwd: string): string | null {
  if (!MEMORY_CONFIG.valid || !existsSync(VAULT)) return null;
  const date = wibDate();
  const activeSlug = detectVaultSlug(cwd);
  const parts: string[] = [];
  const prefs = slurp(join(VAULT, "agent", "preferences.md"));
  if (prefs) {
    const tldr = extractTLDR(prefs, PREF_MAX);
    if (tldr) parts.push(`## Preferences\n${tldr}`);
  }
  const proj = buildProjectBlock(cwd);
  if (proj) parts.push(proj);
  const dailyRaw = slurp(join(VAULT, "daily", `${date}.md`));
  if (dailyRaw) {
    const tldr = extractTLDR(dailyRaw, DAILY_MAX);
    if (tldr) parts.push(`## Daily Note ${date} (TL;DR)\n${tldr}`);
    else parts.push(`## Daily Note ${date}\n[No TL;DR — add heading ## TL;DR]`);
  }
  const topics = listTopicsWithDesc();
  if (topics.length) parts.push(`## Knowledge Topics\n${topics.join("\n")}`);
  if (parts.length === 0) return null;
  let block = `\n\n# Vault Context (auto-injected, date: ${date}, project: ${activeSlug ?? "none"})\n${parts.join("\n\n")}`;
  if (block.length > HARD_CAP_CHARS) {
    const cut = block.lastIndexOf("\n", HARD_CAP_CHARS);
    const end = cut > HARD_CAP_CHARS * 0.9 ? cut : HARD_CAP_CHARS;
    block = block.slice(0, end) + "\n\n[Vault truncated]";
  }
  return block;
}

function dailyBloatCheck(
  ctx: {
    ui: { notify: (msg: string, type: "warning" | "error" | "info") => void };
  },
  date: string,
): void {
  if (!MEMORY_CONFIG.valid || !existsSync(VAULT)) return;
  const p = join(VAULT, "daily", `${date}.md`);
  try {
    if (!existsSync(p)) return;
    const kb = statSync(p).size / 1024;
    if (kb > DAILY_BLOAT_KB)
      ctx.ui.notify(
        `Daily note ${date} = ${Math.ceil(kb)}KB. Run /memory check soon.`,
        "warning",
      );
  } catch {
    /* ignore */
  }
}

function isMemoryRecap(
  value: unknown,
): value is Omit<MemoryInboxPayload, "date" | "projectSlug"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.cwd === "string" &&
    typeof input.sessionId === "string" &&
    typeof input.runKey === "string" &&
    typeof input.recap === "string" &&
    typeof input.next === "string" &&
    input.durable === true
  );
}

function auditBacklinks(): { file: string; hasLink: boolean }[] {
  const results: { file: string; hasLink: boolean }[] = [];
  const scanDir = (
    dir: string,
    prefix: string,
    options: { exemptBasename?: Set<string> } = {},
  ) => {
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (!f.endsWith(".md")) continue;
        if (options.exemptBasename?.has(f)) continue;
        const raw = slurp(p);
        if (!raw) continue;
        const rel = relative(VAULT, p).replace(/\\/g, "/");
        results.push({
          file: rel,
          hasLink:
            /\[\[(?!link\]\])[A-Za-z0-9_\/\- ]+(?:\|[^\]]+)?(?:#[^\]]+)?\]\]/.test(
              raw,
            ),
        });
      }
    } catch {
      /* ignore */
    }
  };
  scanDir(join(VAULT, "knowledge"), "knowledge/");
  scanDir(join(VAULT, "daily"), "daily/");
  scanDir(join(VAULT, "agent"), "agent/");
  scanDir(join(VAULT, "summaries"), "summaries/");
  scanDir(join(VAULT, "meta"), "meta/", {
    exemptBasename: new Set(["summary-template.md"]),
  });
  try {
    for (const slug of readdirSync(join(VAULT, "projects"))) {
      scanDir(join(VAULT, "projects", slug), `projects/${slug}/`);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const date of readdirSync(join(VAULT, "inbox"))) {
      scanDir(join(VAULT, "inbox", date), `inbox/${date}/`);
    }
  } catch {
    /* ignore */
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  let cachedBlock: string | null = null;
  let cachedDate = "";
  let cachedCwd = "";
  let cachedMtimes: Record<string, number> = {};

  function getRelevantMtimes(
    cwd: string,
    date: string,
  ): Record<string, number> {
    const mtimes: Record<string, number> = {};
    if (!MEMORY_CONFIG.valid || !existsSync(VAULT)) return mtimes;
    const add = (p: string) => {
      try {
        if (existsSync(p)) mtimes[p] = statSync(p).mtimeMs;
      } catch {
        /* ignore */
      }
    };
    add(join(VAULT, "agent", "preferences.md"));
    add(join(VAULT, "daily", `${date}.md`));
    const slug = detectVaultSlug(cwd);
    if (slug) {
      const dir = join(VAULT, "projects", slug);
      add(join(dir, "overview.md"));
      add(join(dir, "decisions.md"));
      add(join(dir, "learnings.md"));
    }
    try {
      const dir = join(VAULT, "knowledge");
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
        add(join(dir, f));
      }
    } catch {
      /* ignore */
    }
    return mtimes;
  }

  function mtimesChanged(
    a: Record<string, number>,
    b: Record<string, number>,
  ): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (a[k] !== b[k]) return true;
    return false;
  }

  let memoryRecapListenerActive = true;
  const stopMemoryRecapListener = pi.events.on(
    MEMORY_RECAP_CHANNEL,
    (value) => {
      if (
        !memoryRecapListenerActive ||
        !MEMORY_CONFIG.valid ||
        !existsSync(VAULT)
      )
        return;
      if (!isMemoryRecap(value)) return;

      const payload: MemoryInboxPayload = {
        ...value,
        date: wibDate(),
        projectSlug: detectVaultSlug(value.cwd),
      };
      void writeInboxEntry(payload, VAULT).catch(() => {
        // Auto-save must never interrupt the agent run or expose vault details.
        console.warn("obsidian-memory: failed to write inbox entry");
      });
    },
  );

  pi.on("session_shutdown", () => {
    if (!memoryRecapListenerActive) return;
    memoryRecapListenerActive = false;
    stopMemoryRecapListener();
  });

  pi.on("session_start", async (_event, ctx) => {
    cachedBlock = null;
    cachedDate = "";
    cachedCwd = "";
    cachedMtimes = {};
    if (MEMORY_CONFIG.valid && existsSync(VAULT)) generateVaultIndex();
    const ok = MEMORY_CONFIG.valid && existsSync(VAULT);
    const shortPath = VAULT.replace(process.env.HOME ?? "", "~")
      .replace(/.*My Drive[\/]/, "")
      .replace(/.*AGENT-MEMORY[\/]/, "");
    pi.events.emit(MEMORY_STATUS_CHANNEL, { ok, shortPath });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const today = wibDate();
    const cwd = ctx.cwd;
    const mtimes = getRelevantMtimes(cwd, today);

    if (
      cachedBlock &&
      cachedDate === today &&
      cachedCwd === cwd &&
      !mtimesChanged(cachedMtimes, mtimes)
    ) {
      return { systemPrompt: event.systemPrompt + cachedBlock };
    }

    cachedDate = today;
    cachedCwd = cwd;
    cachedMtimes = mtimes;
    const block = buildBlock(cwd);
    cachedBlock = block;
    if (!block) return;

    const tok = Math.ceil(block.length / 4);
    if (ctx.hasUI && tok > 1200)
      ctx.ui.notify(`Vault inject ${tok} tokens`, "warning");

    dailyBloatCheck(ctx, today);
    return { systemPrompt: event.systemPrompt + block };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (
      MEMORY_CONFIG.valid &&
      (event.toolName === "write" || event.toolName === "edit")
    ) {
      const input = event.input as { path?: string };
      const filePath = input?.path ? resolve(ctx.cwd, input.path) : undefined;
      if (filePath && isVaultFile(filePath)) {
        ensureTags(filePath);
        generateVaultIndex();
      }
    }
  });

  pi.registerCommand("vault-audit", {
    description: "Audit vault backlinks and report missing links",
    handler: async (_args, ctx) => {
      if (!MEMORY_CONFIG.valid || !existsSync(VAULT)) {
        ctx.ui.notify(
          "Memory vault configuration is invalid or unavailable.",
          "error",
        );
        return;
      }
      const results = auditBacklinks();
      const missing = results.filter((r) => !r.hasLink);
      const msg = missing.length
        ? `Missing backlinks: ${missing.map((r) => r.file).join(", ")}`
        : "All vault files have backlinks.";
      ctx.ui.notify(msg, missing.length ? "warning" : "info");
    },
  });

  pi.registerTool({
    name: "search_knowledge",
    label: "Search Knowledge",
    description:
      "Search knowledge topics and project learnings by keyword. Returns up to 5 short snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Keyword or phrase" }),
      maxResults: Type.Optional(
        Type.Number({ description: "Max results (default 3, max 5)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!MEMORY_CONFIG.valid || !existsSync(VAULT)) {
        return {
          content: [
            {
              type: "text",
              text: "Memory vault configuration is invalid or unavailable.",
            },
          ],
          details: { hits: [] },
        };
      }
      const q = params.query.toLowerCase();
      const max = Math.min(Math.max(1, params.maxResults ?? 3), 5);
      const hits: { file: string; snippet: string }[] = [];

      const searchFile = (filePath: string, displayPath: string) => {
        if (hits.length >= max) return;
        const raw = slurp(filePath);
        if (!raw || !raw.toLowerCase().includes(q)) return;
        const idx = raw.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 80);
        const end = Math.min(raw.length, idx + 220);
        let s = raw.slice(start, end).trim();
        if (start > 0) s = "…" + s;
        if (end < raw.length) s += "…";
        hits.push({ file: displayPath, snippet: s });
      };

      try {
        for (const f of readdirSync(join(VAULT, "knowledge"))
          .filter((x) => x.endsWith(".md"))
          .sort()) {
          searchFile(join(VAULT, "knowledge", f), `knowledge/${f}`);
        }
      } catch {
        /* ignore */
      }

      try {
        for (const f of readdirSync(join(VAULT, "summaries"))
          .filter((x) => x.endsWith(".md"))
          .sort()) {
          searchFile(join(VAULT, "summaries", f), `summaries/${f}`);
        }
      } catch {
        /* ignore */
      }

      try {
        for (const p of readdirSync(join(VAULT, "projects")).sort()) {
          searchFile(
            join(VAULT, "projects", p, "learnings.md"),
            `projects/${p}/learnings.md`,
          );
        }
      } catch {
        /* ignore */
      }

      const limited = hits.slice(0, max);
      return {
        content: [
          {
            type: "text",
            text: limited.length
              ? limited.map((h) => `**${h.file}**\n${h.snippet}`).join("\n\n")
              : "No matches.",
          },
        ],
        details: { hits: limited },
      };
    },
  });
}
