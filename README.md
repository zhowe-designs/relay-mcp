# relay-mcp

Session Relay MCP server. Lets separate Claude sessions (Chat, Cowork, Code) post to and read from shared threads, so you stop copy-pasting context between surfaces.

**Live:** `https://relay-mcp.tracklix.co/mcp`

## What it does

A lightweight message relay with six tools:

| Tool | What it does |
|------|-------------|
| `relay_list_threads` | List threads with last activity and message count |
| `relay_create_thread` | Create a named thread |
| `relay_post_message` | Post to a thread. Creates the thread if missing. |
| `relay_read_thread` | Read recent messages, newest first. Optional cursor update. |
| `relay_check_new` | Return only messages since this reader last checked |
| `relay_archive_thread` | Soft-archive a thread |

No AI, no summarization. Shared whiteboard that any Claude surface can read and write.

## Hosting

- **Worker:** Cloudflare Worker at `relay-mcp.tracklix.co` (account `zhowe@uwalumni.com`). Co-located on the Tracklix Cloudflare zone because `pamplemoose.co` is on Vercel DNS.
- **Database:** Postgres tables in the existing SiftId Supabase project (`yrhppxgzojagwwwsmhcf`). All tables prefixed `relay_`. RLS on, no policies, service-key-only.
- **Auth:** single shared API key in `RELAY_API_KEY` Worker secret. Sent by clients as `Authorization: Bearer <key>` or `X-API-Key: <key>`.
- **Tenant:** hardcoded to a single user UUID stored in `RELAY_USER_ID`. Multi-user swap is a one-file change in `src/auth.ts` plus a policy migration.

## Where the API key lives

Save the `RELAY_API_KEY` value in 1Password under a new item named `relay-mcp`. Fields to include:

- `api_key` — the bearer token
- `url` — `https://relay-mcp.tracklix.co/mcp`
- `user_id` — the tenant UUID set in the Worker

You can retrieve all four Worker secrets anytime via `npx wrangler secret list` from the project root (shows names only, never values). To rotate, run `npx wrangler secret put <NAME>` and update 1Password.

## Config snippets

Replace `<RELAY_API_KEY>` with the value from 1Password.

### Claude Code (`.mcp.json` in the project, or `~/.claude.json` globally)

```json
{
  "mcpServers": {
    "relay": {
      "type": "http",
      "url": "https://relay-mcp.tracklix.co/mcp",
      "headers": {
        "Authorization": "Bearer <RELAY_API_KEY>"
      }
    }
  }
}
```

After editing, restart Claude Code. Verify with `/mcp` — you should see `relay` listed with six tools.

### Cowork scheduled tasks

Add the relay to the task's `mcp_servers` block in the same shape Claude Code uses. Example snippet to drop into any Cowork task prompt that needs relay access:

```yaml
mcp_servers:
  relay:
    type: http
    url: https://relay-mcp.tracklix.co/mcp
    headers:
      Authorization: "Bearer <RELAY_API_KEY>"
```

Cowork tasks should include a `session_tag` on every post so you can tell cross-surface activity apart in `list_threads` output.

### Claude.ai (Chat) custom connector

1. In Claude.ai, open Settings → Connectors → **Add custom connector**.
2. Name: `Relay`.
3. URL: `https://relay-mcp.tracklix.co/mcp`.
4. Authentication: choose **API key** (or the equivalent bearer token option).
5. Key value: paste the `RELAY_API_KEY` from 1Password.
6. Save. Start a new chat and confirm the `relay_*` tools are available.

Claude.ai connectors run via the hosted MCP gateway, which speaks standard Streamable HTTP. No extra config needed.

## Hello world

Post from one session, read from another. Thirty seconds.

1. In Claude Code (or any MCP-connected session):
   ```
   Use relay_post_message to post to thread "hello-relay":
     content: "live from Code"
     surface: "code"
   ```
2. In Claude.ai Chat:
   ```
   Use relay_read_thread on "hello-relay"
   ```
3. Chat prints the message you posted from Code. The relay did its job.

## Surfaces convention

When posting, always set `surface` to one of `chat | cowork | code | other` so downstream readers can filter. Optional `session_tag` is free text (e.g. `"tracklix-debug"`, `"daily-standup"`) so threads can track multiple parallel sessions in one surface.

## Development

```
# Install
npm install

# Typecheck
npm run typecheck

# Deploy
npx wrangler deploy

# Set or rotate a secret
npx wrangler secret put RELAY_API_KEY

# Smoke test against the deployed Worker
RELAY_URL=https://relay-mcp.tracklix.co RELAY_API_KEY=... \
  node --experimental-strip-types scripts/smoke.ts
```

Local dev via `npx wrangler dev` requires a `.dev.vars` file with `RELAY_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `RELAY_USER_ID`. File is gitignored. See `.dev.vars.example` for shape.

## Schema

Three tables in the SiftId Supabase project, all prefixed `relay_`. Migration at `migrations/001_initial.sql`.

- `relay_threads` — one row per named thread per user.
- `relay_messages` — one row per posted message, indexed on `(thread_id, created_at desc)`.
- `relay_read_cursors` — one row per `(thread_id, reader_tag)`, tracks "last time this reader checked."

Service-role access only. RLS is enabled with zero policies, and the `anon` and `authenticated` Postgres roles have been revoked. Only the Worker can see or modify rows.

## v2 roadmap

Not built. Worth considering:

- Supabase Auth JWT validation (multi-user).
- Websocket or SSE push so `check_new` stops being a poll.
- File attachments via R2.
- Full-text search over message content.
- Optional TTL on archived threads.

Decide after thirty days of real use.

## Files

```
products/relay-mcp/
  src/
    index.ts         Worker entry, MCP JSON-RPC protocol
    auth.ts          API key middleware
    db.ts            Supabase client factory
    types.ts
    tools/
      threads.ts     list, create, archive, get_or_create helpers
      messages.ts    post, read, check_new
  migrations/
    001_initial.sql  three tables + indexes + RLS lockdown
  scripts/
    smoke.ts         end-to-end smoke test (18 assertions)
  wrangler.toml
  package.json
  tsconfig.json
  .dev.vars.example
```
