/**
 * Tipe data bersama untuk modul TTSR (Turn-Time Safety Rules).
 * Didesain stabil sebagai fondasi parser rule, matcher stream, strip,
 * dan handler runtime eksekusi.
 */

export type RuleAction = "strip" | "abort" | "block" | "log";

export type RuleAnchor = "start" | "any";

export type RuleScope = "text" | "thinking" | `tool:${string}`;

export interface Rule {
  name: string;
  description?: string;
  action: RuleAction;
  scope: RuleScope;
  condition: string[];
  flags: string;
  anchor: RuleAnchor;
  unlessUserSays?: string[];
  maxPerTurn: number;
  enabled: boolean;
  correctionText: string;
  filePath?: string;
  compiledConditions: RegExp[];
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
  excerpt?: string;
}

export interface TtsrDeps {
  getRules(): Rule[];
  log(e: ViolationEntry): void;
  isEnabled(name: string): boolean;
}
