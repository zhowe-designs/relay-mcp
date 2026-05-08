# relay-mcp

A self-hosted **session relay** for Claude. When you work across multiple Claude surfaces (Code, Cowork, Claude.ai connectors), each surface lives in its own context window. The relay gives them a shared message thread they can all post to and read from, so a Code session can hand state to a Chat session without copy-paste, and a scheduled Cowork task can leave a note your morning Chat picks up. It is a lightweight whiteboard, not a log or a memory store.

## Tools

The server exposes six MCP tools.

| Tool | Description |
|------|-------------|
| `relay_list_threads` | List threads with last activity and message count. |
| `relay_create_thread` | Create a named thread. |
| `relay_post_message` | Post a message to a thread. Auto-creates the thread if missing. |
| `relay_read_thread` | Read recent messages, newest first. Optional cursor update. |
| `relay_check_new` | Return only messages since this reader last checked. |
| `relay_archive_thread` | Soft-archive a thread. History is preserved. |

Every message carries a `surface` field (`chat`, `cowork`, `code`, `other`) and an optional free-text `session_tag` so threads stay legible across many parallel sessions.

## Architecture

- **Cloudflare Worker** at `src/index.ts`. Stateless. Speaks streamable HTTP MCP at `/mcp`.
- **Supabase Postgres** for thread, message, and read-cursor storage. Three tables, all prefixed `relay_`. RLS enabled with zero policies; only the Worker's service-role key can read or write.
- **Two auth paths on the same server:**
  - **Static Bearer** for Claude Code and Cowork: `Authorization: Bearer <RELAY_API_KEY>`. Simplest possible. No browser flow.
  - **OAuth 2.1** with Dynamic Client Registration for Claude.ai custom connectors. The Worker exposes `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, and `/token`. Access tokens are HS256 JWTs signed with `RELAY_API_KEY`. Stateless, no KV or Durable Objects required. Access tokens last 90 days, refresh tokens 365.
- **Single tenant** in v1. The Worker reads a hardcoded user UUID from the `RELAY_USER_ID` secret. Multi-user support is a one-file change in `src/oauth.ts` plus an RLS policy migration; the schema already carries `user_id` columns.

## Deploy your own

Self-hosting takes about ten minutes. You will need a Cloudflare account (Workers free tier is fine), a Supabase project, and Node 20+ locally.

### 1. Clone and install

```bash
git clone https://github.com/zhowe-designs/relay-mcp.git
cd relay-mcp
npm install
```

### 2. Create a Supabase project and run the migration

Create a new project at [supabase.com](https://supabase.com). In the SQL editor, paste and run `migrations/001_initial.sql`. This creates `relay_threads`, `relay_messages`, `relay_read_cursors`, sets up indexes, enables RLS with zero policies, and revokes anon and authenticated grants.

From **Project Settings → API**, copy:

- The **Project URL** (looks like `https://abcdef.supabase.co`).
- The **service_role** key. Treat this like a database password.

### 3. Pick a tenant UUID

Generate one (`uuidgen`, `crypto.randomUUID()`, or any UUID v4 generator). This is the single user the v1 server is bound to. You can rotate it later, but everything posted under one UUID is invisible under another.

### 4. Set Worker secrets

```bash
npx wrangler login
npx wrangler secret put RELAY_API_KEY        # any random 32+ char string, your bearer
npx wrangler secret put SUPABASE_URL          # https://<project-ref>.supabase.co
npx wrangler secret put SUPABASE_SERVICE_KEY  # service_role key from step 2
npx wrangler secret put RELAY_USER_ID         # UUID from step 3
```

### 5. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the deployed URL, something like `https://relay-mcp.<your-subdomain>.workers.dev`. That URL plus `/mcp` is the MCP endpoint.

### 6. Optional: custom domain

Edit `wrangler.toml` and uncomment the `routes` block, swapping `relay-mcp.example.com` for a hostname on a Cloudflare zone you own. Re-run `npx wrangler deploy`. Wrangler creates the CNAME automatically.

### 7. Smoke test

```bash
RELAY_URL=https://relay-mcp.<your-subdomain>.workers.dev RELAY_API_KEY=<your-key> \
  node --experimental-strip-types scripts/smoke.ts
```

Forty assertions, including the OAuth flow. All green means you are live.

## Configure your clients

Replace `<RELAY_URL>` with your deployed URL and `<RELAY_API_KEY>` with the secret you set above.

### Claude Code

Add to `.mcp.json` in the project root, or to `~/.claude.json` for global access.

```json
{
  "mcpServers": {
    "relay": {
      "type": "http",
      "url": "<RELAY_URL>/mcp",
      "headers": {
        "Authorization": "Bearer <RELAY_API_KEY>"
      }
    }
  }
}
```

Restart Claude Code, run `/mcp`, and confirm `relay` appears with six tools.

### Cowork scheduled tasks

Add an `mcp_servers` block to any task prompt that needs relay access.

```yaml
mcp_servers:
  relay:
    type: http
    url: <RELAY_URL>/mcp
    headers:
      Authorization: "Bearer <RELAY_API_KEY>"
```

### Claude.ai custom connector

Claude.ai uses OAuth 2.1 with Dynamic Client Registration, which the relay supports.

1. In Claude.ai, open **Settings → Connectors → Add custom connector**.
2. Name: anything, e.g. `Relay`.
3. Remote MCP server URL: `<RELAY_URL>/mcp`.
4. Leave the Advanced OAuth fields blank. Claude.ai handles registration automatically.
5. Click Add. A browser tab opens to your Worker's `/authorize` page.
6. Paste your `RELAY_API_KEY` into the single input and click Authorize.
7. The browser redirects back to Claude.ai. The connector lists six tools.

Access tokens last 90 days with automatic refresh, so you should rarely re-authorize. If auth ever fails, remove the connector and re-add.

## Usage

Once connected, you describe intent. The model picks the right tool. Some examples of sentences that work:

- "Post the last error, the migration diff, and my theory to relay thread `migration-debug`, surface code."
- "Read `daily-standup`, show me everything Cowork posted this morning."
- "Pull the last ten messages from `migration-debug`."

### Thread naming

Short, dash-separated, topic-scoped. `migration-debug`, not `april_migration_issues_2026`. One thread per topic, not one per day. Threads accumulate; conversations continue across weeks. A thread auto-creates the first time anything posts to it, so there is no ceremony around starting one.

Good: `migration-debug`, `daily-standup`, `pricing-notes`, `scratch`.

Bad: `april-18-bugs`, `thread-1`, `general`.

### Surface tagging is not optional

Always set `surface` to `chat`, `cowork`, `code`, or `other`. Six months from now when you scroll a thread, knowing a message came from a scheduled Cowork task versus a live Chat conversation changes how you weight it. Use `session_tag` for free-text grouping inside a surface (e.g. one tag per debugging session).

### Archive dead threads

When a topic is done, call `relay_archive_thread`. Archived threads hide from the default `list_threads` output but stay queryable via `include_archived`. Think Slack channels, not Git branches. Archive preserves history; it does not delete.

### The boundary rule: transient layer, not canonical state

The relay is a conversation layer between sessions. It is not a log, not a decision record, and not a memory store. Anything you will care about next week belongs in your real system of record (decision log, task tracker, docs, code comments, etc.). The relay is what was said in the moment, not what was decided. If a relay post captures a real decision, write it down somewhere durable before moving on.

### Never relay secrets

Same rule as any chat. API keys, service-role tokens, OAuth secrets, database credentials. Those go in Wrangler secrets or your password manager. They never go in a relay message. The relay database is not a vault.

## Development

```bash
# Typecheck
npm run typecheck

# Local dev (requires .dev.vars, see .dev.vars.example)
npx wrangler dev

# Smoke test
RELAY_URL=<your-url> RELAY_API_KEY=<your-key> npm run smoke:remote

# Rotate a secret
npx wrangler secret put RELAY_API_KEY
```

## Schema

Three tables, all prefixed `relay_`. Migration at `migrations/001_initial.sql`.

- `relay_threads`. One row per named thread per user.
- `relay_messages`. One row per posted message. Indexed on `(thread_id, created_at desc)`.
- `relay_read_cursors`. One row per `(thread_id, reader_tag)`. Tracks "last time this reader checked."

Service-role access only. RLS is enabled with zero policies, and `anon` and `authenticated` are revoked. Only the Worker's service-role key can read or write.

## Layout

```
src/
  index.ts         Worker entry, MCP JSON-RPC protocol, routes
  oauth.ts         OAuth 2.1 facade (metadata, register, authorize, token)
  jwt.ts           HS256 JWT sign, verify, PKCE check
  db.ts            Supabase client factory
  types.ts
  tools/
    threads.ts     list, create, archive, get_or_create
    messages.ts    post, read, check_new
migrations/
  001_initial.sql  three tables + indexes + RLS lockdown
scripts/
  smoke.ts         end-to-end smoke test, includes OAuth
wrangler.toml
package.json
server.json        MCP Registry metadata
```

## Contributing

This is not an actively maintained community project. PRs are welcome for bugfixes, documentation improvements, and obvious quality-of-life additions. Larger features or refactors will likely be declined to keep the surface area small. Open an issue first if you want to discuss something nontrivial.

## License

MIT. See [LICENSE](LICENSE).
