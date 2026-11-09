import { join } from "node:path";

/** Nama script package.json yang dianggap perintah validasi. */
const PACKAGE_SCRIPT_NAMES = [
  "test",
  "check",
  "lint",
  "build",
  "typecheck",
  "verify",
] as const;

/** Nama target Makefile dan recipe justfile yang dianggap validasi. */
const TASK_RUNNER_NAMES = ["test", "check", "lint", "verify"] as const;

/** Membaca berkas teks; melempar bila berkas tidak ada atau tidak terbaca. */
export type ReadProjectFile = (path: string) => string;

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scriptPattern(name: string): string {
  return String.raw`\b(?:npm(?:\.cmd)?|pnpm|yarn|bun)\s+run\s+${escapeRegex(name)}(?=\s|$)`;
}

function makePattern(target: string): string {
  return String.raw`\bmake\s+${escapeRegex(target)}(?=\s|$)`;
}

function justPattern(recipe: string): string {
  return String.raw`\bjust\s+${escapeRegex(recipe)}(?=\s|$)`;
}

function detectFromPackageJson(text: string): string[] {
  const parsed = JSON.parse(text) as { scripts?: unknown } | null;
  const scripts = parsed?.scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    return [];
  }
  const record = scripts as Record<string, unknown>;
  return PACKAGE_SCRIPT_NAMES.filter(
    (name) => Object.hasOwn(record, name) && typeof record[name] === "string",
  ).map(scriptPattern);
}

/** Target Makefile: baris tanpa indentasi berbentuk `nama1 nama2: ...`. */
function makefileTargets(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*)\s*:(?![:=])/.exec(line);
    if (match?.[1]) names.push(...match[1].split(/\s+/));
  }
  return names;
}

/** Recipe justfile: baris tanpa indentasi berbentuk `nama [param...]: ...`. */
function justRecipes(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*)(?:\s[^:]*)?:(?!=)/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function detectFromPyproject(text: string): string[] {
  const patterns: string[] = [];
  if (/^\s*\[tool\.pytest/m.test(text)) patterns.push(String.raw`\bpytest\b`);
  if (/^\s*\[tool\.ruff/m.test(text)) patterns.push(String.raw`\bruff\b`);
  if (/^\s*\[tool\.mypy/m.test(text)) patterns.push(String.raw`\bmypy\b`);
  return patterns;
}

function readOptional(
  cwd: string,
  file: string,
  readFile: ReadProjectFile,
): string | undefined {
  try {
    return readFile(join(cwd, file));
  } catch {
    return undefined;
  }
}

/**
 * Mendeteksi pola regex perintah validasi dari berkas konfigurasi proyek di `cwd`.
 * Hanya membaca berkas langsung di `cwd` (tidak naik direktori).
 * Fail-closed: berkas hilang, JSON rusak, atau error baca menghasilkan daftar kosong untuk sumber tersebut.
 */
export function detectProjectValidationPatterns(
  cwd: string,
  readFile: ReadProjectFile,
): string[] {
  if (typeof cwd !== "string" || !cwd.trim()) return [];

  const patterns: string[] = [];
  const collect = (file: string, detect: (text: string) => string[]): void => {
    const text = readOptional(cwd, file, readFile);
    if (text === undefined) return;
    try {
      patterns.push(...detect(text));
    } catch {
      // Fail-closed: sumber yang tidak bisa diurai dilewati.
    }
  };

  collect("package.json", detectFromPackageJson);
  collect("Makefile", (text) =>
    makefileTargets(text)
      .filter((name) => (TASK_RUNNER_NAMES as readonly string[]).includes(name))
      .map(makePattern),
  );
  collect("justfile", (text) =>
    justRecipes(text)
      .filter((name) => (TASK_RUNNER_NAMES as readonly string[]).includes(name))
      .map(justPattern),
  );
  collect("pyproject.toml", detectFromPyproject);

  return [...new Set(patterns)];
}
