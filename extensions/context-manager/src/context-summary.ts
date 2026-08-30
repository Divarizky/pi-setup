export interface OutputSummary {
  totalLines: number;
  totalChars: number;
  errorLines: string[];
  warningLines: string[];
  preview: string[];
  omittedLines: number;
}

const ERROR_PATTERN =
  /\b(error|exception|failed|failure|fatal|panic|traceback)\b/i;
const WARNING_PATTERN = /\b(warn(?:ing)?|deprecated|retry|timeout)\b/i;

function compactLine(line: string, maxChars: number): string {
  const normalized = line.trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1)}…`;
}

function uniqueMatches(
  lines: string[],
  pattern: RegExp,
  limit: number,
): string[] {
  const matches: string[] = [];
  for (const line of lines) {
    if (pattern.test(line)) {
      matches.push(compactLine(line, 240));
      if (matches.length === limit) break;
    }
  }
  return matches;
}

export function summarizeOutput(text: string, previewSize = 3): OutputSummary {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const preview = [
    ...nonEmpty.slice(0, previewSize),
    ...nonEmpty.slice(-previewSize),
  ]
    .filter((line, index, values) => values.indexOf(line) === index)
    .map((line) => compactLine(line, 240));

  return {
    totalLines: lines.length,
    totalChars: text.length,
    errorLines: uniqueMatches(lines, ERROR_PATTERN, 8),
    warningLines: uniqueMatches(lines, WARNING_PATTERN, 5),
    preview,
    omittedLines: Math.max(0, nonEmpty.length - preview.length),
  };
}

export function formatSummary(
  summary: OutputSummary,
  source: string,
  retrievalInstruction?: string,
): string {
  const lines = [
    `[context-manager] Output ${source} diringkas secara lokal`,
    `Ukuran asli: ${summary.totalLines} baris, ${summary.totalChars.toLocaleString("id-ID")} karakter.`,
  ];

  if (summary.errorLines.length > 0) {
    lines.push(
      "Error penting:",
      ...summary.errorLines.map((line) => `- ${line}`),
    );
  }
  if (summary.warningLines.length > 0) {
    lines.push(
      "Peringatan:",
      ...summary.warningLines.map((line) => `- ${line}`),
    );
  }
  if (summary.preview.length > 0) {
    lines.push("Preview:", ...summary.preview.map((line) => `- ${line}`));
  }
  if (summary.omittedLines > 0) {
    lines.push(
      `${summary.omittedLines} baris lain tidak dimasukkan ke context.`,
    );
  }
  lines.push(
    retrievalInstruction ??
      "Gunakan ctx_inspect dengan path dan query untuk mengambil snippet yang relevan; untuk command, jalankan ulang dengan filter yang lebih sempit.",
  );
  return lines.join("\n");
}

export interface SnippetOptions {
  before?: number;
  after?: number;
}

export function findSnippets(
  text: string,
  query: string,
  maxSnippets: number,
  options: SnippetOptions = {},
): string[] {
  if (query.length > 500) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 32);
  if (terms.length === 0) return [];

  const limit = Math.max(1, Math.min(maxSnippets, 10));
  const before = Math.max(0, Math.min(options.before ?? 1, 20));
  const after = Math.max(0, Math.min(options.after ?? 1, 20));
  const lines = text.split(/\r?\n/);
  const snippets: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const current = lines[index]?.toLowerCase() ?? "";
    if (!terms.every((term) => current.includes(term))) continue;

    const start = Math.max(0, index - before);
    const end = Math.min(lines.length, index + after + 1);
    const window = lines
      .slice(start, end)
      .map((line, offset) => `${start + offset + 1}: ${compactLine(line, 300)}`)
      .join("\n");
    snippets.push(window);
    if (snippets.length === limit) break;
  }
  return snippets;
}

export function formatLineRange(
  text: string,
  start: number,
  end: number,
): string {
  const lines = text.split(/\r?\n/);
  const first = Math.max(1, Math.min(start, lines.length));
  const last = Math.max(first, Math.min(end, lines.length));
  return lines
    .slice(first - 1, last)
    .map((line, offset) => `${first + offset}: ${compactLine(line, 300)}`)
    .join("\n");
}
