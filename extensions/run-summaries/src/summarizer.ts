import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SummaryConfig } from "./config.ts";
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from "./prompt.ts";

const RECAP_MAX_LENGTH = 2_400;
const NEXT_MAX_LENGTH = 400;

export class SummaryError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SummaryError";
    this.cause = cause;
  }
}

export interface RunRecap {
  readonly recap: string;
  readonly next: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function cleanField(value: string, maxLength: number) {
  const cleaned = value
    .replace(
      // Strip ANSI/OSC sequences before rendering model output in the terminal.
      // eslint-disable-next-line no-control-regex
      /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g,
      "",
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function parseCandidate(candidate: string) {
  try {
    const value: unknown = JSON.parse(candidate);
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "next,recap" ||
      typeof value.recap !== "string" ||
      typeof value.next !== "string"
    ) {
      return undefined;
    }

    const recap = cleanField(value.recap, RECAP_MAX_LENGTH);
    const next = cleanField(
      value.next.replace(/^next\s*:\s*/i, ""),
      NEXT_MAX_LENGTH,
    );
    if (!recap || !next) return undefined;
    return { recap, next } satisfies RunRecap;
  } catch {
    return undefined;
  }
}

export function parseRecapResponse(text: string) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }
  throw new SummaryError("The summary model did not return valid recap JSON.");
}

export function reasoningOptions(reasoning: SummaryConfig["reasoning"]) {
  return reasoning === "off" ? {} : { reasoning };
}

function assistantText(
  content: ReadonlyArray<unknown>,
) {
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as any).type === "text" &&
        typeof (block as any).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

export async function summarizeRun(options: {
  readonly modelRegistry: ModelRegistry;
  readonly config: SummaryConfig;
  readonly transcript: string;
  readonly signal?: AbortSignal;
}) {
  const timeoutSignal = AbortSignal.timeout(35_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const model = options.modelRegistry.find(
    options.config.provider,
    options.config.model,
  );
  if (!model) {
    throw new SummaryError(
      `Summary model is unavailable: ${options.config.provider}/${options.config.model}`,
    );
  }

  const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new SummaryError(auth.error);

  const effectiveModel = auth.baseUrl
    ? { ...model, baseUrl: auth.baseUrl }
    : model;

  try {
    const response = await options.modelRegistry.complete(
      effectiveModel,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildSummaryPrompt(options.transcript),
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        env: auth.env,
        headers: auth.headers,
        maxTokens: 1_000,
        maxRetries: 1,
        signal,
        timeoutMs: 30_000,
        ...reasoningOptions(options.config.reasoning),
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new SummaryError(
        response.errorMessage ?? "Summary model request failed.",
      );
    }
    return parseRecapResponse(assistantText(response.content));
  } catch (error) {
    if (error instanceof SummaryError) throw error;
    throw new SummaryError(
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}