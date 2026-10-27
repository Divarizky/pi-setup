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

export function isValidationCommand(
  command: string,
  patterns: readonly string[] = DEFAULT_VALIDATION_PATTERNS,
): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(command);
    } catch {
      return false;
    }
  });
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
