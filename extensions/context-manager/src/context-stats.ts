export interface ContextStats {
  summarizedOutputs: number;
  originalChars: number;
  retainedChars: number;
  originalLines: number;
  retainedLines: number;
  inspectCalls: number;
  outputRetrievals: number;
  estimatedOriginalTokens: number;
  estimatedRetainedTokens: number;
  prunedOutputs: number;
  prunedChars: number;
  estimatedPrunedTokens: number;
}

export function createContextStats(): ContextStats {
  return {
    summarizedOutputs: 0,
    originalChars: 0,
    retainedChars: 0,
    originalLines: 0,
    retainedLines: 0,
    inspectCalls: 0,
    outputRetrievals: 0,
    estimatedOriginalTokens: 0,
    estimatedRetainedTokens: 0,
    prunedOutputs: 0,
    prunedChars: 0,
    estimatedPrunedTokens: 0,
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
  stats.estimatedOriginalTokens += estimateTokens(original);
  stats.estimatedRetainedTokens += estimateTokens(retained);
}

export function recordRetrieval(stats: ContextStats): void {
  stats.outputRetrievals += 1;
}

export function recordPrune(
  stats: ContextStats,
  original: string,
  replacement: string,
): void {
  stats.prunedOutputs += 1;
  stats.prunedChars += Math.max(0, original.length - replacement.length);
  stats.estimatedPrunedTokens += Math.max(
    0,
    estimateTokens(original) - estimateTokens(replacement),
  );
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
    "Context Manager — Sesi Aktif",
    "├─ Ukuran",
    `│  ├─ Pemrosesan: ${stats.originalChars.toLocaleString("id-ID")} karakter (${stats.originalLines.toLocaleString("id-ID")} baris) → ${stats.retainedChars.toLocaleString("id-ID")} karakter (${stats.retainedLines.toLocaleString("id-ID")} baris)`,
    `│  └─ Penghematan: ${savedChars.toLocaleString("id-ID")} karakter, ${savedLines.toLocaleString("id-ID")} baris (${formatPercent(savingsPercent)} hemat)`,
    "├─ Token",
    `│  └─ Alokasi: ${stats.estimatedOriginalTokens.toLocaleString("id-ID")} token asli → ${stats.estimatedRetainedTokens.toLocaleString("id-ID")} token masuk context`,
    "├─ Pemangkasan Output Lama",
    `│  └─ Hasil: ${stats.prunedOutputs} output | ${stats.prunedChars.toLocaleString("id-ID")} karakter | ${stats.estimatedPrunedTokens.toLocaleString("id-ID")} token dihemat`,
    "├─ Aktivitas",
    `│  └─ Operasi: ${stats.summarizedOutputs} output diringkas | ${stats.inspectCalls} kali ctx_inspect | ${stats.outputRetrievals} kali output cache`,
    "└─ Status: Normal",
  ].join("\n");
}
