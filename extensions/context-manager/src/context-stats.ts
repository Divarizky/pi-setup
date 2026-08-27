export interface ContextStats {
  summarizedOutputs: number;
  originalChars: number;
  retainedChars: number;
  originalLines: number;
  retainedLines: number;
  inspectCalls: number;
}

export function createContextStats(): ContextStats {
  return {
    summarizedOutputs: 0,
    originalChars: 0,
    retainedChars: 0,
    originalLines: 0,
    retainedLines: 0,
    inspectCalls: 0,
  };
}

export function recordSummary(
  stats: ContextStats,
  original: string,
  retained: string,
): void {
  stats.summarizedOutputs += 1;
  stats.originalChars += original.length;
  stats.retainedChars += retained.length;
  stats.originalLines += original.split(/\r?\n/).length;
  stats.retainedLines += retained.split(/\r?\n/).length;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1).replace(".", ",")}%`;
}

export function formatContextStats(stats: ContextStats): string {
  const savedChars = stats.originalChars - stats.retainedChars;
  const savedLines = stats.originalLines - stats.retainedLines;
  const savingsPercent =
    stats.originalChars === 0 ? 0 : (savedChars / stats.originalChars) * 100;

  return [
    "Context Manager — statistik sesi",
    `Output besar diringkas: ${stats.summarizedOutputs}`,
    `Ukuran asli: ${stats.originalChars.toLocaleString("id-ID")} karakter (${stats.originalLines.toLocaleString("id-ID")} baris)`,
    `Masuk ke context: ${stats.retainedChars.toLocaleString("id-ID")} karakter (${stats.retainedLines.toLocaleString("id-ID")} baris)`,
    `Dihemat: ${savedChars.toLocaleString("id-ID")} karakter, ${savedLines.toLocaleString("id-ID")} baris (${formatPercent(savingsPercent)})`,
    `Pemakaian ctx_inspect: ${stats.inspectCalls}`,
  ].join("\n");
}
