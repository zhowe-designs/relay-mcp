// End-to-end smoke test for relay-mcp.
// Usage:
//   RELAY_URL=http://127.0.0.1:8787 RELAY_API_KEY=... node --experimental-strip-types scripts/smoke.ts
//
// Exits with code 1 on any assertion failure so CI or a manual run sees red.

const RELAY_URL = process.env.RELAY_URL ?? "http://127.0.0.1:8787";
const RELAY_API_KEY = process.env.RELAY_API_KEY ?? "";
const ENDPOINT = RELAY_URL.replace(/\/$/, "") + "/mcp";

if (!RELAY_API_KEY) {
  console.error("RELAY_API_KEY not set. Export it before running smoke test.");
  process.exit(2);
}

let id = 0;
let failures = 0;

async function rpc(method: string, params?: Record<string, unknown>, opts?: { noAuth?: boolean }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts?.noAuth) headers["authorization"] = `Bearer ${RELAY_API_KEY}`;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as { result?: unknown; error?: unknown } };
}

function assert(label: string, cond: unknown) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures++;
  }
}

function toolContent(body: { result?: unknown }): unknown {
  const result = body.result as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const threadName = `smoke-${Date.now()}`;
  const readerTag = `smoke-reader-${Date.now()}`;

  console.log(`smoke test against ${ENDPOINT}`);

  // 1. initialize
  {
    const { status, body } = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.1" }
    });
    assert("initialize returns 200", status === 200);
    const info = (body.result as { serverInfo?: { name?: string } })?.serverInfo;
    assert("initialize names relay-mcp", info?.name === "relay-mcp");
  }

  // 2. unauthorized request is rejected
  {
    const { status } = await rpc("tools/list", undefined, { noAuth: true });
    assert("missing auth returns 401", status === 401);
  }

  // 3. tools/list returns 6 tools
  {
    const { body } = await rpc("tools/list");
    const tools = (body.result as { tools?: Array<{ name: string }> })?.tools ?? [];
    assert("tools/list returns 6 tools", tools.length === 6);
    const names = tools.map((t) => t.name).sort();
    const expected = [
      "relay_archive_thread",
      "relay_check_new",
      "relay_create_thread",
      "relay_list_threads",
      "relay_post_message",
      "relay_read_thread"
    ];
    assert("tool names match spec", JSON.stringify(names) === JSON.stringify(expected));
  }

  // 4. create thread
  {
    const { body } = await rpc("tools/call", {
      name: "relay_create_thread",
      arguments: { name: threadName, description: "smoke test" }
    });
    const data = toolContent(body) as { id?: string; name?: string };
    assert("create_thread returns id", typeof data?.id === "string");
    assert("create_thread echoes name", data?.name === threadName);
  }

  // 5. post message
  {
    const { body } = await rpc("tools/call", {
      name: "relay_post_message",
      arguments: {
        thread_name: threadName,
        content: "hello from smoke test",
        surface: "code",
        session_tag: "smoke"
      }
    });
    const data = toolContent(body) as { id?: string };
    assert("post_message returns id", typeof data?.id === "string");
  }

  // 6. read thread
  {
    const { body } = await rpc("tools/call", {
      name: "relay_read_thread",
      arguments: { thread_name: threadName, reader_tag: readerTag }
    });
    const data = toolContent(body) as Array<{ content: string; surface: string }>;
    assert("read_thread returns array", Array.isArray(data));
    assert("read_thread has one message", data.length === 1);
    assert("message content matches", data[0]?.content === "hello from smoke test");
    assert("message surface is code", data[0]?.surface === "code");
  }

  // 7. check_new right after read advances cursor to zero
  {
    const { body } = await rpc("tools/call", {
      name: "relay_check_new",
      arguments: { thread_name: threadName, reader_tag: readerTag }
    });
    const data = toolContent(body) as { new_message_count: number };
    assert("check_new after read reports 0 new", data?.new_message_count === 0);
  }

  // 8. post a second message, then check_new should report 1
  {
    await rpc("tools/call", {
      name: "relay_post_message",
      arguments: {
        thread_name: threadName,
        content: "second message",
        surface: "chat"
      }
    });
    const { body } = await rpc("tools/call", {
      name: "relay_check_new",
      arguments: { thread_name: threadName, reader_tag: readerTag }
    });
    const data = toolContent(body) as { new_message_count: number };
    assert("check_new after new post reports 1", data?.new_message_count === 1);
  }

  // 9. list threads includes ours
  {
    const { body } = await rpc("tools/call", {
      name: "relay_list_threads",
      arguments: {}
    });
    const threads = toolContent(body) as Array<{ name: string; message_count: number }>;
    const found = threads.find((t) => t.name === threadName);
    assert("list_threads finds our thread", !!found);
    assert("list_threads reports 2 messages", found?.message_count === 2);
  }

  // 10. archive thread
  {
    const { body } = await rpc("tools/call", {
      name: "relay_archive_thread",
      arguments: { thread_name: threadName }
    });
    const data = toolContent(body) as { archived?: boolean };
    assert("archive_thread returns archived true", data?.archived === true);
  }

  // 11. list_threads default should not include archived
  {
    const { body } = await rpc("tools/call", {
      name: "relay_list_threads",
      arguments: {}
    });
    const threads = toolContent(body) as Array<{ name: string }>;
    const found = threads.find((t) => t.name === threadName);
    assert("archived thread hidden from default list", !found);
  }

  // 12. OAuth discovery endpoints
  {
    const asRes = await fetch(RELAY_URL + "/.well-known/oauth-authorization-server");
    const asMeta = (await asRes.json()) as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string };
    assert("authorization-server metadata 200", asRes.status === 200);
    assert("metadata has issuer", !!asMeta.issuer);
    assert("metadata has authorize endpoint", !!asMeta.authorization_endpoint);
    assert("metadata has token endpoint", !!asMeta.token_endpoint);

    const prRes = await fetch(RELAY_URL + "/.well-known/oauth-protected-resource");
    const prMeta = (await prRes.json()) as { resource?: string; authorization_servers?: string[] };
    assert("protected-resource metadata 200", prRes.status === 200);
    assert("metadata names authorization server", (prMeta.authorization_servers ?? []).length > 0);
  }

  // 13. Unauthorized /mcp returns WWW-Authenticate with resource_metadata
  {
    const res = await fetch(RELAY_URL + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert("unauth /mcp is 401", res.status === 401);
    const www = res.headers.get("www-authenticate") ?? "";
    assert("WWW-Authenticate names resource_metadata", www.includes("resource_metadata"));
  }

  // 14. DCR: /register returns a client_id
  let clientId = "";
  {
    const res = await fetch(RELAY_URL + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/callback"], client_name: "smoke-test" })
    });
    const data = (await res.json()) as { client_id?: string };
    assert("register returns 200", res.status === 200);
    assert("register issues client_id", !!data.client_id);
    clientId = data.client_id ?? "";
  }

  // 15. Full OAuth happy path: authorize -> token -> /mcp with access token
  {
    const codeVerifier = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
    const codeChallenge = btoa(String.fromCharCode(...challengeBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const redirectUri = "https://claude.ai/api/mcp/callback";

    const authorizeRes = await fetch(
      `${RELAY_URL}/authorize?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state: "smoke-state",
          scope: "mcp"
        }).toString()
    );
    assert("authorize GET returns 200 HTML", authorizeRes.status === 200);
    const html = await authorizeRes.text();
    assert("authorize page contains form", html.includes("<form") && html.includes("api_key"));

    const postForm = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state: "smoke-state",
      scope: "mcp",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      api_key: RELAY_API_KEY
    });
    const submitRes = await fetch(RELAY_URL + "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: postForm.toString(),
      redirect: "manual"
    });
    assert("authorize POST redirects", submitRes.status === 302);
    const location = submitRes.headers.get("location") ?? "";
    const locUrl = new URL(location);
    const code = locUrl.searchParams.get("code") ?? "";
    const returnedState = locUrl.searchParams.get("state") ?? "";
    assert("redirect carries auth code", !!code);
    assert("redirect echoes state", returnedState === "smoke-state");

    const tokenRes = await fetch(RELAY_URL + "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: clientId
      }).toString()
    });
    const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string; token_type?: string };
    assert("token exchange returns 200", tokenRes.status === 200);
    assert("access_token issued", !!tokens.access_token);
    assert("refresh_token issued", !!tokens.refresh_token);
    assert("token_type is Bearer", tokens.token_type === "Bearer");

    const mcpRes = await fetch(RELAY_URL + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokens.access_token}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list" })
    });
    const mcpBody = (await mcpRes.json()) as { result?: { tools?: unknown[] } };
    assert("OAuth access token works on /mcp", (mcpBody.result?.tools ?? []).length === 6);

    const refreshRes = await fetch(RELAY_URL + "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        client_id: clientId
      }).toString()
    });
    const refreshed = (await refreshRes.json()) as { access_token?: string };
    assert("refresh_token grant returns 200", refreshRes.status === 200);
    assert("refresh issues new access_token", !!refreshed.access_token);

    const badPkceRes = await fetch(RELAY_URL + "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier-value-that-does-not-match",
        redirect_uri: redirectUri,
        client_id: clientId
      }).toString()
    });
    assert("wrong PKCE verifier is rejected", badPkceRes.status === 400);
  }

  console.log("");
  if (failures > 0) {
    console.log(`FAILED ${failures} assertion${failures === 1 ? "" : "s"}`);
    process.exit(1);
  } else {
    console.log("smoke test passed");
  }
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
