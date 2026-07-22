import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  redirectUrl?: string;
  updatedAt?: string;
}

export class AuthStorage {
  constructor(readonly path: string) {}

  async load(): Promise<StoredAuth> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as StoredAuth;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async update(patch: Partial<StoredAuth>): Promise<void> {
    const current = await this.load();
    await this.replace({ ...current, ...patch });
  }

  private async replace(value: StoredAuth): Promise<void> {
    const next = { ...value, updatedAt: new Date().toISOString() };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }

  async clear(scope: "all" | "client" | "tokens" | "verifier" | "discovery" = "all"): Promise<void> {
    if (scope === "all") {
      await rm(this.path, { force: true });
      return;
    }
    const current = await this.load();
    if (scope === "client") delete current.clientInformation;
    if (scope === "tokens") delete current.tokens;
    if (scope === "verifier") delete current.codeVerifier;
    if (scope === "discovery") delete current.discoveryState;
    await this.replace(current);
  }

  async hasTokens(): Promise<boolean> {
    return Boolean((await this.load()).tokens?.access_token);
  }
}

export class SupabaseOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    readonly redirectUrl: string,
    private readonly storage: AuthStorage,
    private readonly oauthState: string,
    private readonly onRedirect: (url: URL) => void | Promise<void>,
  ) {
    this.clientMetadata = {
      client_name: "pi-supabase",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  state(): string {
    return this.oauthState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.storage.load();
    return stored.redirectUrl === this.redirectUrl ? stored.clientInformation : undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.storage.update({ clientInformation, redirectUrl: this.redirectUrl });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.storage.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.storage.update({ tokens });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.storage.update({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.storage.load()).codeVerifier;
    if (!verifier) throw new Error("Supabase OAuth code verifier is missing");
    return verifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.storage.update({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.storage.load()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    await this.storage.clear(scope);
  }
}

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServer {
  redirectUrl: string;
  wait(signal?: AbortSignal): Promise<CallbackResult>;
  close(): Promise<void>;
}

function callbackHtml(success: boolean, message: string): string {
  const title = success ? "Supabase connected" : "Supabase authorization failed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;
}

export async function startCallbackServer(port: number, expectedState: string, timeoutMs = 300_000): Promise<CallbackServer> {
  let settled = false;
  let resolveResult: (result: CallbackResult) => void = () => {};
  let rejectResult: (error: Error) => void = () => {};
  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  result.catch(() => {});

  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      const description = url.searchParams.get("error_description") || oauthError;
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(callbackHtml(false, description));
      if (!settled) rejectResult(new Error(`Supabase authorization failed: ${description}`));
      settled = true;
      return;
    }
    if (state !== expectedState || !code) {
      response
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(callbackHtml(false, state !== expectedState ? "OAuth state mismatch." : "No authorization code received."));
      if (!settled) rejectResult(new Error(state !== expectedState ? "Supabase OAuth state mismatch" : "No authorization code received"));
      settled = true;
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(callbackHtml(true, "You can close this window and return to Pi."));
    if (!settled) resolveResult({ code, state });
    settled = true;
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not determine Supabase OAuth callback port");
  }
  const actualPort = address.port;

  const timer = setTimeout(() => {
    if (!settled) rejectResult(new Error("Supabase OAuth callback timed out after 5 minutes"));
    settled = true;
    server.close();
  }, timeoutMs);
  timer.unref();

  return {
    redirectUrl: `http://127.0.0.1:${actualPort}/callback`,
    wait(signal) {
      if (!signal) return result;
      if (signal.aborted) return Promise.reject(new Error("Supabase OAuth cancelled"));
      return Promise.race([
        result,
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Supabase OAuth cancelled")), { once: true });
        }),
      ]);
    },
    async close() {
      clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function parseManualCallback(input: string, expectedState: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("No Supabase authorization code provided");
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith("?") && !trimmed.includes("=")) {
    throw new Error("Paste the complete Supabase redirect URL so its OAuth state can be verified");
  }
  const params = /^https?:\/\//i.test(trimmed)
    ? new URL(trimmed).searchParams
    : new URLSearchParams(trimmed.replace(/^\?/, ""));
  if (params.get("state") !== expectedState) throw new Error("Supabase OAuth state mismatch");
  const oauthError = params.get("error");
  if (oauthError) throw new Error(`Supabase authorization failed: ${params.get("error_description") || oauthError}`);
  const code = params.get("code");
  if (!code) throw new Error("No Supabase authorization code provided");
  return code;
}

export function newOAuthState(): string {
  return randomBytes(24).toString("base64url");
}
