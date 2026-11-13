export function isNerdFontSupported(): boolean {
  const env = process.env;
  if (env.NERD_FONT === "0" || env.NERD_FONT === "false" || env.USE_NERD_FONT === "0") {
    return false;
  }
  if (env.NERD_FONT === "1" || env.NERD_FONT === "true" || env.USE_NERD_FONT === "1") {
    return true;
  }
  const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
  if (
    termProgram.includes("wezterm") ||
    termProgram.includes("kitty") ||
    termProgram.includes("ghostty") ||
    termProgram.includes("orca") ||
    termProgram.includes("herdr") ||
    Boolean(env.HERDR_PANE_ID) ||
    Boolean(env.HERDR_SOCKET_PATH) ||
    Boolean(env.ORCA_TERMINAL_HANDLE) ||
    Boolean(env.GHOSTTY_RESOURCES_DIR)
  ) {
    return true;
  }
  return false;
}

export const SYMBOLS = {
  get tick(): string {
    return isNerdFontSupported() ? "" : "✔";
  },
  get cross(): string {
    return isNerdFontSupported() ? "" : "✘";
  },
  get warning(): string {
    return isNerdFontSupported() ? "" : "⚠";
  },
  branch: "├─",
  lastBranch: "└─",
  ascii: {
    tick: "√",
    cross: "×",
    warning: "[!]",
    branch: "|--",
    lastBranch: "'--",
  },
};
