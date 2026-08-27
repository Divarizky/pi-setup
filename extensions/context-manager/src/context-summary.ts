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

export function formatSummary(summary: OutputSummary, source: string): string {
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
    "Gunakan ctx_inspect dengan path dan query untuk mengambil snippet yang relevan; untuk command, jalankan ulang dengan filter yang lebih sempit.",
  );
  return lines.join("\n");
}

export function findSnippets(
  text: string,
  query: string,
  maxSnippets: number,
): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const lines = text.split(/\r?\n/);
  const snippets: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const current = lines[index]?.toLowerCase() ?? "";
    if (!terms.every((term) => current.includes(term))) continue;

    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length, index + 2);
    const window = lines
      .slice(start, end)
      .map((line, offset) => `${start + offset + 1}: ${compactLine(line, 300)}`)
      .join("\n");
    snippets.push(window);
    if (snippets.length === maxSnippets) break;
  }
  return snippets;
}
