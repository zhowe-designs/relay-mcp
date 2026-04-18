import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./types.js";

// One client per request is fine; the supabase-js client is lightweight.
// Service role key bypasses RLS. Never send this key to any client.
export function makeClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
