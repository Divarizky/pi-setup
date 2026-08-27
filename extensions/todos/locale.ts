/**
 * Custom i18n (Option B) — zero external deps. Dictionaries inline as TS
 * objects (no JSON import-attribute dance with jiti), English fallback at
 * every call site. `/lang` switches locale live; initial locale comes from
 * config (`locale` field, read once at extension init).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStatus } from "./types.ts";

export type Locale = "en" | "id";
type Messages = Record<string, string>;

const en: Messages = {
  "command.requires_interactive": "/todos requires interactive mode",
  "command.no_todos": "No todos yet. Ask the agent to add some!",
  "command.section.pending": "── Pending ──",
  "command.section.in_progress": "── In Progress ──",
  "command.section.completed": "── Completed ──",
  "overlay.heading": "Todos",
  "overlay.more": "more",
  "overlay.expandHint": "{key} to expand",
  "overlay.collapsed": "collapsed",
  "status.pending": "pending",
  "status.in_progress": "in progress",
  "status.completed": "completed",
  "status.deleted": "deleted",
  "lang.changed": "Language: {0}",
  "lang.usage": "Usage: /lang <en|id>. Supported: en, id",
};

const id: Messages = {
  "command.requires_interactive": "/todos butuh mode interaktif",
  "command.no_todos": "Belum ada todos. Minta agent untuk menambah!",
  "command.section.pending": "── Pending ──",
  "command.section.in_progress": "── In Progress ──",
  "command.section.completed": "── Completed ──",
  "overlay.heading": "Todos",
  "overlay.more": "lainnya",
  "overlay.expandHint": "{key} untuk expand",
  "overlay.collapsed": "ciut",
  "status.pending": "pending",
  "status.in_progress": "dikerjakan",
  "status.completed": "selesai",
  "status.deleted": "dihapus",
  "lang.changed": "Bahasa: {0}",
  "lang.usage": "Pemakaian: /lang <en|id>. Didukung: en, id",
};

const bundles: Record<Locale, Messages> = { en, id };

let currentLocale: Locale = "en";

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function isSupportedLocale(value: unknown): value is Locale {
  return value === "en" || value === "id";
}

/** Look up a key in the active bundle, falling back to the inline literal. */
export function t(key: string, fallback: string): string {
  return bundles[currentLocale][key] ?? fallback;
}

const STATUS_LABEL_PENDING = "pending";
const STATUS_LABEL_IN_PROGRESS = "in progress";
const STATUS_LABEL_COMPLETED = "completed";
const STATUS_LABEL_DELETED = "deleted";

/** Single point of localization for status words (overlay, /todos, renderers). */
export function formatStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return t("status.pending", STATUS_LABEL_PENDING);
    case "in_progress":
      return t("status.in_progress", STATUS_LABEL_IN_PROGRESS);
    case "completed":
      return t("status.completed", STATUS_LABEL_COMPLETED);
    case "deleted":
      return t("status.deleted", STATUS_LABEL_DELETED);
  }
}

/**
 * Register the `/lang` command. `onLocaleChanged` lets the caller refresh
 * anything cached at render time (the overlay) after a live switch.
 */
export function registerLangCommand(
  pi: ExtensionAPI,
  onLocaleChanged?: () => void,
): void {
  pi.registerCommand("lang", {
    description: "Switch UI language (en | id)",
    handler: async (args, ctx) => {
      const lang = args.trim().toLowerCase();
      if (!isSupportedLocale(lang)) {
        ctx.ui.notify(
          t("lang.usage", "Usage: /lang <en|id>. Supported: en, id"),
          "error",
        );
        return;
      }
      setLocale(lang);
      onLocaleChanged?.();
      ctx.ui.notify(
        t("lang.changed", `Language: ${lang}`).replace("{0}", lang),
        "info",
      );
    },
  });
}
