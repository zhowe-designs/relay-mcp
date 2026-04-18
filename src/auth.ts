import type { Env } from "./types.js";

// v1 auth: single shared API key. Accept it via Authorization: Bearer <key>
// or via X-API-Key header. Swap this file for Supabase Auth JWT validation
// when multi-user ships. The rest of the server does not care how auth works
// as long as this returns true before any DB call.
export function validateApiKey(request: Request, env: Env): boolean {
  if (!env.RELAY_API_KEY) return false;

  const auth = request.headers.get("authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && constantTimeEquals(match[1], env.RELAY_API_KEY)) return true;
  }

  const headerKey = request.headers.get("x-api-key");
  if (headerKey && constantTimeEquals(headerKey, env.RELAY_API_KEY)) return true;

  return false;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
