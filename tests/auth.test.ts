import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, newOAuthState, parseManualCallback, startCallbackServer, SupabaseOAuthProvider } from "../extensions/auth.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function authPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-supabase-auth-"));
  tempDirs.push(directory);
  return join(directory, "auth.json");
}

describe("Supabase OAuth", () => {
  it("persists credentials with private file permissions and clears individual scopes", async () => {
    const path = authPath();
    const storage = new AuthStorage(path);
    await storage.update({
      clientInformation: { client_id: "client", client_secret: "secret" },
      tokens: { access_token: "access", token_type: "bearer" },
      codeVerifier: "verifier",
    });

    expect(JSON.parse(readFileSync(path, "utf8")).tokens.access_token).toBe("access");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    await storage.clear("tokens");
    expect((await storage.load()).tokens).toBeUndefined();
    expect((await storage.load()).clientInformation).toBeDefined();
  });

  it("uses the official SDK provider persistence contract", async () => {
    const storage = new AuthStorage(authPath());
    const redirect = "http://127.0.0.1:54324/callback";
    const onRedirect = vi.fn();
    const provider = new SupabaseOAuthProvider(redirect, storage, "state-1", onRedirect);
    await provider.saveClientInformation({ client_id: "client-1", client_secret: "secret-1" });
    await provider.saveTokens({ access_token: "token-1", token_type: "bearer" });
    await provider.saveCodeVerifier("verifier-1");

    expect(await provider.clientInformation()).toMatchObject({ client_id: "client-1" });
    expect(await provider.tokens()).toMatchObject({ access_token: "token-1" });
    expect(await provider.codeVerifier()).toBe("verifier-1");
    expect(provider.state()).toBe("state-1");
    expect(provider.clientMetadata.redirect_uris).toEqual([redirect]);
  });

  it("receives and validates browser callbacks", async () => {
    const state = newOAuthState();
    const callback = await startCallbackServer(0, state, 5_000);
    await fetch(`${callback.redirectUrl}?state=${state}&code=code-123`);
    await expect(callback.wait()).resolves.toEqual({ code: "code-123", state });
    await callback.close();
  });

  it("parses manual redirect URLs and rejects state mismatches", () => {
    expect(parseManualCallback("https://localhost/callback?state=ok&code=code-1", "ok")).toBe("code-1");
    expect(() => parseManualCallback("raw-code", "ok")).toThrow("complete Supabase redirect URL");
    expect(() => parseManualCallback("https://localhost/callback?state=bad&code=code-1", "ok")).toThrow(
      "state mismatch",
    );
  });
});
