import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Rule, RuleAction, RuleAnchor, RuleScope } from "./types.ts";

const VALID_ACTIONS = new Set<RuleAction>(["strip", "abort", "block", "log"]);
const VALID_ANCHORS = new Set<RuleAnchor>(["start", "any"]);

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Parsing sederhana frontmatter YAML-subset tanpa dependensi eksternal.
 * Mendukung string, number, boolean, multiline list (- item), dan inline list ([a, b]).
 */
export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { data: {}, body: normalized.trim() };
  }

  const endIdx = normalized.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { data: {}, body: normalized.trim() };
  }

  const rawYaml = normalized.slice(3, endIdx).trim();
  const body = normalized.slice(endIdx + 4).replace(/^\n+/, "").trimEnd();
  const data: Record<string, unknown> = {};

  const lines = rawYaml.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (let line of lines) {
    line = line.trimEnd();
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }

    // List item di bawah key sebelumnya
    const listMatch = line.match(/^(\s*)-\s+(.*)$/);
    if (listMatch) {
      if (currentKey && currentList) {
        let val = listMatch[2].trim();
        val = stripQuotes(val);
        currentList.push(val);
        continue;
      }
    }

    // Key-value pair
    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      if (currentKey && currentList) {
        data[currentKey] = currentList;
        currentKey = null;
        currentList = null;
      }

      const key = kvMatch[1].trim();
      const rawVal = kvMatch[2].trim();

      if (rawVal === "" || rawVal === "[]") {
        // Mulai list baru atau empty array
        currentKey = key;
        currentList = [];
        data[key] = currentList;
        continue;
      }

      // Inline list: [a, b, c]
      if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        const inner = rawVal.slice(1, -1).trim();
        const items = inner
          ? inner
              .split(",")
              .map((it) => stripQuotes(it.trim()))
              .filter((it) => it.length > 0)
          : [];
        data[key] = items;
        currentKey = null;
        currentList = null;
        continue;
      }

      data[key] = parsePrimitive(rawVal);
      currentKey = null;
      currentList = null;
      continue;
    }
  }

  if (currentKey && currentList) {
    data[currentKey] = currentList;
  }

  return { data, body };
}

function stripQuotes(str: string): string {
  if (
    (str.startsWith('"') && str.endsWith('"')) ||
    (str.startsWith("'") && str.endsWith("'"))
  ) {
    return str.slice(1, -1);
  }
  return str;
}

function parsePrimitive(str: string): string | number | boolean {
  const stripped = stripQuotes(str);
  if (stripped.toLowerCase() === "true") return true;
  if (stripped.toLowerCase() === "false") return false;
  if (/^-?\d+$/.test(stripped)) {
    const num = Number.parseInt(stripped, 10);
    if (!Number.isNaN(num)) return num;
  }
  return stripped;
}

function normalizeStringList(val: unknown): string[] {
  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(val)) {
    return val
      .map((it) => (typeof it === "string" ? it.trim() : String(it).trim()))
      .filter((it) => it.length > 0);
  }
  return [];
}

/**
 * Mengurai string markdown rule TTSR menjadi objek Rule valid.
 * Melempar Error jika ada pelanggaran skema atau regex invalid.
 */
export function parseRule(markdown: string, fileName = "<inline>"): Rule {
  const { data, body } = parseFrontmatter(markdown);

  const rawName = data.name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    throw new Error(`[${fileName}] field 'name' wajib berupa string tidak kosong`);
  }
  const name = rawName.trim();

  const description =
    typeof data.description === "string" ? data.description.trim() : undefined;

  const rawAction = data.action;
  if (
    typeof rawAction !== "string" ||
    !VALID_ACTIONS.has(rawAction.trim() as RuleAction)
  ) {
    throw new Error(
      `[${fileName}] action tidak dikenal '${String(rawAction)}'. Harus salah satu dari: strip, abort, block, log`,
    );
  }
  const action = rawAction.trim() as RuleAction;

  const rawScope = data.scope;
  if (typeof rawScope !== "string" || !rawScope.trim()) {
    throw new Error(`[${fileName}] field 'scope' wajib diisi (contoh: text, thinking, tool:<nama>)`);
  }
  const scopeStr = rawScope.trim();
  if (
    scopeStr !== "text" &&
    scopeStr !== "thinking" &&
    !scopeStr.startsWith("tool:")
  ) {
    throw new Error(
      `[${fileName}] scope '${scopeStr}' tidak valid. Harus 'text', 'thinking', atau 'tool:<nama>'`,
    );
  }
  const scope = scopeStr as RuleScope;

  const flags =
    typeof data.flags === "string" && data.flags.trim() ? data.flags.trim() : "i";

  const rawAnchor = data.anchor;
  let anchor: RuleAnchor = "any";
  if (rawAnchor !== undefined && rawAnchor !== null) {
    if (
      typeof rawAnchor !== "string" ||
      !VALID_ANCHORS.has(rawAnchor.trim() as RuleAnchor)
    ) {
      throw new Error(
        `[${fileName}] anchor '${String(rawAnchor)}' tidak valid. Harus 'start' atau 'any'`,
      );
    }
    anchor = rawAnchor.trim() as RuleAnchor;
  }

  const rawConditions = normalizeStringList(data.condition);
  if (rawConditions.length === 0) {
    throw new Error(
      `[${fileName}] field 'condition' wajib berisi minimal satu pola regex`,
    );
  }

  const compiledConditions: RegExp[] = [];
  for (const pat of rawConditions) {
    try {
      compiledConditions.push(new RegExp(pat, flags));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[${fileName}] regex condition rusak '${pat}': ${msg}`);
    }
  }

  let unlessUserSays: string[] | undefined;
  let compiledUnlessUserSays: RegExp[] | undefined;
  if (data.unlessUserSays !== undefined && data.unlessUserSays !== null) {
    unlessUserSays = normalizeStringList(data.unlessUserSays);
    compiledUnlessUserSays = [];
    for (const pat of unlessUserSays) {
      try {
        compiledUnlessUserSays.push(new RegExp(pat, flags));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[${fileName}] regex unlessUserSays rusak '${pat}': ${msg}`,
        );
      }
    }
  }

  let maxPerTurn = 1;
  if (data.maxPerTurn !== undefined && data.maxPerTurn !== null) {
    if (typeof data.maxPerTurn === "number" && Number.isInteger(data.maxPerTurn) && data.maxPerTurn > 0) {
      maxPerTurn = data.maxPerTurn;
    } else {
      throw new Error(
        `[${fileName}] maxPerTurn harus integer positif (diberikan: ${String(data.maxPerTurn)})`,
      );
    }
  }

  let enabled = true;
  if (data.enabled !== undefined && data.enabled !== null) {
    if (typeof data.enabled === "boolean") {
      enabled = data.enabled;
    } else {
      enabled = String(data.enabled).toLowerCase() === "true";
    }
  }

  return {
    name,
    description,
    action,
    scope,
    condition: rawConditions,
    flags,
    anchor,
    unlessUserSays,
    maxPerTurn,
    enabled,
    correctionText: body.trim(),
    filePath: fileName,
    compiledConditions,
    compiledUnlessUserSays,
  };
}

/**
 * Memuat seluruh rule dari sebuah direktori berkas markdown.
 * Rule yang tidak valid atau duplikat namanya dilewati dengan mencatat peringatan.
 */
export function loadRules(dir: string): Rule[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(dir);
  } catch (err) {
    console.warn(`[ttsr] gagal membaca direktori rules '${dir}':`, err);
    return [];
  }

  const rules: Rule[] = [];
  const seenNames = new Set<string>();

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".md")) continue;
    const fullPath = join(dir, fileName);

    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;

      const content = readFileSync(fullPath, "utf8");
      const rule = parseRule(content, fileName);

      if (seenNames.has(rule.name)) {
        console.warn(
          `[ttsr] rule diabaikan dari '${fileName}': nama '${rule.name}' sudah ada (duplikat)`,
        );
        continue;
      }

      seenNames.add(rule.name);
      rules.push(rule);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ttsr] rule tidak valid di '${fileName}': ${msg}`);
    }
  }

  return rules;
}
