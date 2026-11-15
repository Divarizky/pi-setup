import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { matchesRuleScope } from "./rule.ts";
import type { Rule, TtsrDeps, ViolationEntry } from "./types.ts";

/**
 * Pola perintah bash yang dianggap sebagai verifikasi/validasi.
 * Cocok dengan test, check, build, tsc, lint, dan git diff (FR-9).
 */
export const VERIFICATION_COMMAND_REGEX =
  /(?:^|[;&|\s])(?:npm\s+(?:run\s+)?(?:test|check|build|lint)|pnpm\s+(?:run\s+)?(?:test|check|build|lint)|yarn\s+(?:run\s+)?(?:test|check|build|lint)|bun\s+(?:run\s+)?(?:test|check|build|lint)|vitest|jest|mocha|pytest|cargo\s+test|go\s+test|tsc\b|eslint\b|biome\s+check|git\s+diff\b)/i;

/**
 * Daftar tool yang diklasifikasikan sebagai mutasi (FR-9).
 */
export const MUTATION_TOOLS = new Set([
  "edit",
  "write",
  "hash_edit",
  "conflict_resolver",
]);

export interface SettleGateState {
  hasMutation: boolean;
  hasVerification: boolean;
  settleRejectedCount: number;
}

export function createSettleGateState(): SettleGateState {
  return {
    hasMutation: false,
    hasVerification: false,
    settleRejectedCount: 0,
  };
}

/**
 * Mengekstrak teks dari pesan user terakhir. Mendukung struktur pesan
 * array atau string biasa, baik dari sessionManager, event prompt, atau context.
 */
export function extractLastUserText(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry) continue;

      // Bentuk 1: entry bertipe 'message' dengan message.role === 'user'
      const maybeMsg = (entry as { message?: { role?: string; content?: unknown } }).message;
      if (maybeMsg && maybeMsg.role === "user") {
        const c = maybeMsg.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return c
            .map((part: unknown) => {
              if (typeof part === "string") return part;
              if (part && typeof part === "object" && "text" in part) {
                return String((part as { text?: unknown }).text ?? "");
              }
              return "";
            })
            .join(" ");
        }
      }

      // Bentuk 2: entry bertipe user_prompt / sejenisnya
      const directRole = (entry as { role?: string; text?: unknown; prompt?: unknown }).role;
      if (directRole === "user") {
        const text =
          (entry as { text?: unknown }).text ??
          (entry as { prompt?: unknown }).prompt;
        if (typeof text === "string") return text;
      }
    }
  } catch {
    // Fail-open jika sessionManager tidak tersedia
  }
  return "";
}

/**
 * Jawaban bebas ask_user memerlukan afirmasi eksplisit; pilihan opsional harus cocok
 * dengan salah satu pilihan yang ditampilkan dan menyebut semua operasi yang diminta.
 */
const ASK_USER_AFFIRMATIVE_WORDS = new Set([
  "ya", "iya", "yes", "yep", "setuju", "agree", "oke", "ok", "okay", "silakan", "silahkan",
  "lanjut", "lanjutkan", "boleh", "sure", "go", "ahead", "proceed",
]);
const ASK_USER_NEUTRAL_WORDS = new Set([
  "commit", "push", "and", "or", "now", "sekarang", "today", "only", "just", "saja", "aja",
  "this", "these", "that", "it", "the", "a", "an", "my", "me", "i", "you", "please",
  "to", "for", "with", "changes", "change", "perubahan", "ini", "itu", "all", "selected",
  "current", "new", "code", "repo", "repository", "branch", "origin", "upstream", "main", "master",
  "full", "complete", "lengkap", "ringkas", "final", "version", "do",
]);

function hasOnlyApprovalWords(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.length > 0 && words.every(
    (word) => ASK_USER_AFFIRMATIVE_WORDS.has(word) || ASK_USER_NEUTRAL_WORDS.has(word),
  );
}

function isAffirmativeAskAnswer(answer: string): boolean {
  // Karakter di luar huruf, angka, spasi, dan tanda baca dasar (mis. "不要", "❌") membuat jawaban ditolak.
  if (/[^\p{L}\p{N}\s.,!?'"’\-]/u.test(answer)) return false;
  if (/[^\x00-\x7F]/u.test(answer)) return false;
  const words = answer.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some((w) => ASK_USER_AFFIRMATIVE_WORDS.has(w)) &&
    !containsGitNegation(answer) &&
    hasOnlyApprovalWords(answer);
}

const GIT_NEGATION_REGEX = /\b(?:jangan|jgn|tidak|tak|ga|gak|nggak|enggak|kagak|belum|bukan|hindari|stop|batalkan|dibatalkan|ditolak|urungkan|tunda|nanti|gausah|gakusah|nggakusah|ora|ogah|cancel(?:led)?|refuse|reject|decline|deny|don['’]t|can(?:not|['’]t|t)|won['’]t|wont|shouldn['’]t|couldn['’]t|wouldn['’]t|do\s+not|not|never|without|no)\b/i;

const GIT_STATEMENT_REGEX = /\b(?:commit|push)\s+(?:is|are|was|were|may|might|should|could|would|will|must|can|cannot|can['’]t|seems|sounds|appears|means|command|message|log|history|word|term|phrase|option|rule|flow|behavior|policy|idea|appears|mentioned|occurs|needs|needed|has|have|had)\b/i;

function containsGitNegation(text: string): boolean {
  return GIT_NEGATION_REGEX.test(text);
}

function isDirectGitPermission(text: string, verbs: Set<string>): boolean {
  if (verbs.size === 0) return false;

  const operation = "(?:git\\s+)?(?:commit|push)\\b";
  const command = new RegExp(
    `^\\s*(?:(?:please|tolong|silakan|silahkan|lakukan|jalankan|buat|kerjakan|run|execute|go\\s+ahead\\s+and|ya|iya|yes|oke|ok|okay|setuju|sure)[,!:]?\\s+)*${operation}`,
    "i",
  );
  const directRequest = new RegExp(`^\\s*(?:can|could|would)\\s+you\\s+(?:please\\s+)?${operation}`, "i");
  const statedIntent = new RegExp(
    `^\\s*(?:i\\s+(?:want|would\\s+like)\\s+to|saya\\s+mau|aku\\s+mau|gua\\s+mau|gue\\s+mau)\\s+${operation}`,
    "i",
  );
  const authorizedVerbs = new Set<string>();
  const clauses = text.match(/[^.!?;\n]+[.!?;]?/g) ?? [];
  for (const clause of clauses) {
    if (containsGitNegation(clause) &&
      [...verbs].some((verb) => new RegExp(`\\b${verb}\\b`, "i").test(clause))) return false;
  }

  for (const clause of clauses) {
    if (containsGitNegation(clause) || GIT_STATEMENT_REGEX.test(clause)) continue;
    const requestClause = clause.split(/[?¿]/, 1)[0];
    const directMatch = directRequest.exec(requestClause);
    if (/[?¿]/.test(clause) && !directMatch) continue;

    const normalizedClause = clause.trim().toLowerCase();
    const skillInvocation = [
      "/skill:git-commit",
      "git-commit",
      "jalankan skill git-commit",
      "run skill git-commit",
      "run the git-commit skill",
    ].includes(normalizedClause);
    if (skillInvocation) {
      authorizedVerbs.add("commit");
      continue;
    }

    const commandMatch = command.exec(clause);
    const intentMatch = statedIntent.exec(clause);
    const actionMatch = commandMatch ?? directMatch ?? intentMatch;
    if (!actionMatch || actionMatch.index === undefined) continue;

    const firstVerb = /\b(commit|push)\b/i.exec(actionMatch[0])?.[1]?.toLowerCase();
    if (firstVerb) authorizedVerbs.add(firstVerb);

    const sequence = /\b(?:and(?:\s+(?:also|then))?|then)\s+(?:git\s+)?(commit|push)\b|&&\s*(?:git\s+)?(commit|push)\b/gi;
    sequence.lastIndex = actionMatch.index + actionMatch[0].length;
    for (let next = sequence.exec(clause); next; next = sequence.exec(clause)) {
      const verb = (next[1] ?? next[2])?.toLowerCase();
      if (verb) authorizedVerbs.add(verb);
    }
  }

  return [...verbs].every((verb) => authorizedVerbs.has(verb));
}

function isSelectedGitApproval(
  answer: string,
  details: { options?: unknown; wasCustom?: unknown },
  verbs: Set<string>,
): boolean {
  if (details.wasCustom !== false || !Array.isArray(details.options)) return false;
  const selected = details.options.find(
    (option): option is string => typeof option === "string" && option === answer,
  );
  if (!selected || containsGitNegation(selected)) return false;
  const words = selected.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (!words.every(
    (word) => ASK_USER_AFFIRMATIVE_WORDS.has(word) || ASK_USER_NEUTRAL_WORDS.has(word),
  )) return false;
  if (!/^\s*(?:\d+[.)]\s*)?(?:(?:yes|ya|iya|oke|ok|okay|setuju|please|silakan|silahkan)\s*[,!:]?\s+)?(?:git\s+)?(?:commit|push)\b/i.test(selected)) return false;
  const selectedVerbs = new Set(words.filter((word) => word === "commit" || word === "push"));
  return verbs.size > 0 && [...verbs].every((verb) => selectedVerbs.has(verb));
}

/**
 * Mengambil jawaban `ask_user` terakhir pada giliran berjalan (setelah pesan user terakhir).
 * Mengembalikan teks jawaban untuk pilihan (`selected`) atau jawaban sendiri (custom).
 * Mengembalikan null bila tidak ada, dismissed/cancelled, atau jawaban bebas tidak afirmatif.
 */
function extractAskUserApproval(ctx: ExtensionContext): {
  answer: string;
  details: { options?: unknown; wasCustom?: unknown };
} | null {
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const message = (entries[i] as {
        message?: { role?: string; toolName?: string; details?: unknown };
      })?.message;
      if (!message) continue;
      if (message.role === "user") return null;
      if (message.role === "toolResult" && message.toolName === "ask_user") {
        const details = (message.details ?? {}) as {
          answer?: unknown;
          options?: unknown;
          wasCustom?: unknown;
        };
        const answer = details.answer;
        if (typeof answer !== "string" || answer.trim().length === 0) return null;
        if (details.wasCustom === false) {
          if (!Array.isArray(details.options) || !details.options.includes(answer)) return null;
          if (!hasOnlyApprovalWords(answer)) return null;
        } else if (!isAffirmativeAskAnswer(answer)) {
          return null;
        }
        if (containsGitNegation(answer)) return null;
        return { answer, details };
      }
    }
  } catch {
    // Fail-closed: kegagalan membaca sesi tidak memberi izin
  }
  return null;
}

/**
 * Memeriksa apakah pesan user cocok dengan salah satu pola `unlessUserSays`.
 */
export function matchesUnlessUserSays(
  rule: Rule,
  userText: string,
): boolean {
  if (!rule.compiledUnlessUserSays || rule.compiledUnlessUserSays.length === 0) {
    if (!rule.unlessUserSays || rule.unlessUserSays.length === 0) {
      return false;
    }
    return rule.unlessUserSays.some((pattern) => {
      try {
        return new RegExp(pattern, rule.flags || "i").test(userText);
      } catch {
        return false;
      }
    });
  }

  return rule.compiledUnlessUserSays.some((regex) => {
    try {
      regex.lastIndex = 0;
      return regex.test(userText);
    } catch {
      return false;
    }
  });
}

/**
 * Memeriksa apakah argumen tool cocok dengan condition rule.
 */
export function matchToolCondition(
  rule: Rule,
  serializedInput: string,
): { matched: boolean; excerpt?: string } {
  const conditions =
    rule.compiledConditions && rule.compiledConditions.length > 0
      ? rule.compiledConditions
      : (rule.condition || []).map((c) => new RegExp(c, rule.flags || "i"));

  for (const regex of conditions) {
    try {
      regex.lastIndex = 0;
      const match = regex.exec(serializedInput);
      if (match) {
        return {
          matched: true,
          excerpt: match[0],
        };
      }
    } catch {
      // Regex gagal diabaikan sesuai NFR-2
    }
  }

  return { matched: false };
}

/**
 * Memotong kutipan log maksimal 120 karakter.
 * Rule dengan nama 'secret-in-write' DILARANG memuat excerpt sama sekali (FR-10).
 */
export function sanitizeExcerpt(
  ruleName: string,
  rawExcerpt?: string,
): string | undefined {
  if (ruleName === "secret-in-write") {
    return undefined;
  }
  if (!rawExcerpt) return undefined;
  if (rawExcerpt.length <= 120) return rawExcerpt;
  return rawExcerpt.slice(0, 120);
}

/**
 * Mendaftarkan guard tool (FR-7) dan settle-gate (FR-9) ke runtime Pi.
 * Dibungkus penangkap error di setiap hook sesuai NFR-2 agar tidak pernah menjatuhkan sesi.
 */
export function registerToolGuard(pi: ExtensionAPI, deps: TtsrDeps): void {
  let settleState: SettleGateState = createSettleGateState();
  let lastUserPromptFromStart = "";

  // Reset settle-gate per run baru, dan tangkap prompt user jika tersedia
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    try {
      settleState = createSettleGateState();
      if (event && "messageType" in event && event.messageType === "user") {
        lastUserPromptFromStart = typeof event.prompt === "string" ? event.prompt : "";
      }
    } catch (error) {
      console.warn("[ttsr] error di handler before_agent_start:", error);
    }
  });

  // FR-7: Guard pra-eksekusi pada tool_call
  pi.on(
    "tool_call",
    (event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | void => {
      try {
        const toolName = event.toolName;

        // Pelacakan mutasi dan verifikasi untuk settle-gate (FR-9)
        if (MUTATION_TOOLS.has(toolName)) {
          settleState.hasMutation = true;
        }

        if (toolName === "bash" || toolName === "powershell") {
          const command =
            typeof (event.input as { command?: unknown })?.command === "string"
              ? (event.input as { command: string }).command
              : "";
          if (VERIFICATION_COMMAND_REGEX.test(command)) {
            settleState.hasVerification = true;
          }
        }

        const serializedInput = JSON.stringify(event.input ?? {});
        const rules = deps.getRules();
        const expectedScope = `tool:${toolName}`;

        for (const rule of rules) {
          if (!rule.enabled) continue;
          if (!deps.isEnabled(rule.name)) continue;

          // Scope harus cocok dengan salah satu item daftar scope rule
          if (!matchesRuleScope(rule.scope, expectedScope)) continue;

          const matchResult = matchToolCondition(rule, serializedInput);
          if (!matchResult.matched) continue;

          // Rule bertipe 'log': hanya mencatat, tidak memblokir (FR-8)
          if (rule.action === "log") {
            try {
              const entry: ViolationEntry = {
                ts: Date.now(),
                rule: rule.name,
                action: "log",
                scope: expectedScope,
                retry: false,
                excerpt: sanitizeExcerpt(rule.name, matchResult.excerpt),
              };
              deps.log(entry);
            } catch (err) {
              console.warn("[ttsr] gagal mencatat log pelanggaran rule:", err);
            }
            continue;
          }

          // Rule bertipe 'block': cek pengecualian unlessUserSays
          if (rule.action === "block") {
            const userText =
              lastUserPromptFromStart || extractLastUserText(ctx);
            const askApproval = extractAskUserApproval(ctx);
            // Jawaban ask_user harus memuat SEMUA verba (commit/push) yang ada di seluruh
            // input perintah. Mencegah "Ya, commit saja" membuka izin untuk
            // "git commit && git push", dan "Ya, push saja" membuka izin untuk "git commit".
            // Verba diambil dari kondisi yang cocok DAN dari seluruh input. Jawaban harus memuat
            // semuanya. Tanpa verba, jalur ask_user tidak memberi izin (fail-closed).
            const inputVerbs = new Set(
              (serializedInput.toLowerCase().match(/\b(?:commit|push)\b/g) ?? []),
            );
            const ruleVerb = /\b(commit|push)\b/i.exec(matchResult.excerpt ?? "")?.[1]?.toLowerCase();
            if (ruleVerb !== undefined) inputVerbs.add(ruleVerb);
            const askAnswer = askApproval?.answer;
            const askApproves =
              askApproval !== null &&
              inputVerbs.size > 0 &&
              ((askAnswer !== undefined &&
                matchesUnlessUserSays(rule, askAnswer) &&
                [...inputVerbs].every((verb) =>
                  new RegExp(`\\b${verb}\\b`, "i").test(askAnswer),
                )) ||
                (rule.name === "git-commit-push" &&
                  isSelectedGitApproval(askAnswer ?? "", askApproval.details, inputVerbs)));
            const directApproval = rule.name === "git-commit-push"
              ? isDirectGitPermission(userText, inputVerbs)
              : matchesUnlessUserSays(rule, userText);

            if (directApproval || askApproves) {
              // Diizinkan oleh instruksi eksplisit user
              continue;
            }

            // Catat pemblokiran ke log (FR-10)
            try {
              const entry: ViolationEntry = {
                ts: Date.now(),
                rule: rule.name,
                action: "block",
                scope: expectedScope,
                retry: false,
                excerpt: sanitizeExcerpt(rule.name, matchResult.excerpt),
              };
              deps.log(entry);
            } catch (err) {
              console.warn("[ttsr] gagal mencatat log pemblokiran rule:", err);
            }

            // Kembalikan pemblokiran dengan alasan teks koreksi (FR-7)
            const reason =
              rule.correctionText && rule.correctionText.trim().length > 0
                ? rule.correctionText.trim()
                : `Eksekusi tool ${toolName} diblokir oleh rule keselamatan '${rule.name}'.`;

            return {
              block: true,
              reason,
            };
          }
        }
      } catch (error) {
        // NFR-2: Penanganan fail-safe, kegagalan guard tidak boleh mematikan sesi
        console.warn("[ttsr] error di handler tool_call:", error);
      }
    },
  );

  // FR-9: Settle-gate untuk memastikan mutasi diverifikasi sebelum giliran selesai
  pi.on(
    "agent_before_settle",
    (
      event: AgentBeforeSettleEvent,
      _ctx: ExtensionContext,
    ): AgentBeforeSettleEventResult | void => {
      try {
        if (event.outcome === "aborted") return;

        // Tanpa mutasi: settle-gate tidak melakukan apa-apa
        if (!settleState.hasMutation) {
          return;
        }

        // Sudah ada verifikasi: lolos
        if (settleState.hasVerification) {
          return;
        }

        // Ada mutasi tanpa verifikasi: tolak penutupan SATU KALI per run
        if (settleState.settleRejectedCount === 0) {
          settleState.settleRejectedCount += 1;

          const existingEntries = Array.isArray(event.entries)
            ? event.entries
            : [];

          const promptText =
            "Terdapat perubahan berkas (mutasi) yang belum diverifikasi. " +
            "Jalankan pengujian atau verifikasi yang relevan (misal: test, check, build, lint, git diff) " +
            "sebelum menyelesaikan respons.";

          return {
            entries: [
              ...existingEntries,
              {
                type: "custom_message",
                customType: "ttsr-settle-gate",
                content: promptText,
                display: false,
              },
            ],
            continue: true,
          };
        }

        // Penolakan kedua dan seterusnya: lolos agar tidak terjadi loop tanpa akhir
        return;
      } catch (error) {
        // NFR-2: Fail-open pada error
        console.warn("[ttsr] error di handler agent_before_settle:", error);
      }
    },
  );
}
