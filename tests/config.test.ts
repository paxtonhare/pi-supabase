import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMcpUrl, loadConfig } from "../extensions/config.js";

const ENV_KEYS = [
  "HOME",
  "SUPABASE_MCP_URL",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_MCP_READ_ONLY",
  "SUPABASE_MCP_FEATURES",
  "SUPABASE_MCP_CONFIRM_WRITES",
  "SUPABASE_MCP_AUTO_CONNECT",
  "SUPABASE_MCP_TOOL_PREFIX",
  "SUPABASE_MCP_CALLBACK_PORT",
  "SUPABASE_MCP_TIMEOUT_MS",
  "SUPABASE_MCP_AUTH_FILE",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-supabase-config-"));
  tempDirs.push(cwd);
  process.env.HOME = cwd;
  process.env.SUPABASE_MCP_AUTH_FILE = join(cwd, "auth.json");
  return cwd;
}

describe("Supabase configuration", () => {
  it("defaults to hosted, read-only MCP", () => {
    const config = loadConfig({ cwd: project(), projectTrusted: false });
    expect(config.url).toBe("https://mcp.supabase.com/mcp");
    expect(config.readOnly).toBe(true);
    expect(config.confirmWrites).toBe(true);
    expect(config.toolPrefix).toBe("supabase_");
  });

  it("loads trusted project settings and linked project refs", () => {
    const cwd = project();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(join(cwd, ".supabase", ".temp"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "supabase.json"), JSON.stringify({ features: ["database", "docs"] }));
    writeFileSync(join(cwd, ".supabase", ".temp", "project-ref"), "linked-ref\n");

    const config = loadConfig({ cwd, projectTrusted: true });
    expect(config.projectRef).toBe("linked-ref");
    expect(config.features).toEqual(["database", "docs"]);
  });

  it("lets environment variables override files and builds query parameters", () => {
    const cwd = project();
    process.env.SUPABASE_PROJECT_REF = "env-ref";
    process.env.SUPABASE_MCP_READ_ONLY = "false";
    process.env.SUPABASE_MCP_FEATURES = "database,debugging";

    const config = loadConfig({ cwd, projectTrusted: false });
    const url = buildMcpUrl(config);
    expect(url.searchParams.get("project_ref")).toBe("env-ref");
    expect(url.searchParams.has("read_only")).toBe(false);
    expect(url.searchParams.get("features")).toBe("database,debugging");
  });

  it("rejects invalid feature groups", () => {
    process.env.SUPABASE_MCP_FEATURES = "database,nope";
    expect(() => loadConfig({ cwd: project(), projectTrusted: false })).toThrow("Unknown Supabase feature group");
  });
});
