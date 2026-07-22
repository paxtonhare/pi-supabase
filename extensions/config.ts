import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_MCP_URL = "https://mcp.supabase.com/mcp";
export const FEATURE_GROUPS = [
  "account",
  "branching",
  "database",
  "debugging",
  "development",
  "docs",
  "functions",
  "storage",
] as const;

export interface SupabaseConfig {
  url: string;
  projectRef?: string;
  readOnly: boolean;
  features?: string[];
  confirmWrites: boolean;
  autoConnect: boolean;
  toolPrefix: string;
  callbackPort: number;
  requestTimeoutMs: number;
  authFile: string;
}

export interface ConfigContext {
  cwd: string;
  projectTrusted: boolean;
}

type ConfigFile = Partial<Omit<SupabaseConfig, "authFile">> & { authFile?: string };

const DEFAULT_CONFIG: Omit<SupabaseConfig, "authFile"> = {
  url: DEFAULT_MCP_URL,
  readOnly: true,
  confirmWrites: true,
  autoConnect: true,
  toolPrefix: "supabase_",
  callbackPort: 54324,
  requestTimeoutMs: 120_000,
};

function resolveHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

export function defaultAuthFile(): string {
  return join(homedir(), ".pi", "agent", "supabase-mcp-auth.json");
}

function readConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Supabase config at ${path}: ${message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Supabase config at ${path} must contain a JSON object`);
  }
  return value as ConfigFile;
}

function envBoolean(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function envInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function readLinkedProjectRef(cwd: string): string | undefined {
  const path = join(cwd, ".supabase", ".temp", "project-ref");
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value || undefined;
}

function validateConfig(config: SupabaseConfig): SupabaseConfig {
  const url = new URL(config.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Supabase MCP URL must use http or https");
  }
  if (!/^[a-z0-9_]+$/.test(config.toolPrefix)) {
    throw new Error("Supabase toolPrefix must contain only lowercase letters, numbers, and underscores");
  }
  if (!Number.isSafeInteger(config.callbackPort) || config.callbackPort < 1 || config.callbackPort > 65535) {
    throw new Error("Supabase callbackPort must be between 1 and 65535");
  }
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1) {
    throw new Error("Supabase requestTimeoutMs must be a positive integer");
  }
  if (config.features) {
    const unknown = config.features.filter((feature) => !(FEATURE_GROUPS as readonly string[]).includes(feature));
    if (unknown.length > 0) throw new Error(`Unknown Supabase feature group(s): ${unknown.join(", ")}`);
  }
  return config;
}

export function loadConfig(context: ConfigContext): SupabaseConfig {
  const globalPath = join(homedir(), ".pi", "agent", "supabase.json");
  const projectPath = join(context.cwd, ".pi", "supabase.json");
  const globalConfig = readConfigFile(globalPath);
  const projectConfig = context.projectTrusted ? readConfigFile(projectPath) : {};
  const merged: ConfigFile = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };

  const features = process.env.SUPABASE_MCP_FEATURES
    ? process.env.SUPABASE_MCP_FEATURES.split(",").map((item) => item.trim()).filter(Boolean)
    : merged.features;
  const projectRef = process.env.SUPABASE_PROJECT_REF || merged.projectRef || readLinkedProjectRef(context.cwd);
  const authFile = resolveHome(process.env.SUPABASE_MCP_AUTH_FILE || merged.authFile || defaultAuthFile());

  return validateConfig({
    url: process.env.SUPABASE_MCP_URL || merged.url || DEFAULT_MCP_URL,
    projectRef,
    readOnly: envBoolean("SUPABASE_MCP_READ_ONLY") ?? merged.readOnly ?? true,
    features,
    confirmWrites: envBoolean("SUPABASE_MCP_CONFIRM_WRITES") ?? merged.confirmWrites ?? true,
    autoConnect: envBoolean("SUPABASE_MCP_AUTO_CONNECT") ?? merged.autoConnect ?? true,
    toolPrefix: process.env.SUPABASE_MCP_TOOL_PREFIX || merged.toolPrefix || "supabase_",
    callbackPort: envInteger("SUPABASE_MCP_CALLBACK_PORT") ?? merged.callbackPort ?? 54324,
    requestTimeoutMs: envInteger("SUPABASE_MCP_TIMEOUT_MS") ?? merged.requestTimeoutMs ?? 120_000,
    authFile,
  });
}

export function buildMcpUrl(config: SupabaseConfig): URL {
  const url = new URL(config.url);
  if (config.projectRef) url.searchParams.set("project_ref", config.projectRef);
  else url.searchParams.delete("project_ref");
  if (config.readOnly) url.searchParams.set("read_only", "true");
  else url.searchParams.delete("read_only");
  if (config.features?.length) url.searchParams.set("features", config.features.join(","));
  else url.searchParams.delete("features");
  return url;
}

export function isLocalMcpUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}
