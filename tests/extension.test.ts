import { describe, expect, it, vi } from "vitest";
import supabaseExtension from "../extensions/index.js";
import { filterReadOnlyTools, formatToolResult, isWriteTool } from "../extensions/mcp-client.js";

describe("Pi Supabase extension", () => {
  it("registers management tools, command, and lifecycle hooks", () => {
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
      getActiveTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    };

    supabaseExtension(pi as never);

    const names = pi.registerTool.mock.calls.map(([tool]) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "supabase_mcp_connect",
        "supabase_mcp_status",
        "supabase_mcp_disconnect",
        "supabase_mcp_logout",
      ]),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith("supabase", expect.any(Object));
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("formats text, resource, and structured MCP results", async () => {
    await expect(formatToolResult({ content: [{ type: "text", text: "hello" }] })).resolves.toMatchObject({
      text: "hello",
      truncated: false,
    });
    await expect(
      formatToolResult({ content: [{ type: "resource", resource: { uri: "file:///x", text: "body" } }] }),
    ).resolves.toMatchObject({ text: "[Resource: file:///x]\nbody" });
    await expect(formatToolResult({ structuredContent: { ok: true } })).resolves.toMatchObject({
      text: '{\n  "ok": true\n}',
    });
  });

  it("fails closed when MCP tools omit safety annotations", () => {
    const unannotated = { name: "mystery", inputSchema: { type: "object" as const } };
    const readOnly = {
      name: "list_tables",
      inputSchema: { type: "object" as const },
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    expect(isWriteTool(unannotated)).toBe(true);
    expect(filterReadOnlyTools([unannotated, readOnly]).map((tool) => tool.name)).toEqual(["list_tables"]);
  });
});
