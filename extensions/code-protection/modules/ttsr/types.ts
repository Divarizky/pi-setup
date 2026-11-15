/**
 * Tipe data bersama untuk modul TTSR (Time-Traveling Stream Rules).
 * Didesain stabil sebagai fondasi parser rule, matcher stream, strip,
 * dan handler runtime eksekusi.
 */

export type RuleAction = "strip" | "abort" | "block" | "log";

export type RuleAnchor = "start" | "any";

export type RuleScope = "text" | "thinking" | `tool:${string}`;

export type RuleRepeat = "once" | "after-gap";

export interface Rule {
  name: string;
  description?: string;
  action: RuleAction;
  /**
   * Daftar scope dipisahkan koma (misal "tool:write, tool:edit").
   * Setiap item berbentuk RuleScope. Diuraikan oleh ruleScopes() di rule.ts.
   */
  scope: string;
  condition: string[];
  flags: string;
  anchor: RuleAnchor;
  unlessUserSays?: string[];
  maxPerTurn: number;
  repeat: RuleRepeat;
  repeatGap: number;
  enabled: boolean;
  correctionText: string;
  filePath?: string;
  compiledConditions: RegExp[];
  /**
   * Versi bendera global dari compiledConditions, dikompilasi sekali saat parse.
   * Pemakai wajib mengatur ulang lastIndex sebelum memakai instance ini.
   */
  compiledGlobalConditions?: RegExp[];
  compiledUnlessUserSays?: RegExp[];
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface MatchViolation {
  rule: Rule;
  match: string;
  range: MatchRange;
  scope: string;
}

export type Violation = MatchViolation;

export interface ViolationEntry {
  ts: number;
  rule: string;
  action: RuleAction;
  scope: string;
  /** true bila pelanggaran memicu giliran koreksi lewat abort (FR-10). */
  retry: boolean;
  excerpt?: string;
}

export interface TtsrDeps {
  getRules(): Rule[];
  log(e: ViolationEntry): void;
  isEnabled(name: string): boolean;
}
