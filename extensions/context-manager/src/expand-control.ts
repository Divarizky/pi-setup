/**
 * Expand/collapse affordance shared with ui-customization through the global
 * binding it publishes. Falls back to the plain ctrl+o hint when
 * ui-customization is not installed or has not bound a TUI yet.
 */
export function expandControl(expanded: boolean): { text: string; button: boolean } | undefined {
  const binding = (
    globalThis as { __piUiBinding?: { mode?: () => unknown } }
  ).__piUiBinding;
  let fullscreen = false;
  try {
    fullscreen = binding?.mode?.() === "fullscreen";
  } catch {
    fullscreen = false;
  }
  if (fullscreen) {
    return { text: expanded ? "click to collapse" : "click to expand", button: true };
  }
  if (expanded) return undefined;
  return { text: "(ctrl+o to expand)", button: false };
}
