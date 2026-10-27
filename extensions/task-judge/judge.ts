import { extname } from "node:path";

export const DEFAULT_DOC_EXTENSIONS: readonly string[] = [
  ".md",
  ".mdx",
  ".txt",
  ".rst",
];

export const DEFAULT_VALIDATION_PATTERNS: readonly string[] = [
  String.raw`\bnpm\s+run\s+(check|test|lint|build)\b`,
  String.raw`\bnpm\s+test\b`,
  String.raw`\bnpx\s+tsc\b`,
  String.raw`\btsc\s+--noEmit\b`,
  String.raw`\bnode\s+--test\b`,
  String.raw`\bpytest\b`,
  String.raw`\bpy(?:thon(?:\d+)?)?\s+-m\s+pytest\b`,
  String.raw`\bgradlew(?:\.bat)?\s+(test|build|check)\b`,
  String.raw`\bcargo\s+(test|check|build)\b`,
  String.raw`\bgo\s+test\b`,
];

export type JudgeDecision =
  | "terverifikasi"
  | "tidak_terverifikasi"
  | "dikecualikan";

export interface FileEditRecord {
  path: string;
  order: number;
  timestamp: number;
}

export interface ValidationRecord {
  command: string;
  success: boolean;
  order: number;
  timestamp: number;
}

export interface TaskJudgeState {
  edits: FileEditRecord[];
  validations: ValidationRecord[];
  nextOrder: number;
}

export interface JudgeEvaluationResult {
  decision: JudgeDecision;
  editCount: number;
  hasSuccessfulValidation: boolean;
  unverifiedReason?: string;
}

export interface EvaluateOptions {
  docExtensions?: readonly string[];
  validationPatterns?: readonly string[];
}

export function createInitialState(): TaskJudgeState {
  return {
    edits: [],
    validations: [],
    nextOrder: 1,
  };
}

export function recordEdit(
  state: TaskJudgeState,
  filePath: string,
  timestamp: number = Date.now(),
): TaskJudgeState {
  if (!state || !Array.isArray(state.edits)) {
    return createInitialState();
  }
  return {
    ...state,
    edits: [
      ...state.edits,
      {
        path: filePath,
        order: state.nextOrder,
        timestamp,
      },
    ],
    nextOrder: state.nextOrder + 1,
  };
}

export function recordValidation(
  state: TaskJudgeState,
  command: string,
  success: boolean,
  timestamp: number = Date.now(),
): TaskJudgeState {
  if (!state || !Array.isArray(state.validations)) {
    return createInitialState();
  }
  return {
    ...state,
    validations: [
      ...state.validations,
      {
        command,
        success,
        order: state.nextOrder,
        timestamp,
      },
    ],
    nextOrder: state.nextOrder + 1,
  };
}

export function isDocumentFile(
  filePath: string,
  docExtensions: readonly string[] = DEFAULT_DOC_EXTENSIONS,
): boolean {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  const ext = extname(filePath.trim()).toLowerCase();
  if (!ext) return false;
  const normalized = docExtensions.map((d) =>
    d.startsWith(".") ? d.toLowerCase() : `.${d.toLowerCase()}`,
  );
  return normalized.includes(ext);
}

export const NON_VALIDATING_PREFIXES: readonly string[] = [
  "echo",
  "printf",
  "grep",
  "rg",
  "cat",
  "git",
];

export function splitCommandSegments(command: string): string[] {
  if (typeof command !== "string" || !command.trim()) return [];

  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    if (quote) {
      if (char === "\\" && quote === '"' && i + 1 < command.length) {
        current += char + command[i + 1];
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      current += char;
      i++;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      i++;
      continue;
    }

    // Check for comments outside quotes
    if (char === "#") {
      // Discard rest of the line until newline
      const nextNewline = command.indexOf("\n", i);
      if (nextNewline === -1) {
        break; // rest of string is comment
      }
      // Push segment up to here if non-empty
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      i = nextNewline + 1;
      continue;
    }

    // Check for separators outside quotes: &&, ||, ;, |, \n, \r
    if (
      (char === "&" && command[i + 1] === "&") ||
      (char === "|" && command[i + 1] === "|")
    ) {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      i += 2;
      continue;
    }

    if (char === ";" || char === "|" || char === "\n" || char === "\r") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      i++;
      continue;
    }

    current += char;
    i++;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

export function cleanSegment(segment: string): string {
  let cleaned = segment.trim();

  // Strip leading variable assignments like FOO=1 BAR=2
  while (/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/.test(cleaned)) {
    cleaned = cleaned.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/, "").trim();
  }

  // Strip leading path traversal like ./ or .\
  if (cleaned.startsWith("./") || cleaned.startsWith(".\\")) {
    cleaned = cleaned.slice(2).trim();
  }

  return cleaned;
}

export function isValidationCommand(
  command: string,
  patterns: readonly string[] = DEFAULT_VALIDATION_PATTERNS,
): boolean {
  if (typeof command !== "string" || !command.trim()) return false;

  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;

  for (const rawSegment of segments) {
    const segment = cleanSegment(rawSegment);
    if (!segment) continue;

    // Check non-validating prefixes first (e.g. echo, cat, git, grep, etc.)
    const hasForbiddenPrefix = NON_VALIDATING_PREFIXES.some((prefix) => {
      const re = new RegExp(String.raw`^${prefix}(?:\s+|$)`, "i");
      return re.test(segment);
    });
    if (hasForbiddenPrefix) {
      continue;
    }

    // Must match at the start of the segment
    const isMatch = patterns.some((pattern) => {
      try {
        // Strip leading \b or ^ from pattern if any, then anchor at start
        let normalized = pattern;
        if (normalized.startsWith(String.raw`\b`)) {
          normalized = normalized.slice(2);
        } else if (normalized.startsWith("^")) {
          normalized = normalized.slice(1);
        }
        return new RegExp(String.raw`^${normalized}`).test(segment);
      } catch {
        return false;
      }
    });

    if (isMatch) {
      return true;
    }
  }

  return false;
}


export function evaluateRun(
  state: TaskJudgeState,
  options?: EvaluateOptions,
): JudgeEvaluationResult {
  if (
    !state ||
    !Array.isArray(state.edits) ||
    !Array.isArray(state.validations)
  ) {
    return {
      decision: "dikecualikan",
      editCount: 0,
      hasSuccessfulValidation: false,
      unverifiedReason: "invalid_state",
    };
  }

  const docExtensions = options?.docExtensions ?? DEFAULT_DOC_EXTENSIONS;
  const editCount = state.edits.length;
  const hasSuccessfulValidation = state.validations.some((v) => v.success);

  const nonDocEdits = state.edits.filter(
    (edit) => !isDocumentFile(edit.path, docExtensions),
  );

  if (nonDocEdits.length === 0) {
    return {
      decision: "dikecualikan",
      editCount,
      hasSuccessfulValidation,
    };
  }

  const lastCodeEdit = nonDocEdits[nonDocEdits.length - 1];
  const hasSuccessAfterLastCodeEdit = state.validations.some(
    (validation) => validation.success && validation.order > lastCodeEdit.order,
  );

  if (hasSuccessAfterLastCodeEdit) {
    return {
      decision: "terverifikasi",
      editCount,
      hasSuccessfulValidation,
    };
  }

  return {
    decision: "tidak_terverifikasi",
    editCount,
    hasSuccessfulValidation,
    unverifiedReason: hasSuccessfulValidation
      ? "validation_before_last_edit"
      : "no_successful_validation",
  };
}
