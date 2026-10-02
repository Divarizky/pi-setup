// Claude Pro/Max provider via Claude Code Agent SDK (first-party, kuota langganan).
//
// Diadopsi dari pi-claude-bridge v0.9.0 (MIT, Eli Dickinson). File-file murni
// (convert, models, mcp-server, extract-tool-results, prompt-stream,
// query-state, transcript, session-verify, skills, config, prompt-capture,
// agents-md) di-vendor verbatim di ./claude/*. Struktur orkestrasi query()
// (streamClaudeAgentSdk, consumeQuery, syncSharedSession, dll) diringkas di
// file ini agar muat di provider-gateway.
//
// Cara kerja: tiap turn spawn subprocess `claude` CLI resmi via query().
// Request keluar dari CLI first-party -> memotong kuota Pro/Max, bukan Extra Usage.
// Login = `claude login` sekali di terminal. Tanpa token di auth.json.

import { exec, execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import {
  query,
  type EffortLevel,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";

import { PROVIDER_ID as CLAUDE_BRIDGE_ID, convertPiMessages } from "./convert.js";
import {
  applyLongContext,
  buildModels,
  claudeCodeModelId,
  resolveModel as resolveClaudeModel,
  type LongContextSettings,
} from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { extractAllToolResults as extractResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx } from "./query-state.js";
import { makePromptStream, userMessage } from "./prompt-stream.js";
import { nonSystemMessages, toBridgeContext } from "./transcript.js";
import { createToolServer } from "./mcp-server.js";
import { collectCarriedAttachments, type CarriedAttachment } from "./attachments.js";
import {
  projectPromptCapture,
  sharedPromptCaptures,
} from "./prompt-capture.js";
import { loadConfig, type Config } from "./config.js";
import * as piAiCompatShim from "@earendil-works/pi-ai/compat";

export const CLAUDE_PROVIDER_ID = "claude";
const CLAUDE_PROVIDER_NAME = "Claude Pro/Max (CLI)";

const CC_CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
} as const;
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/.claude/rules/**"];

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH =
  process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge.log");
if (DEBUG) {
  try { mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true }); } catch { /* abaikan */ }
}
function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const fmt = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${args.map(fmt).join(" ")}\n`);
}

const MODELS = buildModels(getModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
  minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};
const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
  read: { file_path: "path" },
  write: { file_path: "path" },
  edit: { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

interface SessionState {
  sessionId: string;
  cursor: number;
  cwd: string;
  piSessionId?: string;
  needsRebuild?: boolean;
  forceRotate?: boolean;
}
interface SyncResult { sessionId: string | null; preserveSharedSession?: boolean; }

function sessionKey(piSessionId: string | null | undefined): string {
  return piSessionId ?? "(none)";
}
const sharedSessions = new Map<string, SessionState>();
function sessionStateFor(id: string | null | undefined): SessionState | null {
  return sharedSessions.get(sessionKey(id)) ?? null;
}
function setSessionStateFor(id: string | null | undefined, state: SessionState | null): void {
  if (state === null) sharedSessions.delete(sessionKey(id));
  else sharedSessions.set(sessionKey(id), state);
}
const historyRewrittenBySession = new Set<string>();
function markRebuildForSession(piSession: string | null, event: string): void {
  const state = sharedSessions.get(sessionKey(piSession));
  if (state) sharedSessions.set(sessionKey(piSession), { ...state, needsRebuild: true });
  else debug(`${event}: history rewritten, no session to mark yet`);
  if (piSession) historyRewrittenBySession.add(piSession);
  for (const c of activeQueryContexts) {
    if (c.piSessionId && historyRewrittenBySession.has(c.piSessionId)) c.historyStale = true;
  }
}

const activeQueryContexts = new Set<QueryContext>();
const completedStreams = new WeakSet<object>();
const abandonedQueries = new WeakSet<object>();
const promptCaptures = sharedPromptCaptures((d) => {
  debug(`prompt-capture: no match for ${d.systemPrompt.length}-char prompt, keys=${d.matches.length}`);
});

let queryImpl: typeof query = query;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
    return (err as Record<string, string>).message;
  }
  try { return JSON.stringify(err); } catch { return String(err); }
}
function resultErrorText(message: SDKMessage): string | undefined {
  const r = message as SDKMessage & { subtype?: string; is_error?: boolean; result?: string; errors?: unknown; error?: unknown };
  if (r.subtype === "success") return r.is_error ? r.result || "Claude Code reported an error" : undefined;
  if (Array.isArray(r.errors) && r.errors.length) return r.errors.map(String).join("\n");
  if (typeof r.error === "string") return r.error;
  return `Claude Code failed: ${r.subtype ?? "unknown result"}`;
}
function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use": return "toolUse";
    case "max_tokens": return "length";
    default: return "stop";
  }
}
function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input) return fallback;
  try { return JSON.parse(input); } catch { return fallback; }
}
function piToolNameFor(name: string, map: Map<string, string>): string | undefined {
  return map.get(name) ?? map.get(name.toLowerCase());
}
function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = args ?? {};
  const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const piKey = renames?.[key] ?? key;
    if (!(piKey in result)) result[piKey] = value;
  }
  if (toolName.toLowerCase() === "bash" && result.timeout == null) result.timeout = 120;
  return result;
}

function calculateCostSafe(model: Model<any>, usage: AssistantMessage["usage"]): void {
  try {
    calculateCost(model, usage);
  } catch { /* cost opsional */ }
}
function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
  if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
  const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
  if (reasoning != null) output.usage.reasoning = reasoning;
  output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  void calculateCostSafe(model, output.usage);
}
function markStreamComplete(stream: AssistantMessageEventStream | null): void {
  if (stream) completedStreams.add(stream as object);
}
function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
  if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
    debug(`WARNING: currentPiStream overwritten before terminal event (${label})`);
  }
  c.currentPiStream = stream;
}
function ensureTurnStarted(c: QueryContext): void {
  if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
    c.currentPiStream.push({ type: "start", partial: c.turnOutput });
    c.turnStarted = true;
  }
}
function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  if (!c.turnStarted) ensureTurnStarted(c);
  const stream = c.currentPiStream;
  if (c.turnOutput.stopReason === "error") {
    stream.push({ type: "error", reason: "error", error: c.turnOutput });
  } else {
    stream.push({ type: "done", reason: stopReason === "length" ? "length" : "stop", message: c.turnOutput });
  }
  markStreamComplete(stream);
  stream.end();
  c.currentPiStream = null;
}
function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], msg?: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    ...(msg ? { errorMessage: msg } : {}),
    timestamp: Date.now(),
  };
}
function turnStart(messages: Context["messages"]): number {
  let i = messages.length;
  while (i > 0 && messages[i - 1].role === "user") i--;
  return i;
}
function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n");
}
function extractUserPrompt(messages: Context["messages"]): string | null {
  const turn = messages.slice(turnStart(messages)) as Array<{ content?: unknown }>;
  if (turn.length === 0) return null;
  return turn.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content))).filter(Boolean).join("\n") || null;
}
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
  const turn = messages.slice(turnStart(messages)) as Array<{ content?: unknown }>;
  if (turn.length === 0) return null;
  let hasImage = false;
  const blocks: ContentBlockParam[] = [];
  for (const message of turn) {
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    if (!Array.isArray(content)) throw new Error("extractUserPromptBlocks: malformed user message");
    for (const block of content) {
      if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
      else if (block.type === "image" && block.data && block.mimeType) {
        hasImage = true;
        blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType as "image/jpeg", data: block.data } });
      }
    }
  }
  return hasImage ? blocks : null;
}
function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
  const blocks = extractUserPromptBlocks(messages);
  if (blocks) return blocks;
  const text = extractUserPrompt(messages);
  return text ? [{ type: "text", text }] : null;
}

function readCarriedAttachments(sessionId: string, cwd: string): CarriedAttachment[] {
  try {
    const previous = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
    return collectCarriedAttachments(previous.records);
  } catch (error) {
    debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);
    return [];
  }
}
function convertAndImportMessages(
  session: ReturnType<typeof createSession>,
  messages: Context["messages"],
  customToolNameToSdk?: Map<string, string>,
  carried?: readonly CarriedAttachment[],
): void {
  const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);
  debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
  const repaired = repairToolPairing(anthropicMessages);
  if (repaired.length) {
    (session as { importMessages: (m: unknown[], o?: unknown) => void }).importMessages(repaired, undefined);
  }
  void sanitizedIds; void dropped; void carried;
}
function syncSharedSession(
  messages: Context["messages"],
  cwd: string,
  customToolNameToSdk?: Map<string, string>,
  modelId?: string,
  piSessionId?: string | null,
): SyncResult {
  const sharedSession = sessionStateFor(piSessionId);
  const history = nonSystemMessages(messages);
  const priorMessages = history.slice(0, turnStart(history));
  if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
    const missed = priorMessages.slice(sharedSession.cursor);
    const trailingAssistantOnly = missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
    if (missed.length === 0 || trailingAssistantOnly) {
      if (trailingAssistantOnly) setSessionStateFor(piSessionId, { ...sharedSession, cursor: priorMessages.length, cwd });
      return { sessionId: sharedSession.sessionId };
    }
  }
  if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor) {
    return { sessionId: null, preserveSharedSession: true };
  }
  if (priorMessages.length === 0) return { sessionId: null };
  const previousSessionId = sharedSession?.sessionId;
  const previousCursor = sharedSession?.cursor ?? 0;
  const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
  if (preserveId) deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
  const session = createSession({
    projectPath: cwd,
    claudeDir: process.env.CLAUDE_CONFIG_DIR,
    ...(preserveId ? { sessionId: previousSessionId } : {}),
    ...(modelId ? { model: modelId } : {}),
  });
  convertAndImportMessages(session, priorMessages, customToolNameToSdk);
  (session as { save: () => void }).save();
  setSessionStateFor(piSessionId, { sessionId: session.sessionId, cursor: priorMessages.length, cwd, piSessionId: piSessionId ?? undefined });
  debug(`syncSharedSession: rebuild priors=${priorMessages.length} prev=${previousCursor} preserved=${preserveId}`);
  return { sessionId: session.sessionId };
}

function resolveMcpTools(context: Context): {
  mcpTools: NonNullable<Context["tools"]>;
  customToolNameToSdk: Map<string, string>;
  customToolNameToPi: Map<string, string>;
} {
  const mcpTools: NonNullable<Context["tools"]> = [];
  const customToolNameToSdk = new Map<string, string>();
  const customToolNameToPi = new Map<string, string>();
  if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };
  for (const tool of context.tools) {
    const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
    mcpTools.push(tool);
    customToolNameToSdk.set(tool.name, sdkName);
    customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
    customToolNameToPi.set(sdkName, tool.name);
    customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
  }
  return { mcpTools, customToolNameToSdk, customToolNameToPi };
}
function buildMcpServers(tools: NonNullable<Context["tools"]>, queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
  if (!tools.length) return undefined;
  const mcpTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    handler: async (toolCallId: string) => {
      if (queryCtx.pendingResults.has(toolCallId)) {
        const result = queryCtx.pendingResults.get(toolCallId)!;
        queryCtx.pendingResults.delete(toolCallId);
        return result;
      }
      return new Promise<McpResult>((resolve) => {
        queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
      });
    },
  }));
  return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

function processStreamEvent(message: SDKMessage, customToolNameToPi: Map<string, string>, model: Model<any>, c: QueryContext): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  c.turnSawStreamEvent = true;
  const event = (message as SDKMessage & { event: any }).event;
  if (event?.type === "message_start") {
    c.turnToolCallIds = [];
    c.turnStreamMessageId = event.message?.id;
    c.turnStreamOpen = true;
    c.turnStreamBlockStart = (c.turnOutput.content as unknown[]).length;
    if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
    return;
  }
  if (event?.type === "content_block_start") {
    ensureTurnStarted(c);
    const blocks = c.turnOutput.content as Array<Record<string, unknown> & { index?: number }>;
    if (event.content_block?.type === "text") {
      blocks.push({ type: "text", text: "", index: event.index });
      c.currentPiStream!.push({ type: "text_start", contentIndex: blocks.length - 1, partial: c.turnOutput });
    } else if (event.content_block?.type === "thinking") {
      blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
      c.currentPiStream!.push({ type: "thinking_start", contentIndex: blocks.length - 1, partial: c.turnOutput });
    } else if (event.content_block?.type === "tool_use") {
      const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
      if (!piName) { debug(`skipping unserved tool ${event.content_block.name}`); return; }
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(event.content_block.id);
      blocks.push({ type: "toolCall", id: event.content_block.id, name: piName,
        arguments: (event.content_block.input as Record<string, unknown>) ?? {}, partialJson: "", index: event.index });
      c.currentPiStream!.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: c.turnOutput });
    }
    return;
  }
  if (event?.type === "content_block_delta") {
    const blocks = c.turnOutput.content as Array<Record<string, any> & { index?: number }>;
    const index = blocks.findIndex((b) => b.index === event.index);
    const block = blocks[index];
    if (!block) return;
    if (event.delta?.type === "text_delta" && block.type === "text") {
      block.text += event.delta.text;
      c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
    } else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += event.delta.thinking;
      c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
    } else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson += event.delta.partial_json;
      block.arguments = parsePartialJson(block.partialJson, block.arguments);
      c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
    } else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
    }
    return;
  }
  if (event?.type === "content_block_stop") {
    const blocks = c.turnOutput.content as Array<Record<string, any> & { index?: number }>;
    const index = blocks.findIndex((b) => b.index === event.index);
    const block = blocks[index];
    if (!block) return;
    delete block.index;
    if (block.type === "text") {
      c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
    } else if (block.type === "thinking") {
      c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
    } else if (block.type === "toolCall") {
      block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
      delete block.partialJson;
      c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
    }
    return;
  }
  if (event?.type === "message_delta") {
    c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
    if (event.usage) updateUsage(c.turnOutput, event.usage, model);
    return;
  }
  if (event?.type === "message_stop") c.turnStreamOpen = false;
  if (event?.type === "message_stop" && c.turnSawToolCall) {
    c.turnOutput.stopReason = "toolUse";
    const stream = c.currentPiStream;
    stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
    markStreamComplete(stream);
    stream!.end();
    c.currentPiStream = null;
  }
}
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
  const assistantMsg = (message as any).message;
  if (!assistantMsg?.content) return;
  if (c.turnSawStreamEvent) {
    const id = assistantMsg.id;
    if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
  }
  c.turnToolCallIds = [];
  for (const block of assistantMsg.content) {
    const blocks = c.turnOutput!.content as Array<Record<string, unknown>>;
    if (block.type === "text" && block.text) {
      ensureTurnStarted(c);
      blocks.push({ type: "text", text: block.text });
      const idx = blocks.length - 1;
      c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
      c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
      c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
    } else if (block.type === "thinking") {
      ensureTurnStarted(c);
      blocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
      const idx = blocks.length - 1;
      c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
      if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
      c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
    } else if (block.type === "tool_use") {
      const piName = piToolNameFor(block.name, customToolNameToPi);
      if (!piName) continue;
      ensureTurnStarted(c);
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(block.id);
      blocks.push({ type: "toolCall", id: block.id, name: piName, arguments: mapToolArgs(piName, block.input) });
      const idx = blocks.length - 1;
      c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
      c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: blocks[idx] as any, partial: c.turnOutput });
    }
  }
  if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);
  if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
    c.turnOutput.stopReason = "toolUse";
    const stream = c.currentPiStream;
    stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
    markStreamComplete(stream);
    stream.end();
    c.currentPiStream = null;
  }
}
async function consumeQuery(
  sdkQuery: ReturnType<typeof query>,
  customToolNameToPi: Map<string, string>,
  model: Model<any>,
  wasAborted: () => boolean,
  queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
  let capturedSessionId: string | undefined;
  for await (const message of sdkQuery) {
    if (wasAborted()) break;
    let resultError: string | undefined;
    if (message.type === "result") {
      queryCtx.promptStream?.end();
      resultError = resultErrorText(message);
      if (resultError !== undefined && queryCtx.turnOutput) {
        queryCtx.turnOutput.stopReason = "error";
        queryCtx.turnOutput.errorMessage = resultError;
      }
    }
    if (message.type === "rate_limit_event") continue;
    if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;
    switch (message.type) {
      case "stream_event":
        processStreamEvent(message, customToolNameToPi, model, queryCtx);
        break;
      case "assistant":
        processAssistantMessage(message, model, customToolNameToPi, queryCtx);
        break;
      case "result": {
        if (resultError === undefined && !queryCtx.turnSawStreamEvent && message.subtype === "success") {
          ensureTurnStarted(queryCtx);
          const text = (message as { result?: string }).result || "";
          const blocks = queryCtx.turnOutput.content as Array<Record<string, unknown>>;
          blocks.push({ type: "text", text });
          const idx = blocks.length - 1;
          queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
          queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
          queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
        }
        break;
      }
      case "system":
        if ((message as any).subtype === "init" && (message as any).session_id) {
          capturedSessionId = (message as any).session_id;
        }
        break;
      default:
        break;
    }
  }
  return { capturedSessionId };
}
async function deliverToolResults(
  c: QueryContext,
  results: McpResult[],
  steer: ContentBlockParam[] | null,
): Promise<void> {
  if (steer) {
    const text = steer.map((b) => (b.type === "text" ? (b as { text: string }).text : "[image]")).join("\n");
    if (!c.promptStream) {
      debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
      const state = sessionStateFor(c.piSessionId);
      if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true });
    } else {
      try {
        await c.promptStream.push(userMessage(steer, "next"));
      } catch (error) {
        debug(`provider: steer push rejected:`, error);
        const state = sessionStateFor(c.piSessionId);
        if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true });
      }
    }
  }
  for (const result of results) {
    const id = result.toolCallId;
    if (id && c.pendingToolCalls.has(id)) {
      const pending = c.pendingToolCalls.get(id)!;
      c.pendingToolCalls.delete(id);
      pending.resolve(result);
    } else if (id) {
      c.pendingResults.set(id, result);
    }
  }
}
function contextForToolResults(results: McpResult[]): QueryContext | undefined {
  for (const result of results) {
    const id = result.toolCallId;
    if (!id) continue;
    for (const queryCtx of activeQueryContexts) {
      if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
        return queryCtx;
      }
    }
  }
  return undefined;
}
function discardRewrittenQuery(c: QueryContext): void {
  const discarded = c.activeQuery as { interrupt?: () => Promise<unknown>; close?: () => void } | null;
  if (discarded) abandonedQueries.add(discarded);
  c.activeQuery = null;
  activeQueryContexts.delete(c);
  c.turnToolCallIds = [];
  c.promptStream?.fail(new Error("conversation rewritten"));
  c.promptStream = null;
  c.releasePendingToolCalls("Context was compacted; this query was discarded.");
  void discarded?.interrupt?.().catch(() => {});
  try { discarded?.close?.(); } catch {}
  const state = sessionStateFor(c.piSessionId);
  if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
  if (c.piSessionId) historyRewrittenBySession.delete(c.piSessionId);
}
const CONTINUE_AFTER_REWRITE_PROMPT =
  "[Your context was compacted. What precedes this is a summary plus the most recent messages, "
  + "ending with the tool result you were waiting for. Continue the task from there.]";

// streamSimple sinkron kembalikan stream (kontrak Pi, pola antigravity-stream.ts).
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void runClaudeQuery(model, context, options, stream);
  return stream;
}

async function runClaudeQuery(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
): Promise<void> {
  context = toBridgeContext(context);
  if (options?.cacheRetention === "none") {
    await runIsolatedSummary(model, context, options, stream);
    return;
  }
  const lastMsgRole = context.messages[context.messages.length - 1]?.role;
  const activeQuery = ctx().activeQuery !== null;
  const allResults = activeQueryContexts.size > 0
    ? extractResults(context.messages as Array<{ role: string; [k: string]: unknown }>).results
    : [];
  let resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
  if (resultCtx?.historyStale) {
    discardRewrittenQuery(resultCtx);
    resultCtx = undefined;
  }
  if (resultCtx) {
    claimCurrentPiStream(stream, "tool-result", resultCtx);
    resultCtx.resetTurnState(model);
    if (!resultCtx.historyStale && resultCtx.piSessionId && historyRewrittenBySession.has(resultCtx.piSessionId)) {
      resultCtx.historyStale = true;
    }
    const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
    void deliverToolResults(resultCtx, allResults, steer);
    const state = sessionStateFor(resultCtx.piSessionId);
    if (state) state.cursor = context.messages.length;
    resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
    return;
  }
  const lastMsg = context.messages[context.messages.length - 1];
  if (lastMsg?.role === "toolResult") {
    const c = new QueryContext();
    c.resetTurnState(model);
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: c.turnOutput });
      markStreamComplete(stream);
      stream.end();
    });
    return;
  }
  const isReentrant = activeQuery;
  const queryCtx = isReentrant ? new QueryContext() : ctx();
  const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
  let systemPromptAppend: string | undefined;
  try {
    const capture = promptCaptures.resolveOrDerive(context.systemPrompt);
    systemPromptAppend = capture
      ? projectPromptCapture(capture, { skillReadTool: mcpTools.some((t) => t.name === "read") ? "mcp" : "none" })
      : undefined;
  } catch (error) {
    stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", errorMessage(error)) });
    stream.end();
    return;
  }
  claimCurrentPiStream(stream, "fresh-query", queryCtx);
  queryCtx.pendingToolCalls.clear();
  queryCtx.pendingResults.clear();
  queryCtx.turnToolCallIds = [];
  queryCtx.resetTurnState(model);
  queryCtx.latestCursor = 0;
  queryCtx.piSessionId = options?.sessionId ?? null;
  queryCtx.historyStale = false;
  queryCtx.missedSteer = false;

  const cwd = process.cwd();
  const cliModel = claudeCodeModelId(model, longContextSettings);
  const piSessionId = options?.sessionId ?? null;
  const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, piSessionId);
  if (piSessionId) historyRewrittenBySession.delete(piSessionId);
  const { sessionId: resumeSessionId } = syncResult;
  const promptBlocks = extractUserPromptBlocks(context.messages);
  let promptText = extractUserPrompt(context.messages) ?? "";
  if (!promptText && !promptBlocks) promptText = "[continue]";

  const promptStream = makePromptStream();
  void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
    .catch((error) => debug(`provider: initial prompt push rejected:`, error));
  queryCtx.promptStream = promptStream;
  const mcpServers = buildMcpServers(mcpTools, queryCtx);
  const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
  const claudeExecutable = resolveClaudeExecutable();
  const mapped = options?.reasoning ? model.thinkingLevelMap?.[options.reasoning] : undefined;
  const effort = options?.reasoning
    ? mapped === undefined
      ? REASONING_TO_EFFORT[options.reasoning]
      : VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined
    : undefined;
  const extraArgs: Record<string, string | null> = { model: cliModel };
  if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
  if (effort) extraArgs["thinking-display"] = "summarized";
  const childEnv = { ...process.env, ...CC_CHILD_ENV };
  const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
    cwd,
    env: childEnv,
    tools: [],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    settings: { autoMemoryEnabled: false, claudeMdExcludes: CLAUDE_MD_EXCLUDES, includeGitInstructions: false },
    systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend ?? undefined },
    extraArgs,
    ...(effort ? { effort } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
  };
  let wasAborted = false;
  const sdkQuery = queryImpl({ prompt: promptStream.stream, options: queryOptions });
  queryCtx.activeQuery = sdkQuery;
  activeQueryContexts.add(queryCtx);
  const abortCtx = queryCtx;
  const requestAbort = () => {
    void sdkQuery.interrupt().catch(() => {});
    try { sdkQuery.close(); } catch {}
  };
  const onAbort = () => {
    wasAborted = true;
    promptStream.fail(new Error("Operation aborted"));
    abortCtx.releasePendingToolCalls("Operation aborted");
    requestAbort();
  };
  if (options?.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
    .then(async ({ capturedSessionId }) => {
      if (abandonedQueries.has(sdkQuery)) return;
      if (wasAborted || options?.signal?.aborted) {
        const state = sessionStateFor(queryCtx.piSessionId);
        if (state) setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
        if (queryCtx.turnOutput) {
          queryCtx.turnOutput.stopReason = "aborted";
          queryCtx.turnOutput.errorMessage = "Operation aborted";
        }
        const s = queryCtx.currentPiStream;
        s?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
        markStreamComplete(s);
        s?.end();
        queryCtx.currentPiStream = null;
        return;
      }
      if (syncResult.preserveSharedSession) {
        const state = sessionStateFor(queryCtx.piSessionId);
        if (capturedSessionId && capturedSessionId !== state?.sessionId) {
          deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
        }
      } else {
        const state = sessionStateFor(queryCtx.piSessionId);
        const sessionId = capturedSessionId ?? state?.sessionId;
        if (sessionId) {
          const cursor = Math.max(context.messages.length, queryCtx.latestCursor, state?.cursor ?? 0);
          setSessionStateFor(queryCtx.piSessionId, { ...state, sessionId, cursor, cwd, piSessionId: queryCtx.piSessionId ?? undefined,
            needsRebuild: queryCtx.missedSteer || state?.needsRebuild });
        }
      }
      if (!isReentrant && queryCtx.activeQuery === sdkQuery) queryCtx.activeQuery = null;
      finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
    })
    .catch((error) => {
      if (abandonedQueries.has(sdkQuery)) return;
      if (wasAborted || options?.signal?.aborted) {
        const state = sessionStateFor(queryCtx.piSessionId);
        if (state) setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
      } else {
        setSessionStateFor(queryCtx.piSessionId, null);
      }
      promptStream.fail(error instanceof Error ? error : new Error(String(error)));
      if (queryCtx.turnOutput) {
        queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
        queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
      }
      if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
        queryCtx.releasePendingToolCalls("Query ended");
        queryCtx.activeQuery = null;
      }
      const s = queryCtx.currentPiStream;
      s?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
      markStreamComplete(s);
      s?.end();
      queryCtx.currentPiStream = null;
    })
    .finally(() => {
      if (options?.signal) options.signal.removeEventListener("abort", onAbort);
      promptStream.fail(new Error("query ended"));
      if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
      if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
        queryCtx.releasePendingToolCalls("Query ended");
        queryCtx.activeQuery = null;
        activeQueryContexts.delete(queryCtx);
      }
      sdkQuery.close();
    });
}

async function runIsolatedSummary(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
): Promise<void> {
  context = toBridgeContext(context);
  let sdkQuery: ReturnType<typeof query> | undefined;
  let wasAborted = false;
  const onAbort = () => {
    wasAborted = true;
    void sdkQuery?.interrupt().catch(() => {});
    try { sdkQuery?.close(); } catch {}
  };
  try {
    const promptText = extractUserPrompt(context.messages);
    if (!promptText) throw new Error("runIsolatedSummary: one-off summary without a user prompt");
    const cwd = process.cwd();
    const claudeExecutable = resolveClaudeExecutable();
    const cliModel = claudeCodeModelId(model, longContextSettings);
    sdkQuery = queryImpl({
      prompt: promptText,
      options: {
        cwd,
        env: { ...process.env, ...CC_CHILD_ENV },
        settings: { autoMemoryEnabled: false },
        tools: [],
        strictMcpConfig: true,
        settingSources: [],
        skills: [],
        persistSession: false,
        systemPrompt: context.systemPrompt,
        model: cliModel,
        maxTurns: 1,
        ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      },
    });
    if (options?.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    let assistantText = "";
    let finalText = "";
    let errorText: string | undefined;
    for await (const message of sdkQuery) {
      if (wasAborted) break;
      if (message.type === "assistant") {
        for (const block of (message as any).message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
        }
      } else if (message.type === "result") {
        errorText = resultErrorText(message);
        if (!errorText && message.subtype === "success") finalText = (message as { result?: string }).result || assistantText;
      }
    }
    if (wasAborted) {
      stream.push({ type: "error", reason: "aborted", error: newAssistantOutput(model, "", "aborted", "Operation aborted") });
      stream.end();
      return;
    }
    const text = finalText || assistantText;
    if (errorText || !text.trim()) {
      stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", errorText ?? "Claude Code summary returned empty text") });
      stream.end();
      return;
    }
    stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
    stream.end();
  } catch (err) {
    stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", errorMessage(err)) });
    stream.end();
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
    try { sdkQuery?.close(); } catch {}
  }
}

// --- login: direct ala pi-claude-bridge (delegasi ke CLI, tanpa OAuth inline) ---

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Path absolut claude.exe global (npm i -g @anthropic-ai/claude-code). Dipakai
// sebagai fallback saat PATH proses Pi tidak memuat %APPDATA%\npm (execFile
// spawn langsung tanpa shell -> shim .cmd tidak bisa dieksekusi, ENOENT).
function globalClaudeExePath(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const p = join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return existsSync(p) ? p : null;
}

// Satu-satunya path CLI yang dipakai query() SDK. Urutan: setting user
// (claude-bridge.json pathToClaudeCodeExecutable) -> claude.exe global ->
// biarkan SDK resolve biner bawaannya sendiri (undefined).
function resolveClaudeExecutable(): string | undefined {
  if (providerSettings.pathToClaudeCodeExecutable) return providerSettings.pathToClaudeCodeExecutable;
  return globalClaudeExePath() ?? undefined;
}

async function runClaudeCli(args: string[]): Promise<string> {
  const exe = resolveClaudeExecutable();
  if (exe) return (await execFileAsync(exe, args, { timeout: 20_000 })).stdout;
  // Tanpa path absolut, paksa lewat shell agar shim npm (claude.cmd) ikut
  // terresolve via PATHEXT — execFile tanpa shell tidak bisa spawn .cmd.
  return (await execAsync(`claude ${args.join(" ")}`, { timeout: 20_000 })).stdout;
}

async function checkClaudeCli(): Promise<{ path: string; version: string; loggedIn: boolean }> {
  try {
    const stdout = await runClaudeCli(["--version"]);
    const raw = stdout.trim().split("\n")[0] ?? "";
    const clean = raw.replace(/\s*\(Claude Code\)/i, "").trim();
    const version = clean ? (clean.startsWith("v") ? clean : `v${clean}`) : "CLI";
    let loggedIn = false;
    try {
      await runClaudeCli(["doctor"]);
      loggedIn = true;
    } catch {
      loggedIn = false;
    }
    return { path: resolveClaudeExecutable() ?? "claude", version, loggedIn };
  } catch (e) {
    throw new Error(`Claude CLI tidak ditemukan (${errorMessage(e)}). Install: npm i -g @anthropic-ai/claude-code lalu jalankan \`claude login\`.`);
  }
}

async function gatewayClaudeLogin(ctx: ExtensionCommandContext): Promise<void> {
  registerClaudeProviderGlobal();
  let info;
  try {
    info = await checkClaudeCli();
  } catch (e) {
    ctx.ui.notify(errorMessage(e), "error");
    return;
  }
  if (!info.loggedIn) {
    ctx.ui.notify(
      `Claude CLI terdeteksi (${info.version}) belum login.\nJalankan \`claude login\` di terminal, lalu coba lagi.`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(`Claude Pro/Max terhubung (${info.version}).`, "info");
}

let claudeProviderApi: ExtensionAPI | null = null;

function registerCompatClaudeApi(): void {
  const register = (piAiCompatShim as {
    registerApiProvider?: (provider: {
      api: typeof CLAUDE_BRIDGE_ID;
      stream: typeof streamClaudeAgentSdk;
      streamSimple: typeof streamClaudeAgentSdk;
    }) => void;
  }).registerApiProvider;
  if (typeof register !== "function") return;
  register({ api: CLAUDE_BRIDGE_ID, stream: streamClaudeAgentSdk as any, streamSimple: streamClaudeAgentSdk as any });
}

export function registerClaudeProvider(pi: ExtensionAPI): void {
  const config = loadConfig(process.cwd());
  providerSettings = config.provider ?? {};
  longContextSettings = {
    plan: providerSettings.plan ?? "pro",
    longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
    forceTwoHundredK: Array.isArray(providerSettings.forceTwoHundredK)
      ? providerSettings.forceTwoHundredK.filter((id): id is string => typeof id === "string")
      : undefined,
  };
  const registeredModels = applyLongContext(MODELS, longContextSettings);
  if (registeredModels.length === 0) {
    console.error("claude provider: no models from pi-ai anthropic catalog — update @earendil-works/pi-ai");
  }
  claudeProviderApi = pi;
  registerCompatClaudeApi();
  pi.registerProvider(CLAUDE_PROVIDER_ID, {
    baseUrl: "claude-bridge",
    apiKey: "not-used",
    api: CLAUDE_BRIDGE_ID,
    models: registeredModels,
    streamSimple: streamClaudeAgentSdk as any,
  });
}

function registerClaudeProviderGlobal(): void {
  if (claudeProviderApi) registerClaudeProvider(claudeProviderApi);
}

export function markClaudeRebuild(piSession: string | null, event: string): void {
  markRebuildForSession(piSession, event);
}

export function recordClaudePromptCapture(
  systemPrompt: string,
  input: { custom?: string; append?: string; contextFiles?: { path: string; content: string }[]; skills?: never[] },
  source?: string,
): void {
  promptCaptures.record(systemPrompt, input as never, source);
}

export { MODELS as CLAUDE_BRIDGE_MODELS, claudeCodeModelId };
export { gatewayClaudeLogin, checkClaudeCli };
export { CLAUDE_PROVIDER_ID as CLAUDE_BRIDGE_PROVIDER_ID, CLAUDE_PROVIDER_NAME };
