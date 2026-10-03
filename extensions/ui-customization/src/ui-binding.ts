import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiModeName } from "./tool-format.ts";

type UiBinding = {
  /** Live TUI mode; Pi's TUI reference follows `/settings` mode switches. */
  mode?: () => unknown;
  theme?: Theme;
  requestRender?: () => void;
};

let binding: UiBinding = {};

/** Bound from the header factory, which receives Pi's TUI reference and theme. */
export function bindUi(next: UiBinding | undefined): void {
  binding = next ?? {};
  // Shared with sibling extensions that render their own rows (they cannot
  // install their own header without replacing this one).
  (globalThis as { __piUiBinding?: UiBinding }).__piUiBinding = next ?? undefined;
}

/** Binding published by whichever extension owns the header. */
export function sharedBinding(): UiBinding | undefined {
  const own = (globalThis as { __piUiBinding?: UiBinding }).__piUiBinding;
  return own ?? (Object.keys(binding).length > 0 ? binding : undefined);
}

export function currentTuiMode(): TuiModeName {
  try {
    return sharedBinding()?.mode?.() === "fullscreen" ? "fullscreen" : "regular";
  } catch {
    return "regular";
  }
}

export function boundTheme(): Theme | undefined {
  return binding.theme;
}

export function canRequestRender(): boolean {
  return binding.requestRender !== undefined;
}

export function requestUiRender(): void {
  try {
    binding.requestRender?.();
  } catch {
    // The TUI is gone after shutdown or reload.
  }
}
