export interface Env {
  RELAY_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  RELAY_USER_ID: string;
}

export type Surface = "chat" | "cowork" | "code" | "other";

export interface Thread {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: string;
  last_message_at: string | null;
  archived: boolean;
}

export interface Message {
  id: string;
  thread_id: string;
  user_id: string;
  surface: Surface;
  session_tag: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ReadCursor {
  id: string;
  thread_id: string;
  user_id: string;
  reader_tag: string;
  last_read_at: string;
  updated_at: string;
}
