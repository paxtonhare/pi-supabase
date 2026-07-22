import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage, newOAuthState, parseManualCallback, startCallbackServer, SupabaseOAuthProvider } from "./auth.js";
import { buildMcpUrl, isLocalMcpUrl, type SupabaseConfig } from "./config.js";

export type RemoteTool = Tool;

export interface ConnectOptions {
  interactive: boolean;
  manual?: boolean;
  signal?: AbortSignal;
  notify?: (message: string) => void;
  input?: (prompt: string, placeholder?: string) => Promise<string | undefined>;
}

export interface RuntimeStatus {
  connected: boolean;
  endpoint: string;
  projectRef?: string;
  readOnly: boolean;
  features?: string[];
  auth: "oauth" | "access-token" | "local";
  toolCount: number;
}

export class AuthenticationRequiredError extends Error {
  constructor(readonly authorizationUrl?: string) {
    super("Supabase authentication is required. Run /supabase connect (or /supabase manual over SSH).");
    this.name = "AuthenticationRequiredError";
  }
}

function accessToken(): string | undefined {
  const value = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  return value || undefined;
}

function authKind(url: URL): RuntimeStatus["auth"] {
  if (isLocalMcpUrl(url)) return "local";
  return accessToken() ? "access-token" : "oauth";
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function saveAuthorizationUrl(url: string): Promise<string> {
  const directory = join(homedir(), ".pi", "agent");
  const path = join(directory, "supabase-oauth-url.txt");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${url}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

async function saveFullOutput(output: string): Promise<string> {
  const directory = join(tmpdir(), "pi-supabase");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `tool-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
  return path;
}

function stringifyContent(content: unknown): string {
  if (!content || typeof content !== "object") return JSON.stringify(content);
  const value = content as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (value.type === "resource" && value.resource && typeof value.resource === "object") {
    const resource = value.resource as Record<string, unknown>;
    const body = typeof resource.text === "string" ? resource.text : JSON.stringify(resource);
    return `[Resource: ${String(resource.uri || "unknown")}]\n${body}`;
  }
  if (value.type === "image") return `[Image result: ${String(value.mimeType || "unknown media type")}]`;
  if (value.type === "audio") return `[Audio result: ${String(value.mimeType || "unknown media type")}]`;
  return JSON.stringify(value, null, 2);
}

export async function formatToolResult(result: unknown): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
  const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const content = Array.isArray(value.content) ? value.content : [];
  const structuredContent = value.structuredContent && typeof value.structuredContent === "object"
    ? (value.structuredContent as Record<string, unknown>)
    : undefined;
  const parts = content.map(stringifyContent).filter(Boolean);
  if (parts.length === 0 && structuredContent) parts.push(JSON.stringify(structuredContent, null, 2));
  if (parts.length === 0 && Object.keys(value).length > 0) parts.push(JSON.stringify(value, null, 2));
  const full = parts.join("\n");
  const truncation = truncateHead(full, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncation.truncated) return { text: truncation.content, truncated: false };
  const fullOutputPath = await saveFullOutput(full);
  const notice =
    `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    `Full output saved to: ${fullOutputPath}]`;
  return { text: truncation.content + notice, truncated: true, fullOutputPath };
}

export function isWriteTool(tool: RemoteTool): boolean {
  return tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true;
}

export function filterReadOnlyTools(tools: RemoteTool[]): RemoteTool[] {
  return tools.filter((tool) => tool.annotations?.readOnlyHint === true);
}

export class SupabaseMcpRuntime {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools: RemoteTool[] = [];
  private connecting?: Promise<RemoteTool[]>;
  private connectionGeneration = 0;
  private readonly authStorage: AuthStorage;

  constructor(
    readonly config: SupabaseConfig,
    private readonly onToolsChanged?: (tools: RemoteTool[]) => void,
  ) {
    this.authStorage = new AuthStorage(config.authFile);
  }

  get endpoint(): URL {
    return buildMcpUrl(this.config);
  }

  get connected(): boolean {
    return Boolean(this.client && this.transport);
  }

  getTools(): RemoteTool[] {
    return [...this.tools];
  }

  status(): RuntimeStatus {
    const endpoint = this.endpoint;
    return {
      connected: this.connected,
      endpoint: endpoint.toString(),
      projectRef: this.config.projectRef,
      readOnly: this.config.readOnly,
      features: this.config.features,
      auth: authKind(endpoint),
      toolCount: this.tools.length,
    };
  }

  async hasReusableCredentials(): Promise<boolean> {
    const endpoint = this.endpoint;
    return isLocalMcpUrl(endpoint) || Boolean(accessToken()) || this.authStorage.hasTokens();
  }

  async connect(options: ConnectOptions): Promise<RemoteTool[]> {
    if (this.connected) return this.getTools();
    if (this.connecting) return this.connecting;
    const generation = this.connectionGeneration;
    this.connecting = this.connectInternal(options, generation).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private createClient(): Client {
    return new Client(
      { name: "pi-supabase", version: "0.1.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error || !tools) return;
              this.setTools(tools);
            },
          },
        },
      },
    );
  }

  private createTransport(url: URL, provider?: SupabaseOAuthProvider): StreamableHTTPClientTransport {
    const token = accessToken();
    const requestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
    return new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit });
  }

  private async connectInternal(options: ConnectOptions, generation: number): Promise<RemoteTool[]> {
    const endpoint = this.endpoint;
    const usesOAuth = !isLocalMcpUrl(endpoint) && !accessToken();
    const state = newOAuthState();
    let callback;
    if (usesOAuth && options.interactive) {
      try {
        callback = await startCallbackServer(this.config.callbackPort, state);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          throw new Error(
            `Supabase OAuth callback port ${this.config.callbackPort} is already in use. ` +
              "Close the other process or set SUPABASE_MCP_CALLBACK_PORT.",
          );
        }
        throw error;
      }
    }
    const stored = usesOAuth ? await this.authStorage.load() : {};
    const redirectUrl = callback?.redirectUrl || stored.redirectUrl || `http://127.0.0.1:${this.config.callbackPort}/callback`;
    let authorizationUrl: URL | undefined;
    const provider = usesOAuth
      ? new SupabaseOAuthProvider(redirectUrl, this.authStorage, state, (url) => {
          authorizationUrl = url;
        })
      : undefined;

    let client = this.createClient();
    let transport = this.createTransport(endpoint, provider);
    try {
      try {
        await client.connect(transport, { signal: options.signal, timeout: this.config.requestTimeoutMs });
      } catch (error) {
        if (!(error instanceof UnauthorizedError) || !provider) throw error;
        if (!options.interactive || !authorizationUrl) {
          throw new AuthenticationRequiredError(authorizationUrl?.toString());
        }

        const authUrl = authorizationUrl.toString();
        const savedPath = await saveAuthorizationUrl(authUrl);
        options.notify?.(`Supabase authorization URL saved to ${savedPath}`);
        let code: string;
        if (options.manual) {
          if (!options.input) throw new Error("Manual Supabase OAuth requires interactive input");
          options.notify?.("Open the authorization URL, approve access, then paste the localhost redirect URL.");
          const input = await options.input("Paste the complete Supabase redirect URL", callback?.redirectUrl);
          code = parseManualCallback(input || "", state);
        } else {
          options.notify?.("Opening Supabase authorization in your browser...");
          await openBrowser(authUrl);
          if (!callback) throw new Error("Supabase OAuth callback server is unavailable");
          code = (await callback.wait(options.signal)).code;
        }

        await transport.finishAuth(code);
        await client.close().catch(() => {});
        client = this.createClient();
        transport = this.createTransport(endpoint, provider);
        await client.connect(transport, { signal: options.signal, timeout: this.config.requestTimeoutMs });
      }

      if (generation !== this.connectionGeneration) {
        await client.close().catch(() => {});
        throw new Error("Supabase connection was cancelled by a disconnect request");
      }
      this.client = client;
      this.transport = transport;
      await this.refreshTools(options.signal);
      return this.getTools();
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    } finally {
      await callback?.close().catch(() => {});
    }
  }

  private setTools(tools: RemoteTool[]): void {
    this.tools = this.config.readOnly ? filterReadOnlyTools(tools) : tools;
    this.onToolsChanged?.(this.getTools());
  }

  async refreshTools(signal?: AbortSignal): Promise<RemoteTool[]> {
    if (!this.client) throw new Error("Supabase MCP is not connected");
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: this.config.requestTimeoutMs,
      });
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    this.setTools(tools);
    return this.getTools();
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: number, total?: number, message?: string) => void;
      confirmWrite?: (summary: string) => Promise<boolean>;
    } = {},
  ): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
    let client = this.client;
    if (!client) throw new Error("Supabase MCP is not connected. Run /supabase connect first.");
    const tool = this.tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Supabase MCP tool ${toolName} is no longer available`);
    if (!this.config.readOnly && this.config.confirmWrites && isWriteTool(tool)) {
      if (!options.confirmWrite) throw new Error(`Refusing write-capable Supabase tool ${tool.name} without confirmation`);
      const approved = await options.confirmWrite(`${tool.name}\n\n${JSON.stringify(args, null, 2).slice(0, 4000)}`);
      if (!approved) throw new Error(`User declined Supabase tool ${tool.name}`);
      client = this.client;
      if (!client) throw new Error("Supabase MCP disconnected before the confirmed write could run");
    }

    const result = await client.callTool({ name: tool.name, arguments: args }, undefined, {
      signal: options.signal,
      timeout: this.config.requestTimeoutMs,
      resetTimeoutOnProgress: true,
      onprogress: (progress) => options.onProgress?.(progress.progress, progress.total, progress.message),
    });
    const formatted = await formatToolResult(result);
    if ("isError" in result && result.isError) throw new Error(formatted.text || `Supabase tool ${tool.name} failed`);
    return formatted;
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration += 1;
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.tools = [];
    await client?.close().catch(() => {});
  }

  async logout(): Promise<void> {
    await this.disconnect();
    await this.authStorage.clear();
  }
}
