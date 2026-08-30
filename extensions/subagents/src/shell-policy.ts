export interface ShellPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

const SAFE_GIT_COMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
]);
const SAFE_PACKAGE_COMMANDS = new Set([
  "test",
  "lint",
  "build",
  "check",
  "typecheck",
]);
const SAFE_READ_COMMANDS = new Set([
  "pwd",
  "ls",
  "dir",
  "rg",
  "fd",
  "grep",
  "head",
  "tail",
  "cat",
  "type",
]);
const FORBIDDEN_GIT_ARGS =
  /^(?:-C$|--git-dir(?:=|$)|--work-tree(?:=|$)|--namespace(?:=|$)|--super-prefix(?:=|$)|--exec-path(?:=|$)|-c$|--config(?:=|$)|--config-env(?:=|$)|--output(?:=|$)|-o$|--ext-diff$|--textconv$|--upload-pack(?:=|$))/i;
const FORBIDDEN_PACKAGE_ARGS =
  /^(?:--script-shell(?:=|$)|--prefix(?:=|$)|--global$|-g$|--workspace(?:=|$)|-w$|--workspaces$|--userconfig(?:=|$)|--globalconfig(?:=|$))/i;
const FORBIDDEN_READ_ARGS =
  /^(?:--pre(?:=|$)|--pre-glob(?:=|$)|--exec(?:=|$)|--exec-batch(?:=|$)|-exec$|-execdir$|-delete$|-ok$|-okdir$|--output(?:=|$)|-o$|--tee$)/i;

function tokenize(command: string): string[] | undefined {
  if (!command.trim() || /[;&|><`$(){}\n\r^]/.test(command)) return undefined;
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) return undefined;
  if (current) tokens.push(current);
  return tokens.length > 0 ? tokens : undefined;
}

function executableName(token: string): string | undefined {
  const normalized = token.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (basename !== normalized) return undefined;
  return basename.toLowerCase().replace(/\.(cmd|exe|ps1)$/, "");
}

function rejected(reason: string): ShellPolicyDecision {
  return { allowed: false, reason };
}

function validateGit(args: string[]): ShellPolicyDecision {
  if (args.some((arg) => FORBIDDEN_GIT_ARGS.test(arg))) {
    return rejected(
      "Git command uses a path-changing, configuration, external-diff, or output option that is not allowed in child shells.",
    );
  }
  const subcommandIndex = args.findIndex((arg) =>
    SAFE_GIT_COMMANDS.has(arg.toLowerCase()),
  );
  const subcommand =
    subcommandIndex >= 0
      ? args[subcommandIndex]!.toLowerCase()
      : ((args.includes("--show-current") ? "branch" : undefined) ??
        (args.includes("--show-toplevel") || args.includes("--git-common-dir")
          ? "rev-parse"
          : undefined));
  const commandArgs =
    subcommandIndex >= 0 ? args.slice(subcommandIndex + 1) : args;
  if (!subcommand || !SAFE_GIT_COMMANDS.has(subcommand)) {
    return rejected(
      "Only read-only Git inspection commands are allowed in child shells; delivery requires Coordinator approval.",
    );
  }
  if (subcommand === "branch") {
    if (
      !args.includes("--show-current") ||
      commandArgs.some((arg) => !arg.startsWith("-"))
    )
      return rejected(
        "Only `git branch --show-current` is allowed in child shells.",
      );
  }
  if (subcommand === "rev-parse") {
    if (!args.includes("--show-toplevel") && !args.includes("--git-common-dir"))
      return rejected(
        "Only Git repository identity inspection is allowed in child shells.",
      );
    if (commandArgs.some((arg) => !arg.startsWith("-")))
      return rejected(
        "Git repository identity inspection cannot receive positional paths.",
      );
  }
  return { allowed: true };
}

function validatePackage(
  executable: string,
  args: string[],
): ShellPolicyDecision {
  if (args.some((arg) => FORBIDDEN_PACKAGE_ARGS.test(arg)))
    return rejected(
      "Package command uses a path-changing or shell-changing option that is not allowed in child shells.",
    );
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const script =
    positional[0]?.toLowerCase() === "run"
      ? positional[1]?.toLowerCase()
      : positional[0]?.toLowerCase();
  const expectedPositionals = positional[0]?.toLowerCase() === "run" ? 2 : 1;
  if (
    script &&
    SAFE_PACKAGE_COMMANDS.has(script) &&
    positional.length === expectedPositionals
  )
    return { allowed: true };
  return rejected(
    `Only test, lint, build, and check commands are allowed through ${executable} in child shells.`,
  );
}

export function validateChildShellCommand(
  command: string,
): ShellPolicyDecision {
  const tokens = tokenize(command);
  if (!tokens)
    return rejected(
      "Shell command must be one simple command without chaining, redirection, substitution, or newlines.",
    );
  const executable = executableName(tokens[0]!);
  if (!executable)
    return rejected(
      "Executable paths are not allowed; use a bare executable from the child shell allowlist.",
    );
  const args = tokens.slice(1);
  if (executable === "git") return validateGit(args);
  if (["npm", "pnpm", "yarn", "cargo"].includes(executable))
    return validatePackage(executable, args);
  if (executable === "npx") {
    if (args.length === 2 && args[0] === "tsc" && args[1] === "--noEmit")
      return { allowed: true };
    return rejected("Only `npx tsc --noEmit` is allowed in child shells.");
  }
  if (SAFE_READ_COMMANDS.has(executable)) {
    if (args.some((arg) => FORBIDDEN_READ_ARGS.test(arg)))
      return rejected(
        "This read command uses an execution or output option that is not allowed in child shells.",
      );
    return { allowed: true };
  }
  return rejected(
    `Executable '${executable}' is not in the child shell allowlist.`,
  );
}

export function isProtectedShellCommand(command: string): boolean {
  return !validateChildShellCommand(command).allowed;
}
