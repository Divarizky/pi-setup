import { createHash } from "node:crypto";

export interface LineAnchor {
  line: number; // 1-indexed
  hash: string; // 6-char hex
}

export interface HashEditParams {
  path: string;
  startAnchor: LineAnchor;
  endAnchor: LineAnchor;
  newContent: string;
}

export interface AnchorResolution {
  startIndex: number; // 0-indexed inclusive
  endIndex: number; // 0-indexed inclusive
  drift: number; // shift offset applied
}

export interface HashEditFailure {
  success: false;
  reason: string;
  contextSnippet?: string;
}

export interface HashEditSuccess {
  success: true;
  appliedRange: {
    startLine: number; // 1-indexed
    endLine: number; // 1-indexed
  };
  drift: number;
  resultContent: string;
}

export type HashEditResult = HashEditSuccess | HashEditFailure;

/**
 * Normalisasi dan kalkulasi hash baris (SHA-256 6-char hex).
 * Menghapus '\r' dan trailing whitespace sebelum hashing.
 */
export function computeLineHash(line: string): string {
  const normalized = line.replace(/\r$/, "").trimEnd();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 6);
}

/**
 * Deteksi format newline dominan dokumen (CRLF vs LF).
 */
export function detectNewline(content: string): "\r\n" | "\n" {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/[^\r]\n/g) || []).length;
  return crlfCount > lfCount ? "\r\n" : "\n";
}

/**
 * Membagi dokumen teks menjadi array baris tanpa newline trailing.
 */
export function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Format baris konteks untuk pesan error anchor miss.
 */
function buildContextSnippet(lines: string[], targetLine: number, radius = 5): string {
  const targetIndex = targetLine - 1;
  const start = Math.max(0, targetIndex - radius);
  const end = Math.min(lines.length - 1, targetIndex + radius);

  const snippetLines: string[] = [];
  for (let i = start; i <= end; i++) {
    const lineNum = i + 1;
    const marker = lineNum === targetLine ? ">>" : "  ";
    const hash = computeLineHash(lines[i]);
    snippetLines.push(`${marker} ${lineNum.toString().padStart(4, " ")} [${hash}]: ${lines[i]}`);
  }
  return snippetLines.join("\n");
}

/**
 * Mencari pasangan startAnchor dan endAnchor pada teks dengan toleransi window scan (+/- radius).
 */
export function resolveAnchors(
  lines: string[],
  startAnchor: LineAnchor,
  endAnchor: LineAnchor,
  scanRadius = 15
): { resolved?: AnchorResolution; failure?: HashEditFailure } {
  if (lines.length === 0) {
    return {
      failure: {
        success: false,
        reason: "Berkas kosong; tidak memiliki baris untuk dicocokkan dengan anchor.",
      },
    };
  }

  if (startAnchor.line < 1 || endAnchor.line < 1) {
    return {
      failure: {
        success: false,
        reason: `Nomor baris anchor tidak valid: startAnchor.line=${startAnchor.line}, endAnchor.line=${endAnchor.line}. Harus >= 1.`,
      },
    };
  }

  if (startAnchor.line > endAnchor.line) {
    return {
      failure: {
        success: false,
        reason: `startAnchor.line (${startAnchor.line}) tidak boleh lebih besar dari endAnchor.line (${endAnchor.line}).`,
      },
    };
  }

  const targetStartIndex = startAnchor.line - 1;
  const targetEndIndex = endAnchor.line - 1;

  // 1. Cek kecocokan eksak tanpa pergeseran
  const exactStartMatch =
    targetStartIndex < lines.length && computeLineHash(lines[targetStartIndex]) === startAnchor.hash;
  const exactEndMatch =
    targetEndIndex < lines.length && computeLineHash(lines[targetEndIndex]) === endAnchor.hash;

  if (exactStartMatch && exactEndMatch) {
    return {
      resolved: {
        startIndex: targetStartIndex,
        endIndex: targetEndIndex,
        drift: 0,
      },
    };
  }

  // 2. Pemindaian window (+/- scanRadius) untuk mendeteksi drift
  const candidateStartDrifts: number[] = [];
  const minStartSearch = Math.max(0, targetStartIndex - scanRadius);
  const maxStartSearch = Math.min(lines.length - 1, targetStartIndex + scanRadius);

  for (let i = minStartSearch; i <= maxStartSearch; i++) {
    if (computeLineHash(lines[i]) === startAnchor.hash) {
      candidateStartDrifts.push(i - targetStartIndex);
    }
  }

  // Cari drift yang cocok untuk endAnchor dengan delta yang sama
  for (const drift of candidateStartDrifts) {
    const candidateEndIndex = targetEndIndex + drift;
    if (
      candidateEndIndex >= 0 &&
      candidateEndIndex < lines.length &&
      computeLineHash(lines[candidateEndIndex]) === endAnchor.hash
    ) {
      const candidateStartIndex = targetStartIndex + drift;
      if (candidateStartIndex <= candidateEndIndex) {
        return {
          resolved: {
            startIndex: candidateStartIndex,
            endIndex: candidateEndIndex,
            drift,
          },
        };
      }
    }
  }

  // 3. Anchor miss penanganan error
  let missReason = "";
  let focusLine = startAnchor.line;

  if (!exactStartMatch && exactEndMatch) {
    missReason = `Hash startAnchor [${startAnchor.hash}] meleset pada baris ${startAnchor.line} (tidak ditemukan dalam radius ±${scanRadius} baris dengan delta konsisten).`;
    focusLine = startAnchor.line;
  } else if (exactStartMatch && !exactEndMatch) {
    missReason = `Hash endAnchor [${endAnchor.hash}] meleset pada baris ${endAnchor.line} (tidak ditemukan dalam radius ±${scanRadius} baris dengan delta konsisten).`;
    focusLine = endAnchor.line;
  } else {
    missReason = `Kedua anchor start [${startAnchor.hash}] dan end [${endAnchor.hash}] tidak cocok atau bergeser secara asimetris pada baris ${startAnchor.line}-${endAnchor.line}.`;
    focusLine = startAnchor.line;
  }

  return {
    failure: {
      success: false,
      reason: missReason,
      contextSnippet: buildContextSnippet(lines, focusLine),
    },
  };
}

/**
 * Terapkan hash edit pada konten teks.
 */
export function applyHashEditToText(
  originalContent: string,
  startAnchor: LineAnchor,
  endAnchor: LineAnchor,
  newContent: string,
  scanRadius = 15
): HashEditResult {
  const originalNewline = detectNewline(originalContent);
  const lines = splitLines(originalContent);

  const { resolved, failure } = resolveAnchors(lines, startAnchor, endAnchor, scanRadius);
  if (failure || !resolved) {
    return failure || { success: false, reason: "Gagal menyelesaikan anchor." };
  }

  const replacementLines = splitLines(newContent);
  const beforeLines = lines.slice(0, resolved.startIndex);
  const afterLines = lines.slice(resolved.endIndex + 1);

  const finalLines = [...beforeLines, ...replacementLines, ...afterLines];
  const finalContent = finalLines.join(originalNewline);

  return {
    success: true,
    appliedRange: {
      startLine: resolved.startIndex + 1,
      endLine: resolved.startIndex + replacementLines.length,
    },
    drift: resolved.drift,
    resultContent: finalContent,
  };
}
