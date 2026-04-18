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
- **Auth:** two paths on the same server.
  - **Static Bearer** for Code and Cowork: `Authorization: Bearer <RELAY_API_KEY>`. Simple, no browser flow.
  - **OAuth 2.1** for Claude.ai's custom connector: the Worker exposes `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, and `/token`. Access tokens are HS256 JWTs signed with `RELAY_API_KEY`. Stateless, no KV or DO. Access tokens last 90 days, refresh tokens 365.
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

The relay speaks OAuth 2.1 with Dynamic Client Registration, so Claude.ai discovers and handles auth automatically.

1. In Claude.ai, open Settings → Connectors → **Add custom connector**.
2. Name: `Relay`.
3. Remote MCP server URL: `https://relay-mcp.tracklix.co/mcp`.
4. Leave the **Advanced settings** OAuth fields blank. Claude.ai does Dynamic Client Registration on its own.
5. Click Add. Claude.ai opens a browser tab to `relay-mcp.tracklix.co/authorize`.
6. Paste your `RELAY_API_KEY` from 1Password into the single input, click Authorize.
7. Browser redirects back to Claude.ai. Connector shows six tools.

Access tokens last 90 days with automatic refresh via the 365-day refresh token, so you should rarely need to re-authorize. If the connector ever fails auth, remove it and re-add.

## Usage Guide

The relay is the shared whiteboard between your Claude surfaces. It is not the log. How to use it day to day.

### How to post and read from each surface

These are the kinds of sentences you will actually say. You do not need to know tool names or argument shapes. Describe intent, the model picks the right relay tool.

**Claude Code.** "Post the last error, the migration diff, and my current theory to relay thread tracklix-debug, surface code, session tag migration-apr18." Later, in a different session: "Pull the last ten messages from tracklix-debug."

**Cowork.** Scheduled tasks post with `surface: cowork` and usually a `session_tag` matching the task name. Example inside a task prompt: "After you finish the morning action list, post a one-paragraph summary to relay thread daily-standup, surface cowork, session tag morning-action-list." Chat reads that thread later with zero copy-paste.

**Claude.ai Chat.** "Post my last decision to thread siftid-scoring, surface chat. Calibration note: fewer than ten percent of ideas score above 8. Want to hold the line." Or on the read side: "Read daily-standup, show me everything Cowork posted this morning."

### Thread naming

Short, dash-separated, topic-scoped. `tracklix-debug`, not `tracklix_issues_april_2026`. One thread per topic, not one per day. Threads accumulate, conversations continue across weeks. A thread auto-creates the first time anything gets posted to it, so there is no ceremony around starting one.

Good: `tracklix-debug`, `daily-standup`, `siftid-scoring`, `scratch`, `monster-poker-notes`.

Bad: `april-18-tracklix-bugs`, `thread-1`, `general`.

### Surface tagging is not optional

Every message carries a `surface` of `chat`, `cowork`, `code`, or `other`. Do not skip it. Six months from now when you scroll a thread, knowing a message came from Cowork's morning task versus a live Chat argument changes how you weight it. Surface tagging is the cheapest metadata available and the one you will miss most if you drop it. Optional `session_tag` is free text and helps split multiple parallel sessions inside one surface.

### Archive dead threads

When a topic is done, run `relay_archive_thread`. Archived threads hide from the default `list_threads` output but stay queryable via `include_archived`. Think Slack channels, not Git branches. Archive preserves history, it does not delete. If `list_threads` starts feeling noisy, that is the signal to archive.

### Topical separation is the whole point

Do not dump everything into one thread. The relay's value is that Chat can pull `tracklix-debug` without wading through Monster Poker context. If you catch yourself debating whether a new message belongs in this thread or a different one, that is a signal to create a new thread. Cheap to make, cheap to archive.

### The relay is not the log

Canonical records still live in the Decision Log, Done/Didn't/Pushed, and status.md. The relay is the conversation layer between sessions, nothing more. Relay messages are transient-ish, they are handoffs in motion. Logs are permanent, they are the week-over-week record.

If a relay thread ever surfaces a decision you will want to act on in two weeks, stop and log it to DDDP before moving on. Otherwise you will rediscover it by accident and regret it.

### Never relay secrets

Same rule as any chat. Service role keys, API tokens, database credentials, OAuth secrets, those go in Wrangler secrets, 1Password, or the Supabase dashboard. They never go in a relay message. The relay database is not a vault. Treat it like a shared Slack channel.

### Three scenarios you will hit in the first week

**Debugging in Code, want to continue in Chat.**

You are in a Code session on Tracklix, stuck on a Prisma migration for twenty minutes. You want Chat's fresh eyes without retyping context.

In Code: "Post the last error, the migration diff, and my current theory to relay thread tracklix-debug, surface code, session tag migration-apr18."

Then in Chat: "Read tracklix-debug, last five messages, tell me what I am missing."

Chat gets the full state, no copy-paste.

**Cowork posts a morning action list, Chat reads it at 9 AM.**

A Cowork scheduled task runs at 6 AM. It builds the action list and posts a summary to relay thread daily-standup, surface cowork.

You open Chat three hours later: "What did Cowork put in daily-standup this morning?"

Chat pulls it, summarizes, and you are working off a fresh picture in ten seconds. No Notion tab switching.

**Random strategic thought at night, captured for morning review.**

It is 11 PM, you are in Chat, you have a thought about SiftId pricing you do not want to lose and also do not want to act on now.

"Post to thread scratch, surface chat, session tag late-night: SiftId Pro at four ninety nine may be signaling too cheap to the real market. Consider seven ninety nine test for two weeks, hold current pricing on existing users."

Next morning: "Read scratch, last 24 hours."

Your morning brain gets your night brain's note without having to remember it existed.

### The one habit that makes it click

After a meaningful relay post, also log it to status.md or the appropriate log. The relay is the in-the-moment handoff. Logs are the week-over-week record. Use both or lose visibility.

Not every relay post needs a log entry. Debugging chatter does not. But any decision, shift in direction, or piece of state the relay carries that you will care about next week, yes, log it too. Two minutes of redundancy prevents two hours of confusion later.

### First-week test drive

Do not rewire your workflow yet. Start with two threads:

- `daily-standup` for morning Cowork posts and your Chat morning review
- `scratch` for anything that does not fit anywhere else

Use those two for seven days. If they prove useful, add more threads for real work (tracklix-debug, siftid-ideas, monster-poker-notes). If they do not earn a spot in your daily rotation after a week, the relay is not for you. That is also useful information. Decide the future of the tool after the first week of real use, not before.

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
    index.ts         Worker entry, MCP JSON-RPC protocol, routes
    oauth.ts         OAuth 2.1 facade (metadata, register, authorize, token)
    jwt.ts           HS256 JWT sign, verify, and PKCE check
    db.ts            Supabase client factory
    types.ts
    tools/
      threads.ts     list, create, archive, get_or_create helpers
      messages.ts    post, read, check_new
  migrations/
    001_initial.sql  three tables + indexes + RLS lockdown
  scripts/
    smoke.ts         end-to-end smoke test (40 assertions, includes OAuth)
  wrangler.toml
  package.json
  tsconfig.json
  .dev.vars.example
```
