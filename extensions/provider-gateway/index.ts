import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
// Namespace import: pola resmi pi-antigravity, registerApiProvider tidak ada
// di Oh My Pi sehingga di-resolve saat runtime.
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import {
  loginAntigravity,
  refreshAntigravityToken,
  getApiKey as getAntigravityApiKey,
} from "./antigravity/auth-oauth.js";
import {
  rememberAccount,
  updateRememberedAccount,
  listAccounts as listAntigravityAccounts,
  activateAccount as activateAntigravityAccount,
  removeAccount as removeAntigravityAccount,
} from "./antigravity/auth-accounts.js";
import { DEFAULT_ENDPOINT as ANTIGRAVITY_ENDPOINT } from "./antigravity/client.js";
import {
  ANTIGRAVITY_API as ANTIGRAVITY_API_ID,
  streamAntigravity,
} from "./antigravity/antigravity-stream.js";
import { getCurrentAntigravityCatalog as getGatewayAntigravityCatalog } from "./antigravity/models-catalog.js";
import { refreshAntigravityModels } from "./antigravity/models-discovery.js";
import {
  registerClaudeProvider,
  unregisterClaudeProvider,
  gatewayClaudeLogin,
  checkClaudeCli,
  isClaudeCliInstalled,
  installClaudeCli,
  isClaudeProviderRegistered,
  markClaudeRebuild,
  recordClaudePromptCapture,
  CLAUDE_PROVIDER_ID,
} from "./claude/index.js";
import {
  isClaudeInstallDeclined,
  setClaudeInstallDeclined,
} from "./claude/config.js";

/**
 * Provider Gateway Pi Extension (v1, paralel dengan 9router.ts)
 *
 * Commands:
 *   /gateway-login
 *   /gateway-status
 *   /gateway-logout
 *
 * Providers:
 *   9router    -> API key, OpenAI-compatible (kode dipindah dari 9router.ts)
 *   opencode-zen -> API key opsional, model gratis (kode dipindah dari 9router.ts)
 *   zenith      -> API key (zr_...), gateway lokal port 20120 (id auth lama "zenroute" masih dibaca)
 *   claude     -> Pro/Max via CLI resmi + Agent SDK (login = `claude login`)
 *   antigravity -> OAuth Google + model Gemini/Claude/GPT (vendored dari
 *     pi-antigravity v0.8.1 ke ./antigravity/*, boleh uninstall
 *     npm:pi-antigravity setelah ini stabil).
 *   openai-codex -> OAuth ChatGPT bawaan pi-ai (delegasi ke
 *     `/login openai-codex`, tanpa duplikasi flow).
 */

const NINEROUTER_URL =
  process.env.NINEROUTER_URL ?? "http://localhost:20128";
const ROUTER_PROVIDER_ID = "9router";
const ROUTER_PROVIDER_NAME = "9Router";
const ZENITH_URL =
  process.env.ZENITH_URL ?? process.env.ZENROUTE_URL ?? "http://127.0.0.1:20120";
const ZENITH_PROVIDER_ID = "zenith";
const ZENITH_PROVIDER_NAME = "Zenith Router";
// ID auth lama "zenroute" tetap dibaca sebagai cadangan supaya key lama tidak hilang.
const LEGACY_ZENROUTE_PROVIDER_ID = "zenroute";
const OPENCODE_AUTH_ID = "opencode-zen";
// ID provider OAuth direct lama — hanya untuk bersih-bersih sisa kredensial.
const ANTHROPIC_PROVIDER_ID = "anthropic";
const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const ANTIGRAVITY_PROVIDER_ID = "antigravity";
const ANTIGRAVITY_PROVIDER_NAME = "Antigravity";
// Provider bawaan pi-ai — gateway hanya status/logout, OAuth milik builtin.
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

async function loginAndRememberAntigravity(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const credentials = await loginAntigravity(callbacks);
  rememberAccount(credentials);
  return credentials;
}

async function refreshAndRememberAntigravity(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const refreshed = await refreshAntigravityToken(credentials);
  updateRememberedAccount(credentials, refreshed);
  return refreshed;
}

function registerCompatAntigravityApi(): void {
  const register = (piAiCompat as {
    registerApiProvider?: (provider: {
      api: typeof ANTIGRAVITY_API_ID;
      stream: typeof streamAntigravity;
      streamSimple: typeof streamAntigravity;
    }) => void;
  }).registerApiProvider;
  if (typeof register !== "function") return;
  register({
    api: ANTIGRAVITY_API_ID,
    stream: streamAntigravity,
    streamSimple: streamAntigravity,
  });
}

function registerAntigravityProvider(pi: ExtensionAPI): void {
  registerCompatAntigravityApi();
  const initialCatalog = getGatewayAntigravityCatalog();
  pi.registerProvider(ANTIGRAVITY_PROVIDER_ID, {
    name: ANTIGRAVITY_PROVIDER_NAME,
    baseUrl: ANTIGRAVITY_ENDPOINT,
    api: ANTIGRAVITY_API_ID,
    models: initialCatalog.models,
    refreshModels: refreshAntigravityModels,
    oauth: {
      name: ANTIGRAVITY_PROVIDER_NAME,
      login: loginAndRememberAntigravity,
      refreshToken: refreshAndRememberAntigravity,
      getApiKey: getAntigravityApiKey,
    },
    streamSimple: streamAntigravity,
  });
}
const OPENCODE_ALWAYS_FREE_IDS = new Set(["big-pickle"]);
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const AUTH_FILE = join(AGENT_DIR, "auth.json");
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// --- auth.json store (dipindah dari 9router.ts, tambah tipe oauth) ---

type AuthEntry =
  | { type: "api_key"; key: string }
  | { type: "oauth"; refresh: string; access: string; expires: number };
type AuthFile = Record<string, unknown>;

async function ensureAgentDir(): Promise<void> {
  await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
}

async function readAuthFile(): Promise<AuthFile> {
  try {
    const content = await readFile(AUTH_FILE, "utf8");
    if (!content.trim()) return {};
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Pi auth.json does not contain a valid object.");
    }
    return parsed as AuthFile;
  } catch (error) {
    if (error instanceof Error && "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeAuthFile(auth: AuthFile): Promise<void> {
  await ensureAgentDir();
  const tempFile = `${AUTH_FILE}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try { await chmod(tempFile, 0o600); } catch { /* Windows may ignore chmod. */ }
  await rename(tempFile, AUTH_FILE);
  try { await chmod(AUTH_FILE, 0o600); } catch { /* Windows may ignore chmod. */ }
}

async function getApiKeyEntry(providerId: string): Promise<string | null> {
  const credential = (await readAuthFile())[providerId];
  if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
    return null;
  }
  const entry = credential as Partial<AuthEntry>;
  return entry.type === "api_key" && typeof entry.key === "string" && entry.key.trim()
    ? entry.key.trim()
    : null;
}

async function getRouterApiKey(): Promise<string | null> {
  return (await getApiKeyEntry(ZENITH_PROVIDER_ID)) ?? getApiKeyEntry(LEGACY_ZENROUTE_PROVIDER_ID);
}

function hasOAuthEntry(auth: AuthFile, providerId: string): boolean {
  const credential = auth[providerId];
  if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
    return false;
  }
  return (credential as Partial<AuthEntry>).type === "oauth";
}

// --- 9Router + Zen (dipindah dari 9router.ts, tanpa perubahan logic) ---

type RouterModel = {
  id: string;
  name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  contextWindow?: number;
  maxTokens?: number;
  capabilities?: Record<string, unknown>;
};

type ModelsResponse = { data?: RouterModel[] };
type ModelInfo = {
  name?: string;
  contextWindow?: number;
  context_length?: number;
  maxTokens?: number;
  max_completion_tokens?: number;
  capabilities?: Record<string, unknown>;
};

type SqliteStatement = {
  get: () => Record<string, unknown> | undefined;
  all: () => Array<Record<string, unknown>>;
};
type SqliteDatabase = {
  prepare: (query: string) => SqliteStatement;
  close: () => void;
};

function getDataDirCandidates(): string[] {
  const override = process.env.DATA_DIR?.trim();
  if (override) return [override];

  const home = homedir();
  if (process.platform === "win32") {
    return [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "9router")];
  }
  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "9router"),
      join(home, ".9router"),
    ];
  }
  return [
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "9router"),
    join(home, ".9router"),
  ];
}

function getBetterSqlite3Path(dataDir: string): string {
  const candidates = [
    join(dataDir, "runtime", "node_modules", "better-sqlite3"),
    join(dataDir, "node_modules", "better-sqlite3"),
    join(dataDir, "resources", "app.asar.unpacked", "node_modules", "better-sqlite3"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** First 9Router data dir that actually holds a database. */
function pickLocalDataDir(): string | null {
  return getDataDirCandidates().find((candidate) =>
    existsSync(join(candidate, "db", "data.sqlite")),
  ) ?? null;
}

// 9Router >=0.5.x dropped the vendored better-sqlite3 for Node's built-in
// node:sqlite. Prefer the builtin and keep the old loader as a fallback so
// filtering keeps working on installs that still vendor the native module.
function openLocalDatabase(dataDir: string): SqliteDatabase {
  const databaseFile = join(dataDir, "db", "data.sqlite");
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (
        file: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare: (query: string) => { get: () => unknown; all: () => unknown[] };
        close: () => void;
      };
    };
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    return {
      prepare: (query) => {
        const statement = database.prepare(query);
        return {
          get: () => statement.get() as Record<string, unknown> | undefined,
          all: () => statement.all() as Array<Record<string, unknown>>,
        };
      },
      close: () => database.close(),
    };
  } catch {
    const require = createRequire(import.meta.url);
    const Database = require(getBetterSqlite3Path(dataDir)) as new (
      file: string,
      options?: object,
    ) => SqliteDatabase;
    return new Database(databaseFile, { readonly: true });
  }
}

function getLocalActiveConnectionCount(): number | null {
  const dataDir = pickLocalDataDir();
  if (!dataDir) return null;

  try {
    const database = openLocalDatabase(dataDir);
    try {
      const row = database.prepare(
        "SELECT COUNT(*) AS count FROM providerConnections WHERE isActive != 0",
      ).get();
      return Number(row?.count ?? 0);
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

function getLocalAvailableModelIds(): Map<string, Set<string>> | null {
  const dataDir = pickLocalDataDir();
  if (!dataDir) return null;

  try {
    const database = openLocalDatabase(dataDir);
    try {
      const nodes = database.prepare("SELECT id, data FROM providerNodes").all();
      const prefixByNodeId = new Map<string, string>();
      for (const node of nodes) {
        const id = typeof node.id === "string" ? node.id : undefined;
        const raw = typeof node.data === "string" ? node.data : undefined;
        if (!id || !raw) continue;
        try {
          const data: unknown = JSON.parse(raw);
          if (typeof data === "object" && data !== null &&
            typeof (data as { prefix?: unknown }).prefix === "string") {
            prefixByNodeId.set(id, (data as { prefix: string }).prefix);
          }
        } catch { /* Ignore malformed local node records. */ }
      }

      const rows = database.prepare("SELECT key FROM kv WHERE scope = 'customModels'").all();
      const modelsByProvider = new Map<string, Set<string>>();
      for (const row of rows) {
        const key = typeof row.key === "string" ? row.key : undefined;
        if (!key) continue;
        const separator = key.indexOf("|");
        const lastSeparator = key.lastIndexOf("|");
        if (separator <= 0 || lastSeparator <= separator) continue;
        const nodeId = key.slice(0, separator);
        const provider = prefixByNodeId.get(nodeId) ?? nodeId;
        const modelId = key.slice(separator + 1, lastSeparator);
        if (!modelId) continue;
        const models = modelsByProvider.get(provider) ?? new Set<string>();
        models.add(modelId);
        modelsByProvider.set(provider, models);
      }
      return modelsByProvider;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

async function request<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${NINEROUTER_URL}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  return response.json() as Promise<T>;
}

async function getRouterModels(apiKey: string): Promise<RouterModel[]> {
  const response = await request<ModelsResponse>("/v1/models", apiKey);
  const discovered = response.data ?? [];
  const available = getLocalAvailableModelIds();
  const models = available?.size
    ? discovered.filter((model) => {
      const separator = model.id.indexOf("/");
      if (separator <= 0) return true;
      const provider = model.id.slice(0, separator);
      const modelId = model.id.slice(separator + 1);
      const selected = available.get(provider);
      return !selected || selected.has(modelId);
    })
    : discovered;

  return Promise.all(models.map(async (model) => {
    try {
      const info = await request<ModelInfo>(
        `/v1/models/info?id=${encodeURIComponent(model.id)}`,
        apiKey,
      );
      return { ...model, ...info };
    } catch {
      return model;
    }
  }));
}

async function getOpenCodeFreeModels(apiKey: string): Promise<RouterModel[] | null> {
  try {
    const response = await fetch(OPENCODE_ZEN_MODELS_URL, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return null;
    const json = await response.json() as ModelsResponse;
    return (json.data ?? [])
      .filter((model) =>
        model.id.endsWith("-free") || OPENCODE_ALWAYS_FREE_IDS.has(model.id)
      )
      .map((model) => ({ ...model, id: `oc/${model.id}` }));
  } catch {
    return null;
  }
}

function mergeModels(...groups: RouterModel[][]): RouterModel[] {
  return [...new Map(groups.flat().map((model) => [model.id, model])).values()];
}

function toRouterModelDefs(models: RouterModel[]): ProviderModelConfig[] {
  return models.map((model): ProviderModelConfig => {
    const capabilities = model.capabilities ?? {};
    const supportsVision = capabilities.vision === true || capabilities.images === true;
    const supportsReasoning = capabilities.reasoning !== false;
    return {
      id: model.id,
      name: model.name ?? model.id,
      reasoning: supportsReasoning,
      input: supportsVision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? model.context_length ?? 200_000,
      maxTokens: model.maxTokens ?? model.max_completion_tokens ?? 32_768,
    };
  });
}

async function fetchMergedRouterModels(apiKey: string): Promise<RouterModel[] | null> {
  const openCodeApiKey = await getApiKeyEntry(OPENCODE_AUTH_ID) ?? apiKey;
  const [discoveredModels, officialFreeModels] = await Promise.all([
    getRouterModels(apiKey),
    getOpenCodeFreeModels(openCodeApiKey),
  ]);
  if (officialFreeModels === null) return null;
  const connectionCount = getLocalActiveConnectionCount();
  return mergeModels(
    connectionCount === 0 ? [] : discoveredModels,
    officialFreeModels,
  );
}

function registerRouterProvider(pi: ExtensionAPI, apiKey: string, models: RouterModel[]): void {
  let lastModels: ProviderModelConfig[] | undefined;
  const config: ProviderConfig = {
    name: ROUTER_PROVIDER_NAME,
    baseUrl: `${NINEROUTER_URL}/v1`,
    apiKey,
    authHeader: true,
    api: "openai-completions",
    models: toRouterModelDefs(models),
    async refreshModels(): Promise<ProviderModelConfig[]> {
      const key = await getApiKeyEntry(ROUTER_PROVIDER_ID);
      if (!key) return lastModels ?? [];
      try {
        const models = await fetchMergedRouterModels(key);
        if (models === null) return lastModels ?? [];
        lastModels = toRouterModelDefs(models);
        return lastModels;
      } catch {
        return lastModels ?? [];
      }
    },
  };
  lastModels = config.models;
  pi.registerProvider(ROUTER_PROVIDER_ID, config);
}

async function getZenithModels(apiKey: string): Promise<RouterModel[]> {
  const response = await fetch(`${ZENITH_URL}/v1/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  const json = await response.json() as ModelsResponse;
  return json.data ?? [];
}

function registerZenithProvider(pi: ExtensionAPI, apiKey: string, models: RouterModel[]): void {
  let lastModels: ProviderModelConfig[] | undefined;
  const config: ProviderConfig = {
    name: ZENITH_PROVIDER_NAME,
    baseUrl: `${ZENITH_URL}/v1`,
    apiKey,
    authHeader: true,
    api: "openai-completions",
    models: toRouterModelDefs(models),
    async refreshModels(): Promise<ProviderModelConfig[]> {
      const key = await getRouterApiKey();
      if (!key) return lastModels ?? [];
      try {
        const models = await getZenithModels(key);
        lastModels = toRouterModelDefs(models);
        return lastModels;
      } catch {
        return lastModels ?? [];
      }
    },
  };
  lastModels = config.models;
  pi.registerProvider(ZENITH_PROVIDER_ID, config);
}

// --- Claude Pro/Max via Agent SDK (pengganti OAuth direct) ---
// Direct HTTP OAuth (api anthropic-messages + token sk-ant-oat) ditolak Anthropic
// untuk third-party harness ("draw from extra usage"). Provider `claude` di
// ./claude/index.ts spawn CLI resmi via query() SDK -> kuota langganan.
// Login = `claude login` di terminal, tanpa token di auth.json.
// ID lama `anthropic` dipertahankan sebagai alias konstanta agar logout/status
// tetap membersihkan sisa kredensial OAuth direct bila ada.

// --- unified commands ---

const CHOICE_ROUTER = "9Router (API key)";
const CHOICE_ZEN = "OpenCode Zen (API key, opsional)";
const CHOICE_ZENITH = "Zenith Router (API key)";
const CHOICE_CLAUDE = "Claude Pro/Max (CLI)";
const CHOICE_ANTIGRAVITY = "Antigravity / Gemini (Google OAuth)";
const CHOICE_OPENAI_CODEX = "OpenAI Codex (ChatGPT OAuth)";

function maskApiKey(key: string): string {
  return key.length <= 8 ? "********" : `${key.slice(0, 4)}********${key.slice(-4)}`;
}

async function gatewayLogin(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const choice = await ctx.ui.select("Pilih provider untuk login:", [
    CHOICE_ROUTER,
    CHOICE_ZEN,
    CHOICE_ZENITH,
    CHOICE_CLAUDE,
    CHOICE_ANTIGRAVITY,
    CHOICE_OPENAI_CODEX,
  ]);
  if (!choice) return;

  try {
    if (choice === CHOICE_ZENITH) {
      const value = await ctx.ui.input("Zenith Router API key (zr_...):");
      if (!value?.trim()) {
        ctx.ui.notify("Zenith Router API key update cancelled.", "warning");
        return;
      }
      const apiKey = value.trim();
      const models = await getZenithModels(apiKey);
      const auth = await readAuthFile();
      auth[ZENITH_PROVIDER_ID] = { type: "api_key", key: apiKey };
      delete auth[LEGACY_ZENROUTE_PROVIDER_ID];
      await writeAuthFile(auth);
      registerZenithProvider(pi, apiKey, models);
      ctx.ui.notify(`Zenith Router connected. Models: ${models.length}`, "info");
      return;
    }

    if (choice === CHOICE_ROUTER) {
      const value = await ctx.ui.input("9Router API key:");
      if (!value?.trim()) {
        ctx.ui.notify("9Router API key update cancelled.", "warning");
        return;
      }
      const apiKey = value.trim();
      const models = await getRouterModels(apiKey);
      const auth = await readAuthFile();
      auth[ROUTER_PROVIDER_ID] = { type: "api_key", key: apiKey };
      await writeAuthFile(auth);
      const merged = mergeModels(
        getLocalActiveConnectionCount() === 0 ? [] : models,
        await getOpenCodeFreeModels(await getApiKeyEntry(OPENCODE_AUTH_ID) ?? apiKey) ?? [],
      );
      registerRouterProvider(pi, apiKey, merged);
      ctx.ui.notify(`9Router connected. Models: ${merged.length}`, "info");
      return;
    }

    if (choice === CHOICE_ZEN) {
      const routerKey = await getApiKeyEntry(ROUTER_PROVIDER_ID);
      if (!routerKey) {
        ctx.ui.notify("Login 9Router dulu sebelum menambah OpenCode Zen.", "error");
        return;
      }
      const value = await ctx.ui.input("OpenCode Zen API key:");
      if (!value?.trim()) {
        ctx.ui.notify("OpenCode Zen API key update cancelled.", "warning");
        return;
      }
      const zenKey = value.trim();
      const models = await getOpenCodeFreeModels(zenKey);
      if (models === null) throw new Error("OpenCode Zen API key is invalid or unavailable.");
      const auth = await readAuthFile();
      auth[OPENCODE_AUTH_ID] = { type: "api_key", key: zenKey };
      await writeAuthFile(auth);
      const merged = await fetchMergedRouterModels(routerKey);
      if (merged) registerRouterProvider(pi, routerKey, merged);
      ctx.ui.notify(`OpenCode Zen connected. Free models: ${models.length}`, "info");
      return;
    }

    if (choice === CHOICE_CLAUDE) {
      await gatewayClaudeLogin(ctx);
      return;
    }

    if (choice === CHOICE_OPENAI_CODEX) {
      // Flow OAuth milik builtin pi-ai (openai-codex-responses) — gateway
      // hanya delegasi agar tidak ada duplikasi PKCE/callback server.
      ctx.ui.notify("Jalankan `/login openai-codex` untuk menyelesaikan ChatGPT OAuth (Browser / Device code).", "info");
      return;
    }

    registerAntigravityProvider(pi);
    ctx.ui.notify("Antigravity provider terdaftar. Jalankan `/login antigravity` untuk menyelesaikan Google OAuth.", "info");
  } catch (error) {
    ctx.ui.notify(`Gateway login failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function gatewayStatus(ctx: ExtensionCommandContext): Promise<void> {
  const auth = await readAuthFile();
  const routerKey = await getApiKeyEntry(ROUTER_PROVIDER_ID);
  const zenKey = await getApiKeyEntry(OPENCODE_AUTH_ID);
  const zenithKey = await getRouterApiKey();
  let claudeDetail = "CLI (claude login)";
  let claudeConnected = false;
  try {
    const info = await checkClaudeCli();
    claudeConnected = info.loggedIn;
    claudeDetail = info.loggedIn ? `${info.version}` : "belum login";
  } catch {
    claudeConnected = false;
    claudeDetail = "CLI tidak ditemukan";
  }
  const antigravityOAuth = hasOAuthEntry(auth, ANTIGRAVITY_PROVIDER_ID);
  const openaiCodexOAuth = hasOAuthEntry(auth, OPENAI_CODEX_PROVIDER_ID);

  const antigravityCred = auth[ANTIGRAVITY_PROVIDER_ID] as Record<string, unknown> | undefined;
  const antigravityDetail =
    typeof antigravityCred?.email === "string" && antigravityCred.email
      ? antigravityCred.email
      : typeof antigravityCred?.projectId === "string" && antigravityCred.projectId
        ? antigravityCred.projectId
        : "oauth";

  const items = [
    { name: "9Router", connected: Boolean(routerKey), detail: routerKey ? maskApiKey(routerKey) : "" },
    { name: "OpenCode Zen", connected: Boolean(zenKey), detail: zenKey ? maskApiKey(zenKey) : "" },
    { name: "Zenith Router", connected: Boolean(zenithKey), detail: zenithKey ? maskApiKey(zenithKey) : "" },
    { name: "Claude Pro/Max", connected: claudeConnected, detail: claudeDetail },
    { name: "Antigravity", connected: antigravityOAuth, detail: antigravityDetail },
    { name: "OpenAI Codex", connected: openaiCodexOAuth, detail: openaiCodexOAuth ? "oauth" : "" },
  ];

  const maxNameWidth = Math.max(...items.map((i) => i.name.length));
  const rowTexts = items.map((i) => {
    const label = `${i.name}:`.padEnd(maxNameWidth + 2);
    const status = i.connected ? `● CONNECTED (${i.detail})` : "○ not configured";
    return `${label}${status}`;
  });

  const maxContentWidth = Math.max(...rowTexts.map((r) => r.length), 38);
  const innerWidth = maxContentWidth + 2;
  const title = " GATEWAY STATUS ";
  const padRight = Math.max(0, innerWidth - title.length - 2);
  const top = `╭──${title}${"─".repeat(padRight)}╮`;
  const bottom = `╰${"─".repeat(innerWidth)}╯`;
  const lines = [
    top,
    ...rowTexts.map((r) => `│ ${r.padEnd(maxContentWidth)} │`),
    bottom,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function gatewayLogout(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const choice = await ctx.ui.select("Pilih kredensial untuk logout:", [
    CHOICE_ROUTER,
    CHOICE_ZEN,
    CHOICE_ZENITH,
    CHOICE_CLAUDE,
    CHOICE_ANTIGRAVITY,
    CHOICE_OPENAI_CODEX,
  ]);
  if (!choice) return;

  const auth = await readAuthFile();
  if (choice === CHOICE_ROUTER) {
    delete auth[ROUTER_PROVIDER_ID];
    await writeAuthFile(auth);
    pi.unregisterProvider(ROUTER_PROVIDER_ID);
  } else if (choice === CHOICE_ZENITH) {
    delete auth[ZENITH_PROVIDER_ID];
    delete auth[LEGACY_ZENROUTE_PROVIDER_ID];
    await writeAuthFile(auth);
    try { pi.unregisterProvider(ZENITH_PROVIDER_ID); } catch { /* belum terdaftar */ }
  } else if (choice === CHOICE_ZEN) {
    delete auth[OPENCODE_AUTH_ID];
    await writeAuthFile(auth);
    const routerKey = await getApiKeyEntry(ROUTER_PROVIDER_ID);
    if (routerKey) {
      const merged = await fetchMergedRouterModels(routerKey);
      if (merged) registerRouterProvider(pi, routerKey, merged);
    }
  } else if (choice === CHOICE_CLAUDE) {
    // Kredensial milik CLI (~/.claude/.credentials.json), bukan auth.json.
    // Bersihkan sisa OAuth direct lama bila ada, lalu unregister dua ID.
    delete auth[ANTHROPIC_PROVIDER_ID];
    await writeAuthFile(auth);
    unregisterClaudeProvider(pi);
    try { pi.unregisterProvider(ANTHROPIC_PROVIDER_ID); } catch { /* sisa ID lama */ }
  } else if (choice === CHOICE_ANTIGRAVITY) {
    delete auth[ANTIGRAVITY_PROVIDER_ID];
    await writeAuthFile(auth);
    pi.unregisterProvider(ANTIGRAVITY_PROVIDER_ID);
  } else if (choice === CHOICE_OPENAI_CODEX) {
    // Kredensial milik builtin pi-ai — gateway hanya hapus simpanan.
    delete auth[OPENAI_CODEX_PROVIDER_ID];
    await writeAuthFile(auth);
  }
  ctx.ui.notify("Credential removed.", "info");
}

export default function (pi: ExtensionAPI): void {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  pi.registerCommand("gateway-login", { description: "Login provider via gateway (9Router / Zen / Claude / Antigravity / OpenAI)", handler: async (_args, ctx) => gatewayLogin(pi, ctx) });
  pi.registerCommand("gateway-status", { description: "Show gateway provider status", handler: async (_args, ctx) => gatewayStatus(ctx) });
  pi.registerCommand("gateway-logout", { description: "Remove gateway credential", handler: async (_args, ctx) => gatewayLogout(pi, ctx) });
  pi.registerCommand("gateway-antigravity-accounts", {
    description: "List, switch, or remove linked Antigravity Google accounts",
    handler: async (args, ctx) => {
      const command = (args ?? "").trim();
      try {
        if (command.startsWith("switch ")) {
          const account = await activateAntigravityAccount(command.slice("switch ".length));
          ctx.ui.notify(`Active Antigravity account: ${account.email || account.accountId}`, "info");
          return;
        }
        if (command.startsWith("remove ")) {
          const remaining = await removeAntigravityAccount(command.slice("remove ".length));
          const next = remaining ? ` Active account is now ${remaining.email || remaining.accountId}.` : "";
          ctx.ui.notify(`Antigravity account removed.${next}`, "info");
          return;
        }
        const accounts = listAntigravityAccounts();
        if (accounts.length === 0) {
          ctx.ui.notify("No linked Antigravity accounts. Run /login antigravity to add one.", "warning");
          return;
        }
        const lines = accounts.map(
          (account, index) => `${account.active ? "* " : "  "}${index + 1}. ${account.email || account.accountId}`,
        );
        ctx.ui.notify(
          `${lines.join("\n")}\nUse /gateway-antigravity-accounts switch <index|email> or /gateway-antigravity-accounts remove <index|email>.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  // Prompt capture harus direkam di tiga boundary hook berikut
  // (before_agent_start/agent_start/turn_start), kalau tidak resolveOrDerive
  // throw "no capture" dan turn gagal sebelum query jalan.
  type RecordOptions = { customPrompt?: string; appendSystemPrompt?: string; contextFiles?: { path: string; content: string }[]; skills?: { filePath: string; disableModelInvocation?: boolean }[]; selectedTools?: string[] };
  let lastSystemPromptOptions: RecordOptions | undefined;
  const recordSystemPrompt = (source: string, systemPrompt: string | undefined, options: RecordOptions | undefined): void => {
    if (!systemPrompt) return;
    recordClaudePromptCapture(systemPrompt, {
      custom: options?.customPrompt,
      append: options?.appendSystemPrompt,
      contextFiles: options?.contextFiles ?? [],
      skills: (!options?.selectedTools || options.selectedTools.includes("read") ? options?.skills ?? [] : []) as never[],
    }, source);
  };
  pi.on("before_agent_start", (event) => {
    lastSystemPromptOptions = event.systemPromptOptions as RecordOptions | undefined;
    recordSystemPrompt("before_agent_start", event.systemPrompt, lastSystemPromptOptions);
  });
  pi.on("agent_start", (_event, ctx) => {
    recordSystemPrompt("agent_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
  });
  pi.on("turn_start", (_event, ctx) => {
    recordSystemPrompt("turn_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
  });

  registerAntigravityProvider(pi);

  // Teruskan rewrite history (compact/tree) ke mirror sesi Claude agar query
  // parked tidak menjawab dari percakapan basi.
  pi.on("session_compact", (_event, ctx) =>
    markClaudeRebuild(ctx.sessionManager.getSessionId(), "session_compact"));
  pi.on("session_tree", (_event, ctx) =>
    markClaudeRebuild(ctx.sessionManager.getSessionId(), "session_tree"));

  pi.on("session_start", async (_event, ctx) => {
    // Registrasi kondisional Claude CLI jika biner tersedia atau dialog konfirmasi fallback
    try {
      const claudeInstalled = await isClaudeCliInstalled();
      if (claudeInstalled) {
        if (!isClaudeProviderRegistered()) {
          registerClaudeProvider(pi);
        }
      } else if (ctx.hasUI && !isClaudeInstallDeclined()) {
        const confirmed = await ctx.ui.confirm(
          "Claude Code CLI Belum Terpasang",
          "Claude Code CLI (@anthropic-ai/claude-code) belum terpasang di sistem ini.\nApakah Anda ingin memasangnya sekarang secara global via npm?",
        );
        if (confirmed) {
          ctx.ui.notify("Memasang @anthropic-ai/claude-code secara global...", "info");
          const installRes = await installClaudeCli();
          if (installRes.success) {
            setClaudeInstallDeclined(false);
            registerClaudeProvider(pi);
            let loggedIn = false;
            try {
              const info = await checkClaudeCli();
              loggedIn = info.loggedIn;
            } catch {
              loggedIn = false;
            }
            if (loggedIn) {
              ctx.ui.notify("Claude Code CLI berhasil dipasang dan terhubung.", "info");
            } else {
              ctx.ui.notify(
                "Claude Code CLI berhasil dipasang.\nJalankan `claude login` di terminal untuk mulai menggunakan Claude Pro/Max.",
                "warning",
              );
            }
          } else {
            ctx.ui.notify(`Gagal memasang Claude Code CLI: ${installRes.error}`, "error");
          }
        } else {
          setClaudeInstallDeclined(true);
        }
      }
    } catch {
      // Abaikan error deteksi Claude di session_start agar startup sesi tidak terhambat
    }

    try {
      const apiKey = await getApiKeyEntry(ROUTER_PROVIDER_ID);
      if (apiKey) {
        const merged = await fetchMergedRouterModels(apiKey);
        if (merged) registerRouterProvider(pi, apiKey, merged);
      }

      const zenithApiKey = await getRouterApiKey();
      if (zenithApiKey) {
        try {
          const models = await getZenithModels(zenithApiKey);
          registerZenithProvider(pi, zenithApiKey, models);
        } catch { /* Zenith Router belum jalan; snapshot kosong. */ }
      }

      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        void (async () => {
          const key = await getApiKeyEntry(ROUTER_PROVIDER_ID);
          if (!key) return;
          try {
            const models = await fetchMergedRouterModels(key);
            if (models === null) return;
            registerRouterProvider(pi, key, models);
          } catch { /* biarkan snapshot terakhir. */ }
        })();
      }, REFRESH_INTERVAL_MS);
    } catch { /* katalog gagal dimuat; snapshot sebelumnya dipertahankan. */ }
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
}
