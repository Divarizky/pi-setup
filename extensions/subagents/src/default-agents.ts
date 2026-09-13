/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import type { AgentConfig } from "./types.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general",
    {
      name: "general",
      displayName: "Agent",
      description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      // inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
      // Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
      extensions: true,
      skills: true,
      taskPolicy: "flexible",
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
  [
    "explore",
    {
      name: "explore",
      displayName: "Explore",
      description: "Fast read-only search agent for locating code. Use it to find files by pattern (eg. \"src/components/**/*.tsx\"), grep for symbols or keywords (eg. \"API endpoints\"), or answer \"where is X defined / which files reference Y.\" Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: \"quick\" for a single targeted lookup, \"medium\" for moderate exploration, or \"very thorough\" to search across multiple locations and naming conventions.",
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true,
      skills: true,
      taskPolicy: "scout",
      model: "openai-codex/gpt-5.6-luna",
      systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`,
      promptMode: "replace",
      isDefault: true,
    },
  ],
  [
    "build",
    {
      name: "build",
      displayName: "Build",
      description: "Focused implementation agent for making code changes, adding tests, and validating the result. Use it when the task is already understood and needs a concrete fix.",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      extensions: true,
      skills: true,
      taskPolicy: "ship",
      systemPrompt: `You are an implementation specialist. Make focused, minimal changes that solve the requested task.

Before editing, inspect the relevant files and existing tests. Follow the repository's conventions. Run the most relevant validation after changes and report what changed and what passed.

Do not broaden the scope unnecessarily. If the task is ambiguous or the repository context is missing, state the blocker clearly instead of guessing.`,
      promptMode: "replace",
      isDefault: true,
    },
  ],
]);
