/**
 * Judge lapis 2 lewat model bersarang. Opsional dan fail-open:
 * kegagalan apa pun menghasilkan "tidak_diketahui", bukan blokir.
 * Modul ini tidak mengakses runtime Pi; pemanggil menyuntikkan fungsi complete.
 */

export interface JudgeInput {
  editedPaths: string[];
  validationCommands: string[];
  lastAssistantText: string;
}

export type NestedVerdict = "terverifikasi" | "tidak_terverifikasi" | "tidak_diketahui";

export interface VerdictOnly {
  verdict: NestedVerdict;
  reason?: string;
}

export interface NestedJudgeResult extends VerdictOnly {
  elapsedMs: number;
  timedOut: boolean;
}

/** Bentuk minimal respons model yang dibutuhkan judge. */
export interface CompletionLike {
  stopReason?: string;
  content?: unknown;
}

export type CompleteFn = (prompt: string, signal?: AbortSignal) => Promise<CompletionLike>;

export const JUDGE_PROMPT = [
  "Anda menilai apakah agent benar-benar memverifikasi perubahan kodenya.",
  "Jawab hanya dengan satu objek JSON: {\"verdict\":\"terverifikasi\"|\"tidak_terverifikasi\",\"reason\":\"<satu kalimat>\"}.",
  "Tandai terverifikasi bila ada bukti hasil uji atau build yang lulus setelah edit terakhir.",
  "Tandai tidak_terverifikasi bila tidak ada bukti seperti itu.",
].join("\n");

export function buildPrompt(input: JudgeInput): string {
  return [
    JUDGE_PROMPT,
    "",
    `File kode yang diedit: ${input.editedPaths.join(", ") || "(tidak ada)"}`,
    `Perintah validasi yang dijalankan: ${input.validationCommands.join(" | ") || "(tidak ada)"}`,
    `Klaim terakhir agent: ${input.lastAssistantText.slice(0, 2000)}`,
  ].join("\n");
}

/** Mengambil teks dari content respons model. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const record = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

/**
 * Mem-parse verdict dari teks model. Output yang tidak valid menjadi tidak_diketahui.
 */
export function parseVerdict(text: string): VerdictOnly {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "tidak_diketahui", reason: "no_json" };
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (parsed.verdict === "terverifikasi" || parsed.verdict === "tidak_terverifikasi") {
      return {
        verdict: parsed.verdict,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    }
    return { verdict: "tidak_diketahui", reason: "invalid_verdict" };
  } catch {
    return { verdict: "tidak_diketahui", reason: "invalid_json" };
  }
}

/**
 * Memaksa berhenti saat signal aborted, walau complete tidak menghormati signal.
 */
function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Menjalankan judge dengan batas waktu dan ikut dibatalkan bila signal sesi berhenti.
 * Tidak pernah melempar error. Mengembalikan elapsedMs dan timedOut untuk diagnosis.
 */
export async function runNestedJudge(
  input: JudgeInput,
  complete: CompleteFn,
  timeoutMs: number,
  sessionSignal?: AbortSignal,
  now: () => number = Date.now,
): Promise<NestedJudgeResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onSessionAbort = () => controller.abort();
  if (sessionSignal?.aborted) controller.abort();
  sessionSignal?.addEventListener("abort", onSessionAbort, { once: true });
  const started = now();
  const elapsed = () => now() - started;
  try {
    const response = await raceWithAbort(
      complete(buildPrompt(input), controller.signal),
      controller.signal,
    );
    const elapsedMs = elapsed();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return {
        verdict: "tidak_diketahui",
        reason: response.stopReason,
        elapsedMs,
        timedOut,
      };
    }
    return { ...parseVerdict(extractText(response.content)), elapsedMs, timedOut };
  } catch (err) {
    return {
      verdict: "tidak_diketahui",
      reason: (err as Error)?.message ?? "error",
      elapsedMs: elapsed(),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    sessionSignal?.removeEventListener("abort", onSessionAbort);
  }
}
