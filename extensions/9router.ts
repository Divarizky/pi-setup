import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/**
 * 9Router Pi Extension
 *
 * Commands:
 *   /9router-login
 *   /9router-status
 *   /9router-logout
 *
 * 9Router default URL: http://localhost:20128
 * Credentials are stored in ~/.pi/agent/auth.json.
 */

const NINEROUTER_URL = process.env.NINEROUTER_URL ?? "http://localhost:20128";
const PROVIDER_ID = "9router";
const OPENCODE_AUTH_ID = "opencode-zen";
const PROVIDER_NAME = "9Router";
const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const OPENCODE_ALWAYS_FREE_IDS = new Set(["big-pickle"]);
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const AUTH_FILE = join(AGENT_DIR, "auth.json");
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type AuthEntry = { type: "api_key"; key: string };
type AuthFile = Record<string, unknown>;

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
type Provider = {
  id?: string;
  provider?: string;
  name?: string;
  isActive?: boolean;
  testStatus?: string;
  enabled?: boolean;
  active?: boolean;
  connected?: boolean;
};
type ProvidersResponse =
  | Provider[]
  | { connections?: Provider[]; providers?: Provider[]; data?: Provider[] };

type SqliteDatabase = {
  prepare: (query: string) => {
    get: () => { count: number };
    all: () => Array<{ id?: string; key?: string; data?: string }>;
  };
  close: () => void;
};

type LocalDatabasePaths = {
  dataDir: string;
  databaseFile: string;
  betterSqlite3Path: string;
};

/**
 * 9Router uses Electron's userData directory. That directory is:
 * - Windows: %APPDATA%/9router
 * - macOS: ~/Library/Application Support/9router
 * - Linux: ~/.config/9router
 *
 * Keep ~/.9router as a legacy fallback because older 9Router builds used it.
 * DATA_DIR remains an explicit override for portable/custom installations.
 */
function getDataDirCandidates(): string[] {
  const override = process.env.DATA_DIR?.trim();
  if (override) return [override];

  const home = homedir();
  if (process.platform === "win32") {
    return [
      join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "9router"),
    ];
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
    join(
      dataDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
    ),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

function getLocalDatabasePaths(): LocalDatabasePaths {
  const candidates = getDataDirCandidates();
  const dataDir =
    candidates.find(
      (candidate) =>
        existsSync(join(candidate, "db", "data.sqlite")) &&
        existsSync(getBetterSqlite3Path(candidate)),
    ) ??
    candidates.find((candidate) =>
      existsSync(join(candidate, "db", "data.sqlite")),
    ) ??
    candidates[0]!;

  return {
    dataDir,
    databaseFile: join(dataDir, "db", "data.sqlite"),
    betterSqlite3Path: getBetterSqlite3Path(dataDir),
  };
}

function getLocalActiveConnectionCount(): number | null {
  const { databaseFile, betterSqlite3Path } = getLocalDatabasePaths();

  try {
    const require = createRequire(import.meta.url);
    const Database = require(betterSqlite3Path) as new (
      file: string,
      options?: object,
    ) => SqliteDatabase;
    const database = new Database(databaseFile, { readonly: true });
    try {
      return database
        .prepare(
          "SELECT COUNT(*) AS count FROM providerConnections WHERE isActive != 0",
        )
        .get().count;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

async function ensureAgentDir(): Promise<void> {
  await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
}

async function readAuthFile(): Promise<AuthFile> {
  try {
    const content = await readFile(AUTH_FILE, "utf8");
    if (!content.trim()) return {};
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Pi auth.json does not contain a valid object.");
    }
    return parsed as AuthFile;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return {};
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
  try {
    await chmod(tempFile, 0o600);
  } catch {
    /* Windows may ignore chmod. */
  }
  await rename(tempFile, AUTH_FILE);
  try {
    await chmod(AUTH_FILE, 0o600);
  } catch {
    /* Windows may ignore chmod. */
  }
}

async function getStoredApiKey(providerId: string): Promise<string | null> {
  const credential = (await readAuthFile())[providerId];
  if (
    typeof credential !== "object" ||
    credential === null ||
    Array.isArray(credential)
  ) {
    return null;
  }
  const entry = credential as Partial<AuthEntry>;
  return entry.type === "api_key" &&
    typeof entry.key === "string" &&
    entry.key.trim()
    ? entry.key.trim()
    : null;
}

async function saveStoredApiKey(
  providerId: string,
  key: string,
): Promise<void> {
  const auth = await readAuthFile();
  auth[providerId] = { type: "api_key", key: key.trim() } satisfies AuthEntry;
  await writeAuthFile(auth);
}

async function removeStoredApiKey(providerId: string): Promise<void> {
  const auth = await readAuthFile();
  delete auth[providerId];
  await writeAuthFile(auth);
}

async function getApiKey(): Promise<string | null> {
  return getStoredApiKey(PROVIDER_ID);
}

async function getOpenCodeApiKey(): Promise<string | null> {
  return getStoredApiKey(OPENCODE_AUTH_ID);
}

async function saveApiKey(key: string): Promise<void> {
  await saveStoredApiKey(PROVIDER_ID, key);
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

function normalizeProviders(response: ProvidersResponse): Provider[] {
  if (Array.isArray(response)) return response;
  return response.connections ?? response.providers ?? response.data ?? [];
}

function providerId(provider: Provider): string {
  return provider.id ?? provider.provider ?? "unknown";
}

function providerName(provider: Provider): string {
  return provider.name ?? provider.provider ?? provider.id ?? "Unknown";
}

function isConnected(provider: Provider): boolean {
  return (
    provider.isActive !== false &&
    provider.testStatus !== "error" &&
    provider.testStatus !== "untested" &&
    provider.enabled !== false &&
    provider.active !== false &&
    provider.connected !== false
  );
}

function getLocalAvailableModelIds(): Map<string, Set<string>> | null {
  const { databaseFile, betterSqlite3Path } = getLocalDatabasePaths();

  try {
    const require = createRequire(import.meta.url);
    const Database = require(betterSqlite3Path) as new (
      file: string,
      options?: object,
    ) => SqliteDatabase;
    const database = new Database(databaseFile, { readonly: true });
    try {
      const nodes = database
        .prepare("SELECT id, data FROM providerNodes")
        .all();
      const prefixByNodeId = new Map<string, string>();
      for (const node of nodes) {
        if (!node.id || !node.data) continue;
        try {
          const data: unknown = JSON.parse(node.data);
          if (
            typeof data === "object" &&
            data !== null &&
            typeof (data as { prefix?: unknown }).prefix === "string"
          ) {
            prefixByNodeId.set(node.id, (data as { prefix: string }).prefix);
          }
        } catch {
          /* Ignore malformed local node records. */
        }
      }

      const rows = database
        .prepare("SELECT key FROM kv WHERE scope = 'customModels'")
        .all();
      const modelsByProvider = new Map<string, Set<string>>();
      for (const row of rows) {
        if (!row.key) continue;
        const separator = row.key.indexOf("|");
        const lastSeparator = row.key.lastIndexOf("|");
        if (separator <= 0 || lastSeparator <= separator) continue;
        // customModels is keyed by compatible-node ID, whereas /v1/models
        // exposes models using that node's configurable prefix.
        const nodeId = row.key.slice(0, separator);
        const provider = prefixByNodeId.get(nodeId) ?? nodeId;
        const modelId = row.key.slice(separator + 1, lastSeparator);
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

function filterToLocalAvailableModels(
  models: RouterModel[],
  availableModels: Map<string, Set<string>> | null,
): RouterModel[] {
  if (!availableModels?.size) return models;
  return models.filter((model) => {
    const separator = model.id.indexOf("/");
    if (separator <= 0) return true;
    const provider = model.id.slice(0, separator);
    const modelId = model.id.slice(separator + 1);
    const selected = availableModels.get(provider);
    return !selected || selected.has(modelId);
  });
}

async function getModels(apiKey: string): Promise<RouterModel[]> {
  const response = await request<ModelsResponse>("/v1/models", apiKey);
  const discoveredModels = response.data ?? [];
  // For OpenAI Compatible nodes, 9Router may append every model from the
  // upstream /models endpoint even when Dashboard selected a smaller list.
  // customModels in the local DB is the dashboard's authoritative selection.
  const models = filterToLocalAvailableModels(
    discoveredModels,
    getLocalAvailableModelIds(),
  );

  // 9Router exposes richer metadata per model through this endpoint.
  return Promise.all(
    models.map(async (model) => {
      try {
        const info = await request<ModelInfo>(
          `/v1/models/info?id=${encodeURIComponent(model.id)}`,
          apiKey,
        );
        return { ...model, ...info };
      } catch {
        return model;
      }
    }),
  );
}

async function getOpenCodeFreeModels(
  apiKey: string,
): Promise<RouterModel[] | null> {
  try {
    const response = await fetch(OPENCODE_ZEN_MODELS_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    // null membedakan kegagalan refresh dari katalog valid yang kebetulan kosong.
    if (!response.ok) return null;
    const json = (await response.json()) as ModelsResponse;
    return (
      (json.data ?? [])
        // OpenCode memberi suffix -free pada model gratis. big-pickle adalah
        // pengecualian yang gratis tanpa suffix, jadi tetap dipertahankan.
        .filter(
          (model) =>
            model.id.endsWith("-free") ||
            OPENCODE_ALWAYS_FREE_IDS.has(model.id),
        )
        .map((model) => ({ ...model, id: `oc/${model.id}` }))
    );
  } catch {
    return null;
  }
}

function mergeModels(...groups: RouterModel[][]): RouterModel[] {
  return [...new Map(groups.flat().map((model) => [model.id, model])).values()];
}

async function fetchMergedModels(
  apiKey: string,
): Promise<RouterModel[] | null> {
  const openCodeApiKey = (await getOpenCodeApiKey()) ?? apiKey;
  const [discoveredModels, officialFreeModels] = await Promise.all([
    getModels(apiKey),
    getOpenCodeFreeModels(openCodeApiKey),
  ]);
  // Jangan mengganti snapshot lama jika katalog OpenCode gagal di-refresh.
  if (officialFreeModels === null) return null;
  const connectionCount = getLocalActiveConnectionCount();
  return mergeModels(
    connectionCount === 0 ? [] : discoveredModels,
    officialFreeModels,
  );
}

function toProviderModelDefs(models: RouterModel[]): ProviderModelConfig[] {
  return models.map((model): ProviderModelConfig => {
    const capabilities = model.capabilities ?? {};
    const supportsVision =
      capabilities.vision === true || capabilities.images === true;
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

function registerProvider(
  pi: ExtensionAPI,
  apiKey: string,
  models: RouterModel[],
): void {
  let lastModels: ProviderModelConfig[] | undefined;
  const config: ProviderConfig = {
    name: PROVIDER_NAME,
    baseUrl: `${NINEROUTER_URL}/v1`,
    apiKey,
    authHeader: true,
    api: "openai-completions",
    models: toProviderModelDefs(models),
    // Dipanggil Pi saat refresh model (mis. /model), sehingga daftar
    // model selalu diambil ulang dari 9Router dan OpenCode Zen.
    async refreshModels(): Promise<ProviderModelConfig[]> {
      const key = await getApiKey();
      if (!key) return lastModels ?? [];
      try {
        const models = await fetchMergedModels(key);
        if (models === null) return lastModels ?? [];
        lastModels = toProviderModelDefs(models);
        return lastModels;
      } catch {
        // Gagal refresh: pertahankan snapshot terakhir yang terdaftar.
        return lastModels ?? [];
      }
    },
  };
  lastModels = config.models;
  pi.registerProvider(PROVIDER_ID, config);
}

function groupModelsByProvider(
  models: RouterModel[],
): Map<string, RouterModel[]> {
  const groups = new Map<string, RouterModel[]>();
  for (const model of models) {
    const separator = model.id.indexOf("/");
    const provider = separator > 0 ? model.id.slice(0, separator) : "unknown";
    const group = groups.get(provider) ?? [];
    group.push(model);
    groups.set(provider, group);
  }
  return groups;
}

function maskApiKey(key: string): string {
  return key.length <= 8
    ? "********"
    : `${key.slice(0, 4)}********${key.slice(-4)}`;
}

const LOGIN_9ROUTER_OPTION = "Tambah/ubah API key 9Router";
const LOGIN_OPENCODE_OPTION = "Tambah/ubah API key OpenCode Zen";

async function login(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.notify("Checking 9Router credentials...", "info");

  try {
    let apiKey = await getApiKey();

    // 9Router wajib tersedia sebelum opsi OpenCode Zen ditampilkan.
    if (!apiKey) {
      const value = await ctx.ui.input("9Router API key (wajib):");
      if (!value?.trim()) {
        ctx.ui.notify("9Router API key is required.", "error");
        return;
      }
      apiKey = value.trim();
      await getModels(apiKey);
      await saveApiKey(apiKey);
    }

    const choice = await ctx.ui.select("Pilih credential yang ingin diatur:", [
      LOGIN_9ROUTER_OPTION,
      LOGIN_OPENCODE_OPTION,
    ]);

    if (choice === LOGIN_9ROUTER_OPTION) {
      const value = await ctx.ui.input("9Router API key (wajib):");
      if (!value?.trim()) {
        ctx.ui.notify("9Router API key update cancelled.", "warning");
        return;
      }
      const nextApiKey = value.trim();
      await getModels(nextApiKey);
      await saveApiKey(nextApiKey);
      apiKey = nextApiKey;
    } else if (choice === LOGIN_OPENCODE_OPTION) {
      const value = await ctx.ui.input("OpenCode Zen API key (opsional):");
      if (!value?.trim()) {
        ctx.ui.notify("OpenCode Zen API key update cancelled.", "warning");
        return;
      }
      const openCodeApiKey = value.trim();
      const models = await getOpenCodeFreeModels(openCodeApiKey);
      if (models === null)
        throw new Error("OpenCode Zen API key is invalid or unavailable.");
      await saveStoredApiKey(OPENCODE_AUTH_ID, openCodeApiKey);
    }

    const openCodeApiKey = (await getOpenCodeApiKey()) ?? apiKey;
    // API keys are documented for the OpenAI-compatible /v1/* endpoints.
    // /api/providers is a dashboard/session endpoint and can return 401.
    const [discoveredModels, officialFreeModels] = await Promise.all([
      getModels(apiKey),
      getOpenCodeFreeModels(openCodeApiKey),
    ]);
    const connectionCount = getLocalActiveConnectionCount();
    const models = mergeModels(
      connectionCount === 0 ? [] : discoveredModels,
      officialFreeModels ?? [],
    );
    registerProvider(pi, apiKey, models);
    ctx.ui.notify(
      `9Router connected. Providers: ${connectionCount ?? groupModelsByProvider(models).size} | Models: ${models.length}`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `9Router login failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function showStatus(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    const rawLines = ["Not Authenticated", "Run `/9router-login` to connect"];
    const maxContentWidth = Math.max(...rawLines.map((l) => l.length), 30);
    const innerWidth = maxContentWidth + 2;
    const title = " 9ROUTER STATUS ";
    const top = `╭──${title}${"─".repeat(Math.max(0, innerWidth - title.length - 2))}╮`;
    const bottom = `╰${"─".repeat(innerWidth)}╯`;

    ctx.ui.notify(
      [
        top,
        ...rawLines.map((l) => `│ ${l.padEnd(maxContentWidth)} │`),
        bottom,
      ].join("\n"),
      "warning",
    );
    return;
  }

  try {
    const openCodeApiKey = (await getOpenCodeApiKey()) ?? apiKey;
    const [discoveredModels, officialFreeModels] = await Promise.all([
      getModels(apiKey),
      getOpenCodeFreeModels(openCodeApiKey),
    ]);
    const connectionCount = getLocalActiveConnectionCount();
    const models = mergeModels(
      connectionCount === 0 ? [] : discoveredModels,
      officialFreeModels ?? [],
    );

    registerProvider(pi, apiKey, models);
    const groups = groupModelsByProvider(models);
    const providers = [...groups.entries()];
    const providerCount = connectionCount ?? providers.length;
    const modelCount = models.length;

    const rawHeaderLines = [
      `URL: ${NINEROUTER_URL}  | Key: ${maskApiKey(apiKey)} | ● CONNECTED`,
      `Overview: ${providerCount} Provider${providerCount !== 1 ? "s" : ""} • ${modelCount} Model${modelCount !== 1 ? "s" : ""}`,
    ];

    // Tentukan lebar konten bersih
    const maxContentWidth = Math.max(
      ...rawHeaderLines.map((l) => l.length),
      38,
    );
    const innerWidth = maxContentWidth + 2; // +2 untuk spasi padding kiri & kanan
    const title = " 9ROUTER STATUS ";
    const topBorder = `╭──${title}${"─".repeat(Math.max(0, innerWidth - title.length - 2))}╮`;
    const bottomBorder = `╰${"─".repeat(innerWidth)}╯`;

    const lines = [
      topBorder,
      ...rawHeaderLines.map((l) => `│ ${l.padEnd(maxContentWidth)} │`),
      bottomBorder,
      "",
      ...providers.flatMap(([provider, providerModels]) => {
        const providerLines: string[] = [
          ` ❯ ${provider} (${providerModels.length})`,
        ];
        providerModels.forEach((model, mIdx) => {
          const isLastModel = mIdx === providerModels.length - 1;
          const modelPrefix = isLastModel ? "   └─ " : "   ├─ ";
          providerLines.push(`${modelPrefix}${model.name ?? model.id}`);
        });
        return providerLines;
      }),
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const rawErrLines = [`URL: ${NINEROUTER_URL} | ● FAILED`, `Error: ${msg}`];
    const maxContentWidth = Math.max(...rawErrLines.map((l) => l.length), 38);
    const innerWidth = maxContentWidth + 2;
    const title = " 9ROUTER STATUS ";
    const errTop = `╭──${title}${"─".repeat(Math.max(0, innerWidth - title.length - 2))}╮`;
    const errBottom = `╰${"─".repeat(innerWidth)}╯`;

    ctx.ui.notify(
      [
        errTop,
        ...rawErrLines.map((l) => `│ ${l.padEnd(maxContentWidth)} │`),
        errBottom,
      ].join("\n"),
      "error",
    );
  }
}

async function logout(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const hasRouterKey = Boolean(await getApiKey());
  const hasOpenCodeKey = Boolean(await getOpenCodeApiKey());
  if (!hasRouterKey && !hasOpenCodeKey) {
    ctx.ui.notify("9Router is not configured.", "info");
    return;
  }
  if (
    !(await ctx.ui.confirm(
      "Logout 9Router?",
      "Remove 9Router and OpenCode Zen credentials from Pi auth.json?",
    ))
  )
    return;
  await removeStoredApiKey(PROVIDER_ID);
  await removeStoredApiKey(OPENCODE_AUTH_ID);
  pi.unregisterProvider(PROVIDER_ID);
  ctx.ui.notify("9Router and OpenCode Zen credentials removed.", "info");
}

export default function (pi: ExtensionAPI): void {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  pi.registerCommand("9router-login", {
    description: "Login to 9Router and save API key",
    handler: async (_args, ctx) => login(pi, ctx),
  });
  pi.registerCommand("9router-status", {
    description: "Show 9Router connection and provider status",
    handler: async (_args, ctx) => showStatus(pi, ctx),
  });
  pi.registerCommand("9router-logout", {
    description: "Remove 9Router credentials",
    handler: async (_args, ctx) => logout(pi, ctx),
  });

  // Jangan menunggu network/database saat factory extension dimuat.
  // session_start terjadi setelah workspace dan editor Pi siap dirender.
  pi.on("session_start", async (_event, _ctx) => {
    try {
      const apiKey = await getApiKey();
      if (!apiKey) return;

      const openCodeApiKey = (await getOpenCodeApiKey()) ?? apiKey;
      const [discoveredModels, officialFreeModels] = await Promise.all([
        getModels(apiKey),
        getOpenCodeFreeModels(openCodeApiKey),
      ]);
      const connectionCount = getLocalActiveConnectionCount();
      const models = mergeModels(
        connectionCount === 0 ? [] : discoveredModels,
        officialFreeModels ?? [],
      );
      registerProvider(pi, apiKey, models);

      // Auto-refresh berkala agar model OpenCode Free tetap up-to-date.
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        void (async () => {
          const key = await getApiKey();
          if (!key) return;
          try {
            const models = await fetchMergedModels(key);
            if (models === null) return;
            registerProvider(pi, key, models);
          } catch {
            /* Refresh gagal: biarkan snapshot terakhir tetap terpakai. */
          }
        })();
      }, REFRESH_INTERVAL_MS);
    } catch {
      // Katalog gagal dimuat; provider mempertahankan snapshot sebelumnya.
    }
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });
}
