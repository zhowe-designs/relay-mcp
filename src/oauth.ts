// OAuth 2.1 authorization server facade for the relay MCP.
// Scope: single-user, stateless. Tokens are HS256 JWTs signed with RELAY_API_KEY.
// No KV, no Durable Objects. Legacy static Bearer auth remains valid on /mcp.

import type { Env } from "./types.js";
import { signJwt, verifyJwt, verifyPkce, type JwtPayload } from "./jwt.js";

const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 90; // 90 days
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 365; // 365 days
const AUTH_CODE_TTL = 60 * 5; // 5 minutes

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function originFrom(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    }
  });
}

export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "86400"
    }
  });
}

// ---------- Discovery metadata ----------

export function authorizationServerMetadata(request: Request): Response {
  const origin = originFrom(request);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"]
  });
}

export function protectedResourceMetadata(request: Request): Response {
  const origin = originFrom(request);
  return json({
    resource: origin,
    authorization_servers: [origin],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"]
  });
}

// ---------- Dynamic Client Registration (RFC 7591) ----------

interface DcrRequest {
  redirect_uris?: string[];
  client_name?: string;
  [key: string]: unknown;
}

export async function handleRegister(request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: DcrRequest = {};
  try {
    body = (await request.json()) as DcrRequest;
  } catch {
    return json({ error: "invalid_request", error_description: "body must be JSON" }, 400);
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  // Public client, PKCE only. No secret issued.
  const clientId = crypto.randomUUID();
  return json({
    client_id: clientId,
    client_id_issued_at: now(),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_name: body.client_name ?? "relay-mcp client"
  });
}

// ---------- Authorization endpoint ----------

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
}

function parseAuthorizeParams(url: URL): AuthorizeParams | null {
  const client_id = url.searchParams.get("client_id") ?? "";
  const redirect_uri = url.searchParams.get("redirect_uri") ?? "";
  const response_type = url.searchParams.get("response_type") ?? "";
  const code_challenge = url.searchParams.get("code_challenge") ?? "";
  const code_challenge_method = url.searchParams.get("code_challenge_method") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const scope = url.searchParams.get("scope") ?? "mcp";
  if (!client_id || !redirect_uri || response_type !== "code") return null;
  if (code_challenge_method !== "S256" || !code_challenge) return null;
  return { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state, scope };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAuthorizePage(p: AuthorizeParams, error?: string): Response {
  const err = error
    ? `<p style="color:#b00">${escapeHtml(error)}</p>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>relay-mcp sign in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 440px; margin: 60px auto; padding: 0 20px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #555; line-height: 1.5; }
  form { margin-top: 24px; }
  label { display: block; font-size: 14px; margin-bottom: 6px; color: #222; }
  input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 15px; box-sizing: border-box; }
  button { margin-top: 16px; width: 100%; padding: 12px; border: 0; border-radius: 6px; background: #111; color: #fff; font-size: 15px; cursor: pointer; }
  button:hover { background: #000; }
  .meta { font-size: 12px; color: #888; margin-top: 32px; }
</style>
</head>
<body>
<h1>Authorize relay-mcp</h1>
<p>Paste your relay API key from 1Password to authorize this client. The key stays on your device and never leaves this page as plaintext, just as an HMAC-signed token.</p>
${err}
<form method="post" action="/authorize">
  <input type="hidden" name="client_id" value="${escapeHtml(p.client_id)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirect_uri)}">
  <input type="hidden" name="state" value="${escapeHtml(p.state)}">
  <input type="hidden" name="scope" value="${escapeHtml(p.scope)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(p.code_challenge)}">
  <input type="hidden" name="code_challenge_method" value="${escapeHtml(p.code_challenge_method)}">
  <label for="api_key">Relay API key</label>
  <input id="api_key" name="api_key" type="password" autocomplete="off" autofocus required>
  <button type="submit">Authorize</button>
</form>
<p class="meta">Redirecting to: ${escapeHtml(p.redirect_uri)}</p>
</body>
</html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function handleAuthorizeGet(request: Request): Response {
  const url = new URL(request.url);
  const params = parseAuthorizeParams(url);
  if (!params) {
    return new Response("invalid authorize request", { status: 400 });
  }
  return renderAuthorizePage(params);
}

export async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const params: AuthorizeParams = {
    client_id: String(form.get("client_id") ?? ""),
    redirect_uri: String(form.get("redirect_uri") ?? ""),
    response_type: "code",
    code_challenge: String(form.get("code_challenge") ?? ""),
    code_challenge_method: String(form.get("code_challenge_method") ?? ""),
    state: String(form.get("state") ?? ""),
    scope: String(form.get("scope") ?? "mcp")
  };
  const apiKey = String(form.get("api_key") ?? "");

  if (!params.client_id || !params.redirect_uri || !params.code_challenge) {
    return new Response("invalid authorize request", { status: 400 });
  }

  if (!constantTimeEquals(apiKey, env.RELAY_API_KEY)) {
    return renderAuthorizePage(params, "API key did not match. Try again.");
  }

  // Issue an auth code JWT with PKCE challenge embedded.
  const code = await signJwt(
    {
      iss: originFrom(request),
      sub: env.RELAY_USER_ID,
      aud: params.client_id,
      exp: now() + AUTH_CODE_TTL,
      iat: now(),
      typ: "code",
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      scope: params.scope
    },
    env.RELAY_API_KEY
  );

  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return Response.redirect(redirect.toString(), 302);
}

// ---------- Token endpoint ----------

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const contentType = request.headers.get("content-type") ?? "";
  let params: URLSearchParams;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    params = new URLSearchParams(await request.text());
  } else if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, string>;
    params = new URLSearchParams(body as Record<string, string>);
  } else {
    params = new URLSearchParams(await request.text());
  }

  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const codeVerifier = params.get("code_verifier") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const clientId = params.get("client_id") ?? "";

    const codePayload = await verifyJwt(code, env.RELAY_API_KEY);
    if (!codePayload || codePayload.typ !== "code") {
      return json({ error: "invalid_grant", error_description: "bad or expired code" }, 400);
    }
    if (codePayload.redirect_uri !== redirectUri) {
      return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    if (codePayload.aud !== clientId) {
      return json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    }
    const challenge = codePayload.code_challenge as string;
    if (!(await verifyPkce(codeVerifier, challenge))) {
      return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }

    return json(await issueTokens(request, env, clientId, String(codePayload.sub ?? env.RELAY_USER_ID), String(codePayload.scope ?? "mcp")));
  }

  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token") ?? "";
    const clientId = params.get("client_id") ?? "";
    const refreshPayload = await verifyJwt(refreshToken, env.RELAY_API_KEY);
    if (!refreshPayload || refreshPayload.typ !== "refresh") {
      return json({ error: "invalid_grant", error_description: "bad or expired refresh token" }, 400);
    }
    if (refreshPayload.aud !== clientId) {
      return json({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    }
    return json(await issueTokens(request, env, clientId, String(refreshPayload.sub ?? env.RELAY_USER_ID), String(refreshPayload.scope ?? "mcp")));
  }

  return json({ error: "unsupported_grant_type" }, 400);
}

async function issueTokens(
  request: Request,
  env: Env,
  clientId: string,
  sub: string,
  scope: string
): Promise<Record<string, unknown>> {
  const iss = originFrom(request);
  const accessToken = await signJwt(
    {
      iss,
      sub,
      aud: clientId,
      exp: now() + ACCESS_TOKEN_TTL,
      iat: now(),
      typ: "access",
      scope
    },
    env.RELAY_API_KEY
  );
  const refreshToken = await signJwt(
    {
      iss,
      sub,
      aud: clientId,
      exp: now() + REFRESH_TOKEN_TTL,
      iat: now(),
      typ: "refresh",
      scope
    },
    env.RELAY_API_KEY
  );
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope
  };
}

// ---------- Bearer validation used by /mcp ----------

export async function validateBearer(
  request: Request,
  env: Env
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const auth = request.headers.get("authorization");
  if (!auth) return { ok: false };
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok: false };
  const token = match[1];

  // Legacy static key: accept as-is and act as the configured tenant.
  if (constantTimeEquals(token, env.RELAY_API_KEY)) {
    return { ok: true, userId: env.RELAY_USER_ID };
  }

  // OAuth-issued access token.
  const payload = await verifyJwt(token, env.RELAY_API_KEY);
  if (payload && payload.typ === "access") {
    return { ok: true, userId: String(payload.sub ?? env.RELAY_USER_ID) };
  }

  return { ok: false };
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
