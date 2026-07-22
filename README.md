# pi-supabase

A Pi extension for the official [Supabase MCP server](https://supabase.com/docs/guides/ai-tools/mcp).

It handles Supabase OAuth, discovers the remote MCP tools, and registers them in Pi as first-class tools such as `supabase_list_tables`, `supabase_execute_sql`, and `supabase_search_docs`.

## Install

```bash
pi install git:github.com/paxtonhare/pi-supabase
```

For local development:

```bash
pi install /absolute/path/to/pi-supabase
```

Then restart Pi or run `/reload`.

## Connect

```text
/supabase connect
```

Pi opens Supabase's OAuth page in your browser. Tokens are stored at `~/.pi/agent/supabase-mcp-auth.json` with mode `0600` and refreshed by the official MCP SDK.

For SSH or headless sessions:

```text
/supabase manual
```

Open the saved authorization URL on another machine, approve access, and paste the failed localhost redirect URL back into Pi.

The management tools are always available:

- `supabase_mcp_connect`
- `supabase_mcp_status`
- `supabase_mcp_disconnect` — preserves OAuth credentials
- `supabase_mcp_logout` — deletes OAuth credentials

## Safe defaults

The extension defaults to:

- **Read-only mode**
- Automatic scoping to `.supabase/.temp/project-ref` when the current project is linked
- Confirmation before write-capable MCP tools when read-write mode is enabled
- Filtering write-only tools out of the model's tool list in read-only mode
- 50 KB / 2,000-line result truncation, with full output saved to a temporary file

Supabase explicitly recommends using MCP only with development or test projects. Do not connect it to production data unless you understand the prompt-injection and data-exposure risks.

## Configuration

Create `~/.pi/agent/supabase.json` for global settings or `.pi/supabase.json` in a trusted project:

```json
{
  "projectRef": "your-project-ref",
  "readOnly": true,
  "features": ["database", "debugging", "development", "docs"],
  "confirmWrites": true,
  "autoConnect": true
}
```

All fields:

| Field | Default | Purpose |
| --- | --- | --- |
| `url` | `https://mcp.supabase.com/mcp` | Hosted or local MCP endpoint |
| `projectRef` | linked project | Scope access to one Supabase project |
| `readOnly` | `true` | Force database queries into read-only mode |
| `features` | server defaults | Restrict MCP feature groups |
| `confirmWrites` | `true` | Confirm write-capable calls in read-write mode |
| `autoConnect` | `true` | Reconnect when saved credentials exist |
| `toolPrefix` | `supabase_` | Prefix for discovered MCP tools |
| `callbackPort` | `54324` | Local OAuth callback port |
| `requestTimeoutMs` | `120000` | MCP request timeout |
| `authFile` | `~/.pi/agent/supabase-mcp-auth.json` | OAuth storage path |

Environment variables override JSON configuration:

- `SUPABASE_MCP_URL`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_MCP_READ_ONLY`
- `SUPABASE_MCP_FEATURES` (comma-separated)
- `SUPABASE_MCP_CONFIRM_WRITES`
- `SUPABASE_MCP_AUTO_CONNECT`
- `SUPABASE_MCP_TOOL_PREFIX`
- `SUPABASE_MCP_CALLBACK_PORT`
- `SUPABASE_MCP_TIMEOUT_MS`
- `SUPABASE_MCP_AUTH_FILE`

For CI, set `SUPABASE_ACCESS_TOKEN`. It is sent as a bearer token and is never written by this extension.

For local Supabase CLI development:

```json
{
  "url": "http://localhost:54321/mcp",
  "readOnly": true
}
```

## Commands

```text
/supabase connect
/supabase manual
/supabase status
/supabase disconnect
/supabase logout
```

## Development

```bash
npm install
npm run check
npm run pack:check
```
