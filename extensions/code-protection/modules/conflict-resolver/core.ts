export interface ConflictHunk {
  id: number;
  startLine: number;
  endLine: number;
  ours: string[];
  base?: string[];
  theirs: string[];
}

export interface ParsedConflictFile {
  hasConflicts: boolean;
  hunks: ConflictHunk[];
  cleanLines: string[];
}

const CONFLICT_START = "<<<<<<<";
const CONFLICT_BASE = "|||||||";
const CONFLICT_SPLIT = "=======";
const CONFLICT_END = ">>>>>>>";

/**
 * Parsing berkas yang memiliki penanda konflik merge Git (diff3 atau standard 2-way).
 */
export function parseConflictMarkers(content: string): ParsedConflictFile {
  const rawLines = content.replace(/\r\n/g, "\n").split("\n");
  const hunks: ConflictHunk[] = [];
  let inConflict = false;
  let inBase = false;
  let inTheirs = false;

  let currentOurs: string[] = [];
  let currentBase: string[] | undefined = undefined;
  let currentTheirs: string[] = [];
  let hunkStartLine = 0;
  let hunkIdCounter = 1;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const lineNum = i + 1;

    if (line.startsWith(CONFLICT_START)) {
      inConflict = true;
      inBase = false;
      inTheirs = false;
      hunkStartLine = lineNum;
      currentOurs = [];
      currentBase = undefined;
      currentTheirs = [];
    } else if (inConflict && line.startsWith(CONFLICT_BASE)) {
      inBase = true;
      currentBase = [];
    } else if (inConflict && line.startsWith(CONFLICT_SPLIT)) {
      inBase = false;
      inTheirs = true;
    } else if (inConflict && line.startsWith(CONFLICT_END)) {
      inConflict = false;
      inBase = false;
      inTheirs = false;
      hunks.push({
        id: hunkIdCounter++,
        startLine: hunkStartLine,
        endLine: lineNum,
        ours: currentOurs,
        base: currentBase,
        theirs: currentTheirs,
      });
    } else if (inConflict) {
      if (inTheirs) {
        currentTheirs.push(line);
      } else if (inBase) {
        currentBase?.push(line);
      } else {
        currentOurs.push(line);
      }
    }
  }

  return {
    hasConflicts: hunks.length > 0,
    hunks,
    cleanLines: rawLines,
  };
}

export type ConflictResolutionChoice = "ours" | "theirs" | "both" | "custom";

export interface HunkResolution {
  hunkId: number;
  choice: ConflictResolutionChoice;
  customContent?: string;
}

/**
 * Menerapkan resolusi konflik pada teks dokumen.
 */
export function applyConflictResolutions(
  content: string,
  resolutions: HunkResolution[]
): { success: boolean; resolvedContent: string; remainingConflicts: number; error?: string } {
  const parsed = parseConflictMarkers(content);
  if (!parsed.hasConflicts) {
    return {
      success: true,
      resolvedContent: content,
      remainingConflicts: 0,
    };
  }

  const resMap = new Map<number, HunkResolution>();
  for (const r of resolutions) {
    resMap.set(r.hunkId, r);
  }

  const rawLines = content.replace(/\r\n/g, "\n").split("\n");
  const outputLines: string[] = [];

  let lineIndex = 0;
  let remainingCount = 0;

  while (lineIndex < rawLines.length) {
    const line = rawLines[lineIndex];

    if (line.startsWith(CONFLICT_START)) {
      // Temukan hunk terkait
      const currentHunk = parsed.hunks.find((h) => h.startLine === lineIndex + 1);
      if (!currentHunk) {
        outputLines.push(line);
        lineIndex++;
        continue;
      }

      const resolution = resMap.get(currentHunk.id);
      if (!resolution) {
        // Tidak ada resolusi untuk hunk ini, pertahankan penanda konflik
        remainingCount++;
        while (lineIndex < rawLines.length && !rawLines[lineIndex].startsWith(CONFLICT_END)) {
          outputLines.push(rawLines[lineIndex]);
          lineIndex++;
        }
        if (lineIndex < rawLines.length) {
          outputLines.push(rawLines[lineIndex]); // line >>>>>>>
          lineIndex++;
        }
        continue;
      }

      // Terapkan resolusi
      switch (resolution.choice) {
        case "ours":
          outputLines.push(...currentHunk.ours);
          break;
        case "theirs":
          outputLines.push(...currentHunk.theirs);
          break;
        case "both":
          outputLines.push(...currentHunk.ours);
          outputLines.push(...currentHunk.theirs);
          break;
        case "custom":
          if (typeof resolution.customContent === "string") {
            const customLines = resolution.customContent.replace(/\r\n/g, "\n").split("\n");
            outputLines.push(...customLines);
          }
          break;
      }

      // Lewati baris sampai akhir penanda konflik
      while (lineIndex < rawLines.length && !rawLines[lineIndex].startsWith(CONFLICT_END)) {
        lineIndex++;
      }
      if (lineIndex < rawLines.length) {
        lineIndex++; // lewati >>>>>>>
      }
    } else {
      outputLines.push(line);
      lineIndex++;
    }
  }

  return {
    success: remainingCount === 0,
    resolvedContent: outputLines.join("\n"),
    remainingConflicts: remainingCount,
  };
}
