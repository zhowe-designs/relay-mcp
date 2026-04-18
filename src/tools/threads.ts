import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Thread } from "../types.js";

export const listThreadsSchema = z.object({
  include_archived: z.boolean().optional().default(false)
});

export async function listThreads(
  db: SupabaseClient,
  userId: string,
  params: z.infer<typeof listThreadsSchema>
) {
  let query = db
    .from("relay_threads")
    .select("id, name, description, last_message_at, archived")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false, nullsFirst: false });

  if (!params.include_archived) query = query.eq("archived", false);

  const { data: threads, error } = await query;
  if (error) throw new Error(`list_threads failed: ${error.message}`);

  const ids = (threads ?? []).map((t) => t.id);
  const counts = ids.length ? await countMessages(db, ids) : new Map<string, number>();

  return (threads ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    last_message_at: t.last_message_at,
    archived: t.archived,
    message_count: counts.get(t.id) ?? 0
  }));
}

async function countMessages(db: SupabaseClient, threadIds: string[]) {
  // One query per thread would be wasteful. Single round trip with group by.
  const { data, error } = await db
    .from("relay_messages")
    .select("thread_id")
    .in("thread_id", threadIds);
  if (error) throw new Error(`count_messages failed: ${error.message}`);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    counts.set(row.thread_id, (counts.get(row.thread_id) ?? 0) + 1);
  }
  return counts;
}

export const createThreadSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional()
});

export async function createThread(
  db: SupabaseClient,
  userId: string,
  params: z.infer<typeof createThreadSchema>
) {
  const { data, error } = await db
    .from("relay_threads")
    .insert({ user_id: userId, name: params.name, description: params.description ?? null })
    .select("id, name, created_at")
    .single();
  if (error) {
    // Unique violation surfaces as code 23505. Treat as user error, not 500.
    if (error.code === "23505") {
      throw new Error(`thread "${params.name}" already exists`);
    }
    throw new Error(`create_thread failed: ${error.message}`);
  }
  return data;
}

export const archiveThreadSchema = z.object({
  thread_name: z.string().min(1)
});

export async function archiveThread(
  db: SupabaseClient,
  userId: string,
  params: z.infer<typeof archiveThreadSchema>
) {
  const { data, error } = await db
    .from("relay_threads")
    .update({ archived: true })
    .eq("user_id", userId)
    .eq("name", params.thread_name)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`archive_thread failed: ${error.message}`);
  if (!data) throw new Error(`thread "${params.thread_name}" not found`);
  return { archived: true };
}

// Shared helper: find a thread by (user_id, name), or create it if missing.
// Used by post_message for convenience.
export async function getOrCreateThread(
  db: SupabaseClient,
  userId: string,
  name: string
): Promise<Thread> {
  const { data: existing, error: findErr } = await db
    .from("relay_threads")
    .select("*")
    .eq("user_id", userId)
    .eq("name", name)
    .maybeSingle();
  if (findErr) throw new Error(`find_thread failed: ${findErr.message}`);
  if (existing) return existing as Thread;

  const { data: created, error: createErr } = await db
    .from("relay_threads")
    .insert({ user_id: userId, name })
    .select("*")
    .single();
  if (createErr) {
    // Race: another request created it between our lookup and insert.
    if (createErr.code === "23505") {
      const { data: retry, error: retryErr } = await db
        .from("relay_threads")
        .select("*")
        .eq("user_id", userId)
        .eq("name", name)
        .single();
      if (retryErr) throw new Error(`get_or_create race retry failed: ${retryErr.message}`);
      return retry as Thread;
    }
    throw new Error(`create_thread failed: ${createErr.message}`);
  }
  return created as Thread;
}

export async function getThreadByName(
  db: SupabaseClient,
  userId: string,
  name: string
): Promise<Thread | null> {
  const { data, error } = await db
    .from("relay_threads")
    .select("*")
    .eq("user_id", userId)
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(`get_thread failed: ${error.message}`);
  return (data as Thread | null) ?? null;
}
