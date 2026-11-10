import type { MatchRange, Rule, Violation } from "./types.ts";

export interface MatcherOptions {
  windowSize?: number;
}

export interface Matcher {
  feed(scope: string, delta: string): Violation[];
  /** Menandai satu giliran selesai. Dipakai oleh kebijakan repeat. */
  endTurn(): void;
  /** Membuka giliran baru untuk maxPerTurn. Riwayat pemicu tidak dihapus. */
  reset(): void;
  getBuffer(scope: string): string;
  getTriggerCount(ruleName: string): number;
}

interface ScopeState {
  buffer: string;
  streamOffset: number;
  reportedRanges: Map<string, Set<string>>;
}

/**
 * Membuat matcher stream inkremental untuk rule TTSR.
 * Mengelola buffer sliding window per scope, batas maxPerTurn per rule,
 * kebijakan repeat (once / after-gap), dan evaluasi anchor start vs any.
 */
export function createMatcher(
  rules: Rule[],
  options: MatcherOptions = {},
): Matcher {
  const windowSize = options.windowSize ?? 2000;
  const triggerCounts = new Map<string, number>();
  const scopes = new Map<string, ScopeState>();
  // Riwayat pemicu lintas giliran: nama rule -> jumlah giliran selesai saat terakhir memicu.
  const lastFiredTurn = new Map<string, number>();
  let completedTurns = 0;

  /**
   * Kebijakan repeat hanya dievaluasi saat rule belum memicu di giliran ini.
   * Rule action block dikecualikan dan selalu lolos.
   */
  function isRepeatAllowed(rule: Rule): boolean {
    if (rule.action === "block") return true;
    const last = lastFiredTurn.get(rule.name);
    if (last === undefined) return true;
    if (rule.repeat === "once") return false;
    return completedTurns - last >= rule.repeatGap;
  }

  function getScopeState(scope: string): ScopeState {
    let state = scopes.get(scope);
    if (!state) {
      state = {
        buffer: "",
        streamOffset: 0,
        reportedRanges: new Map(),
      };
      scopes.set(scope, state);
    }
    return state;
  }

  function endTurn(): void {
    completedTurns++;
  }

  function reset(): void {
    triggerCounts.clear();
    scopes.clear();
  }

  function getBuffer(scope: string): string {
    return scopes.get(scope)?.buffer ?? "";
  }

  function getTriggerCount(ruleName: string): number {
    return triggerCounts.get(ruleName) ?? 0;
  }

  function isScopeMatch(ruleScope: string, currentScope: string): boolean {
    if (ruleScope === currentScope) return true;
    if (ruleScope === "tool:*" && currentScope.startsWith("tool:")) return true;
    return false;
  }

  function toGlobalRegex(reg: RegExp): RegExp {
    const flags = reg.flags.includes("g") ? reg.flags : `${reg.flags}g`;
    return new RegExp(reg.source, flags);
  }

  function feed(scope: string, delta: string): Violation[] {
    if (!delta) return [];

    const state = getScopeState(scope);
    state.buffer += delta;

    const violations: Violation[] = [];

    // Evaluasi tiap rule yang relevan dan masih aktif
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (!isScopeMatch(rule.scope, scope)) continue;

      const currentTriggers = triggerCounts.get(rule.name) ?? 0;
      if (currentTriggers >= rule.maxPerTurn) continue;
      if (!isRepeatAllowed(rule)) continue;

      let ruleReported = state.reportedRanges.get(rule.name);
      if (!ruleReported) {
        ruleReported = new Set<string>();
        state.reportedRanges.set(rule.name, ruleReported);
      }

      let quotaLeft = rule.maxPerTurn - currentTriggers;

      for (const condition of rule.compiledConditions) {
        if (quotaLeft <= 0) break;

        const globalRegex = toGlobalRegex(condition);
        let match: RegExpExecArray | null;

        while ((match = globalRegex.exec(state.buffer)) !== null) {
          const matchText = match[0];
          const localStart = match.index;
          const localEnd = localStart + matchText.length;
          const globalStart = state.streamOffset + localStart;
          const globalEnd = state.streamOffset + localEnd;
          const rangeKey = `${globalStart}:${globalEnd}`;

          // Majukan index jika regex mencocokkan string kosong untuk menghindari loop
          if (matchText.length === 0) {
            globalRegex.lastIndex++;
          }

          // Lewati jika range global ini sudah pernah dilaporkan untuk rule ini
          if (ruleReported.has(rangeKey)) {
            continue;
          }

          // Cek anchor start: hanya valid bila berada di awal respons
          if (rule.anchor === "start") {
            const isAtGlobalStart =
              state.streamOffset === 0 &&
              state.buffer.slice(0, localStart).trim().length === 0;

            if (!isAtGlobalStart) {
              continue;
            }
          }

          ruleReported.add(rangeKey);
          quotaLeft--;
          const nextCount = (triggerCounts.get(rule.name) ?? 0) + 1;
          triggerCounts.set(rule.name, nextCount);
          lastFiredTurn.set(rule.name, completedTurns);

          const range: MatchRange = {
            start: globalStart,
            end: globalEnd,
          };

          violations.push({
            rule,
            match: matchText,
            range,
            scope,
          });

          if (quotaLeft <= 0) {
            break;
          }
        }
      }
    }

    // Pangkas buffer bila melebihi ukuran jendela
    if (state.buffer.length > windowSize) {
      const dropCount = state.buffer.length - windowSize;
      state.streamOffset += dropCount;
      state.buffer = state.buffer.slice(dropCount);
    }

    return violations;
  }

  return {
    feed,
    endTurn,
    reset,
    getBuffer,
    getTriggerCount,
  };
}
