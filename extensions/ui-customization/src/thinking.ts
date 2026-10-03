import {
  AssistantMessageComponent,
  keyText,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  boundTheme,
  canRequestRender,
  currentTuiMode,
  requestUiRender,
} from "./ui-binding.ts";
import {
  extractThinkingTitle,
  formatThoughtDuration,
  shimmerParts,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  thinkingRuns,
  truncateLabel,
  type ThinkingRun,
} from "./thinking-format.ts";

const PATCH_KEY = Symbol.for("ui-customization.thinking.updateContent");
const MAX_TRACKED_MESSAGES = 200;

type Active = { timestamp: number; contentIndex: number; startedAt: number };
type Component = { render(width: number): string[]; invalidate(): void };

let active: Active | undefined;
let frame = 0;
let animationTimer: ReturnType<typeof setInterval> | undefined;
/** message timestamp -> content index -> thinking duration in ms */
const durations = new Map<number, Map<number, number>>();

function runContains(run: ThinkingRun, contentIndex: number): boolean {
  return contentIndex >= run.start && contentIndex <= run.end;
}

function isRunActive(timestamp: number, run: ThinkingRun): boolean {
  return active?.timestamp === timestamp && runContains(run, active.contentIndex);
}

function runDuration(timestamp: number, run: ThinkingRun): number | undefined {
  let total = 0;
  const known = durations.get(timestamp);
  for (let index = run.start; index <= run.end; index += 1) {
    total += known?.get(index) ?? 0;
  }
  if (isRunActive(timestamp, run)) total += Date.now() - active!.startedAt;
  return total > 0 ? total : undefined;
}

function recordDuration(timestamp: number, contentIndex: number, ms: number): void {
  let known = durations.get(timestamp);
  if (!known) {
    known = new Map();
    durations.set(timestamp, known);
    if (durations.size > MAX_TRACKED_MESSAGES) {
      durations.delete(durations.keys().next().value!);
    }
  }
  known.set(contentIndex, (known.get(contentIndex) ?? 0) + Math.max(1, ms));
}

function safeKeyText(binding: string, fallback: string): string {
  try {
    return keyText(binding as never) || fallback;
  } catch {
    return fallback;
  }
}

function headingLine(
  title: string,
  running: boolean,
  durationMs: number | undefined,
  hidden: boolean,
  withControl = true,
): string {
  const theme = boundTheme();
  const fg = (color: string, text: string) =>
    theme ? theme.fg(color as never, text) : text;
  const base = (text: string) =>
    text && theme ? theme.italic(fg("thinkingText", text)) : text;
  const label = truncateLabel(title);

  let line: string;
  if (running) {
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
    const [before, highlight, after] = shimmerParts(label || "Thinking…", frame);
    const lit = highlight && theme ? theme.italic(theme.bold(fg("text", highlight))) : highlight;
    const elapsed =
      durationMs !== undefined && durationMs >= 1_000
        ? fg("dim", ` · ${Math.floor(durationMs / 1_000)}s`)
        : "";
    line = `${fg("accent", spinner)} ${base(before)}${lit}${base(after)}${elapsed}`;
  } else {
    const text =
      durationMs !== undefined
        ? `Thought for ${formatThoughtDuration(durationMs)}`
        : label || "Thought";
    line = `${fg("dim", "∴")} ${base(text)}`;
  }

  if (!withControl) return line;
  if (currentTuiMode() === "fullscreen") {
    const control = fg("accent", hidden ? "click to expand" : "click to collapse");
    line += `  ${theme ? theme.underline(control) : control}`;
  } else if (hidden && !running) {
    line += fg("dim", ` (${safeKeyText("app.thinking.toggle", "ctrl+t")} to expand)`);
  }
  return line;
}

/**
 * Animated heading for one thinking run, with Pi's own thinking body below it
 * when the run is visible. State is read at render time, so a render request
 * is enough to advance the spinner and timer.
 */
class ThinkingView implements Component {
  private readonly timestamp: number;
  private readonly run: ThinkingRun;
  private readonly hidden: boolean;
  private readonly body: Component | undefined;
  private readonly pad: number;

  constructor(
    timestamp: number,
    run: ThinkingRun,
    hidden: boolean,
    body: Component | undefined,
    pad: number,
  ) {
    this.timestamp = timestamp;
    this.run = run;
    this.hidden = hidden;
    this.body = body;
    this.pad = pad;
  }

  render(width: number): string[] {
    const running = isRunActive(this.timestamp, this.run);
    // A visible body already shows the title on its first line.
    const heading = headingLine(
      this.hidden ? extractThinkingTitle(this.run.text) : "",
      running,
      runDuration(this.timestamp, this.run),
      this.hidden,
    );
    const lines = [truncateToWidth(`${" ".repeat(this.pad)}${heading}`, width)];
    if (this.body) lines.push(...this.body.render(width));
    return lines;
  }

  invalidate(): void {
    this.body?.invalidate();
  }
}

/** Shown while the model thinks but has not streamed any thinking text yet. */
class PendingThinkingView implements Component {
  private readonly pad: number;

  constructor(pad: number) {
    this.pad = pad;
  }

  render(width: number): string[] {
    const elapsed = active ? Date.now() - active.startedAt : undefined;
    // No control: Pi has no thinking region to toggle until text arrives.
    const heading = headingLine("", true, elapsed, true, false);
    return ["", truncateToWidth(`${" ".repeat(this.pad)}${heading}`, width)];
  }

  invalidate(): void {}
}

type RegionLike = { child: Component; onMouse: unknown };

function isRegion(value: unknown): value is RegionLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "child" in value &&
    typeof (value as { onMouse?: unknown }).onMouse === "function"
  );
}

/** Replace Pi's thinking regions with animated views after Pi has rendered them. */
function decorate(component: any, message: any): void {
  const content = message?.content;
  const container = component?.contentContainer;
  const children: unknown[] | undefined = container?.children;
  if (!Array.isArray(content) || !Array.isArray(children)) return;

  const timestamp = Number(message.timestamp);
  const runs = thinkingRuns(content);
  // In this Pi version only thinking runs are wrapped in a MouseRegion.
  const regions = children.filter(isRegion);
  const pad = typeof component.outputPad === "number" ? component.outputPad : 1;

  if (regions.length === runs.length) {
    runs.forEach((run, runIndex) => {
      const region = regions[runIndex]!;
      const hidden =
        component.thinkingVisibilityOverrides?.get?.(runIndex) ??
        Boolean(component.hideThinkingBlock);
      // The region keeps Pi's click handler, which toggles this run.
      region.child = new ThinkingView(
        timestamp,
        run,
        hidden,
        hidden ? undefined : region.child,
        pad,
      );
    });
  }

  const pendingActive =
    active?.timestamp === timestamp &&
    content[active.contentIndex]?.type === "thinking" &&
    !runs.some((run) => runContains(run, active!.contentIndex));
  if (pendingActive && typeof container.addChild === "function") {
    container.addChild(new PendingThinkingView(pad));
  }
}

function installPatch(): () => void {
  const prototype = AssistantMessageComponent.prototype as any;
  let original = prototype.updateContent;
  // A previous load that was not shut down cleanly leaves its wrapper behind.
  if (original?.[PATCH_KEY]) original = original[PATCH_KEY];

  const patched = function (this: unknown, message: unknown, isStreaming?: boolean) {
    original.call(this, message, isStreaming);
    try {
      decorate(this, message);
    } catch {
      // Keep Pi's own rendering if this Pi version is laid out differently.
    }
  };
  (patched as any)[PATCH_KEY] = original;
  prototype.updateContent = patched;

  return () => {
    if (prototype.updateContent === patched) prototype.updateContent = original;
  };
}

function startAnimation(): void {
  if (animationTimer || !canRequestRender()) return;
  animationTimer = setInterval(() => {
    frame += 1;
    requestUiRender();
  }, SPINNER_INTERVAL_MS);
  animationTimer.unref?.();
}

function stopAnimation(): void {
  if (!animationTimer) return;
  clearInterval(animationTimer);
  animationTimer = undefined;
}

function finishActive(): void {
  if (!active) return;
  recordDuration(active.timestamp, active.contentIndex, Date.now() - active.startedAt);
  active = undefined;
  stopAnimation();
  requestUiRender();
}

/**
 * Claude Code-style thinking: while the model thinks, the block heading shows
 * Pi's braille spinner, the latest thinking title with a sweeping highlight,
 * and the elapsed time. Afterwards it reads `∴ Thought for 12s`.
 */
export function installThinkingDisplay(pi: ExtensionAPI): void {
  // Install now so restored history renders through it, and again per session
  // because session_shutdown also fires on session switches.
  let restorePatch: (() => void) | undefined = installPatch();
  pi.on("session_start", async () => {
    restorePatch?.();
    restorePatch = installPatch();
  });

  pi.on("message_update", async (event) => {
    const evt = event?.assistantMessageEvent as
      | { type?: string; contentIndex?: number; partial?: { timestamp?: number } }
      | undefined;
    if (!evt?.type) return;

    if (evt.type === "thinking_start") {
      finishActive();
      active = {
        timestamp: Number(evt.partial?.timestamp ?? (event.message as any)?.timestamp),
        contentIndex: evt.contentIndex ?? 0,
        startedAt: Date.now(),
      };
      startAnimation();
    } else if (
      evt.type === "thinking_end" ||
      evt.type === "text_start" ||
      evt.type === "toolcall_start" ||
      evt.type === "done" ||
      evt.type === "error"
    ) {
      finishActive();
    }
  });

  pi.on("message_end", async () => finishActive());
  pi.on("turn_end", async () => finishActive());
  pi.on("agent_end", async () => finishActive());

  pi.on("session_shutdown", async () => {
    active = undefined;
    stopAnimation();
    restorePatch?.();
    restorePatch = undefined;
  });
}
