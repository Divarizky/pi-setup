import {
  getMarkdownTheme,
  ThinkingSelectorComponent,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  Box,
  Markdown,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ReasoningLevel, SummaryConfig } from "./config.ts";
import type { RunRecap } from "./summarizer.ts";

export interface RecapEntryData extends RunRecap {
  /** Stable identity used to prevent duplicate recaps for the same run. */
  readonly runKey?: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly fallback?: boolean;
  readonly fallbackModel?: boolean;
}

class RecapCard {
  private readonly data: RecapEntryData;
  private readonly theme: Theme;
  private readonly expanded: boolean;

  constructor(data: RecapEntryData, theme: Theme, expanded: boolean) {
    this.data = data;
    this.theme = theme;
    this.expanded = expanded;
  }

  render(width: number) {
    const box = new Box(1, 1, (text) => this.theme.bg("customMessageBg", text));
    const title =
      this.theme.fg("accent", "▪ ") +
      this.theme.fg("customMessageLabel", this.theme.bold("Run Summaries"));
    box.addChild(new Text(title, 0, 0));
    box.addChild(
      new Markdown(this.data.recap, 0, 1, getMarkdownTheme(), {
        color: (text) => this.theme.fg("customMessageText", text),
      }),
    );
    box.addChild(
      new Text(
        `${this.theme.fg("accent", this.theme.bold("Next:"))} ${this.theme.fg("customMessageText", this.data.next)}`,
        0,
        0,
      ),
    );
    if (this.expanded) {
      const source = `${this.data.provider}/${this.data.model} · ${this.data.reasoning}${this.data.fallback ? " · local fallback" : this.data.fallbackModel ? " · session model fallback" : ""}`;
      box.addChild(new Text(this.theme.fg("dim", source), 0, 1));
    }
    return box.render(width);
  }

  invalidate() {}
}

export function renderRecap(
  data: RecapEntryData | undefined,
  expanded: boolean,
  theme: Theme,
) {
  if (!data)
    return new Text(theme.fg("warning", "Run recap unavailable"), 0, 0);
  return new RecapCard(data, theme, expanded);
}

// ─── Dashboard-style pickers (matching /subagents) ─────────────────────────

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function padText(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function borderSegment(theme: Theme, width: number, title: string): string {
  const label = title
    ? ` ${truncateToWidth(title, Math.max(0, width - 3))} `
    : "";
  const labelWidth = visibleWidth(label);
  return (
    theme.fg("border", "─") +
    (label ? theme.fg("text", label) : "") +
    theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
  );
}

class ModelPickerDashboard {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private models: ReadonlyArray<Model<Api>>;
  private index: number;
  private currentKey: string | undefined;
  private done: (value: Model<Api> | undefined) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    models: ReadonlyArray<Model<Api>>,
    index: number,
    currentKey: string | undefined,
    done: (value: Model<Api> | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.models = models;
    this.index = index;
    this.currentKey = currentKey;
    this.done = done;
  }

  handleInput(data: string): void {
    const n = this.models.length;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.models[this.index]);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.index = (this.index - 1 + n) % n;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.index = (this.index + 1) % n;
      this.tui.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const n = this.models.length;
    const innerWidth = width - 2;
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.min(n, Math.max(4, rows - 7));

    const lines: string[] = [];

    const headerLeft = theme.fg("accent", theme.bold("Summary Model"));
    const headerRight = theme.fg("muted", `${n} model${n === 1 ? "" : "s"}`);
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
      ),
    );

    lines.push(
      theme.fg("border", "╭") +
        borderSegment(theme, innerWidth, "recap model") +
        theme.fg("border", "╮"),
    );

    let start = 0;
    if (n > bodyHeight) {
      start = Math.min(
        Math.max(0, this.index - Math.floor(bodyHeight / 2)),
        n - bodyHeight,
      );
    }

    const divider = theme.fg("border", "│");
    const body: string[] = [];
    for (let i = start; i < Math.min(start + bodyHeight, n); i++) {
      const model = this.models[i];
      const isSelected = i === this.index;
      const isCurrent = `${model.provider}/${model.id}` === this.currentKey;

      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const label = isSelected
        ? theme.fg("accent", `${model.provider}/${model.id}`)
        : theme.fg("text", `${model.provider}/${model.id}`);
      const currentMark = isCurrent ? theme.fg("success", "●") : " ";

      const left = ` ${marker} ${label}`;
      const right = ` ${currentMark}`;
      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, innerWidth - rightWidth - 2);
      const leftTruncated = truncateToWidth(left, leftMax);
      const gap = Math.max(2, innerWidth - visibleWidth(leftTruncated) - rightWidth);
      body.push(truncateToWidth(leftTruncated + " ".repeat(gap) + right, innerWidth));
    }

    if (start > 0) {
      body[0] = truncateToWidth(
        theme.fg("dim", `   ... ${start} more`),
        innerWidth,
      );
    }
    if (start + bodyHeight < n) {
      body[body.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${n - start - bodyHeight} more`),
        innerWidth,
      );
    }

    while (body.length < bodyHeight) body.push("");
    for (const row of body)
      lines.push(divider + padText(row, innerWidth) + divider);

    lines.push(
      theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(innerWidth)) +
        theme.fg("border", "╯"),
    );

    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} choose · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        width,
      ),
    );

    return lines;
  }

  invalidate(): void {}
}

export async function openModelPicker(
  ctx: ExtensionCommandContext,
  config: SummaryConfig,
) {
  const models = [...ctx.modelRegistry.getAvailable()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
  if (models.length === 0) {
    ctx.ui.notify(
      "No configured models are available for run recaps.",
      "warning",
    );
    return undefined;
  }
  const currentKey = `${config.provider}/${config.model}`;
  const currentIndex = models.findIndex(
    (model) => `${model.provider}/${model.id}` === currentKey,
  );
  const index = currentIndex === -1 ? 0 : currentIndex;
  return ctx.ui.custom<Model<Api> | undefined>(
    (tui, theme, keybindings, done) =>
      new ModelPickerDashboard(tui, theme, keybindings, models, index, currentKey, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}

export function openReasoningPicker(
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  current: ReasoningLevel,
) {
  const supported = getSupportedThinkingLevels(model);
  const selectedCurrent = supported.includes(current)
    ? current
    : (supported[0] ?? "off");

  return ctx.ui.custom<ModelThinkingLevel | undefined>(
    (tui, theme, keybindings, done) => {
      const selector = new ThinkingSelectorComponent(
        selectedCurrent,
        supported,
        (level) => done(level),
        () => done(undefined),
      );
      const list = selector.getSelectList();
      return {
        render: (width: number) => {
          const inner = Math.max(1, width - 4);
          const title = ` reasoning for ${model.provider}/${model.id} `;
          const titleW = visibleWidth(title);
          const dashLen = Math.max(0, width - titleW - 4);
          const top =
            theme.fg("border", `╭─${title}${"─".repeat(dashLen)}╮`);
          const body = selector.render(inner);
          const rows = body.map(
            (line) =>
              theme.fg("border", "│ ") +
              padText(line, inner) +
              theme.fg("border", " │"),
          );
          const bottom =
            theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
          const hint = theme.fg(
            "dim",
            `  ↑↓/jk select · ${configuredKeys(keybindings, "tui.select.confirm")} choose · ${configuredKeys(keybindings, "tui.select.cancel")} close`,
          );
          return [top, ...rows, bottom, hint];
        },
        invalidate: () => selector.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
