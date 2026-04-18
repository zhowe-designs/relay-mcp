import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrCreateThread, getThreadByName } from "./threads.js";

const surfaceEnum = z.enum(["chat", "cowork", "code", "other"]);

export const postMessageSchema = z.object({
  thread_name: z.string().min(1).max(200),
  content: z.string().min(1),
  surface: surfaceEnum,
  session_tag: z.string().max(200).optional(),
  metadata: z.record(z.unknown()).optional()
});

export async function postMessage(
  db: SupabaseClient,
  userId: string,
  params: z.infer<typeof postMessageSchema>
) {
  const thread = await getOrCreateThread(db, userId, params.thread_name);

  const { data, error } = await db
    .from("relay_messages")
    .insert({
      thread_id: thread.id,
      user_id: userId,
      surface: params.surface,
      session_tag: params.session_tag ?? null,
      content: params.content,
      metadata: params.metadata ?? null
    })
    .select("id, thread_id, created_at")
    .single();
  if (error) throw new Error(`post_message failed: ${error.message}`);

  // Bump last_message_at so list_threads can sort by recency.
  await db
    .from("relay_threads")
    .update({ last_message_at: data.created_at })
    .eq("id", thread.id);

  return data;
}

export const readThreadSchema = z.object({
  thread_name: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional().default(50),
  since: z.string().datetime().optional(),
  reader_tag: z.string().max(200).optional()
});

export async function readThread(
  db: SupabaseClient,
  userId: string,
  params: z.infer<typeof readThreadSchema>
) {
  const thread = await getThreadByName(db, userId, params.thread_name);
  if (!thread) throw new Error(`thread "${params.thread_name}" not found`);

  let query = db
    .from("relay_messages")
    .select("id, thread_id, surface, session_tag, content, metadata, created_at")
    .eq("thread_id", thread.id)
    .order("created_at", { ascending: false })
    .limit(params.limit);

  if (params.since) query = query.gt("created_at", params.since);

  const { data, error } = await query;
  if (error) throw new Error(`read_thread failed: ${error.message}`);

  if (params.reader_tag) {
    await upsertCursor(db, userId, thread.id, params.reader_tag, new Date().toISOString());
  }

  return data ?? [];
}

export const checkNewSchema = z.object({
  thread_name: z.string().min(1),
  reader_tag: z.string().min(1).max(200)
});

export async function checkNew(
  db: SupabaseClient,
  userId: string,
  params: z.infer<typeof checkNewSchema>
) {
  const thread = await getThreadByName(db, userId, params.thread_name);
  if (!thread) throw new Error(`thread "${params.thread_name}" not found`);

  const { data: cursor } = await db
    .from("relay_read_cursors")
    .select("last_read_at")
    .eq("thread_id", thread.id)
    .eq("reader_tag", params.reader_tag)
    .maybeSingle();

  const since = cursor?.last_read_at ?? "1970-01-01T00:00:00Z";

  const { data: messages, error } = await db
    .from("relay_messages")
    .select("id, thread_id, surface, session_tag, content, metadata, created_at")
    .eq("thread_id", thread.id)
    .gt("created_at", since)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`check_new failed: ${error.message}`);

  const messageList = messages ?? [];
  await upsertCursor(db, userId, thread.id, params.reader_tag, new Date().toISOString());

  return { new_message_count: messageList.length, messages: messageList };
}

async function upsertCursor(
  db: SupabaseClient,
  userId: string,
  threadId: string,
  readerTag: string,
  lastReadAt: string
) {
  const { error } = await db
    .from("relay_read_cursors")
    .upsert(
      {
        user_id: userId,
        thread_id: threadId,
        reader_tag: readerTag,
        last_read_at: lastReadAt,
        updated_at: new Date().toISOString()
      },
      { onConflict: "thread_id,reader_tag" }
    );
  if (error) throw new Error(`upsert_cursor failed: ${error.message}`);
}
