-- relay-mcp initial schema
-- Co-hosted in the SiftId Supabase project. All tables prefixed relay_ so the
-- namespace is obviously distinct from SiftId's own schema.
--
-- v1 posture: RLS is enabled with zero policies. Only the service_role key
-- (held by the Worker) can read or write. anon and authenticated are blocked.
-- When multi-user ships, swap in Supabase Auth JWT validation and add proper
-- per-user policies. The user_id columns are preserved now to keep that path
-- a single-file change on the server plus a policy migration on the DB.

-- Threads
create table if not exists public.relay_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  archived boolean not null default false,
  constraint relay_threads_user_name_unique unique (user_id, name)
);

create index if not exists relay_threads_user_last_message_idx
  on public.relay_threads (user_id, last_message_at desc nulls last)
  where archived = false;

-- Messages
create table if not exists public.relay_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.relay_threads(id) on delete cascade,
  user_id uuid not null,
  surface text not null,
  session_tag text,
  content text not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint relay_messages_surface_check
    check (surface in ('chat', 'cowork', 'code', 'other'))
);

create index if not exists relay_messages_thread_created_idx
  on public.relay_messages (thread_id, created_at desc);

-- Read cursors
create table if not exists public.relay_read_cursors (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.relay_threads(id) on delete cascade,
  user_id uuid not null,
  reader_tag text not null,
  last_read_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint relay_read_cursors_thread_reader_unique unique (thread_id, reader_tag)
);

-- Lock the tables down. RLS on + zero policies = service_role only.
alter table public.relay_threads enable row level security;
alter table public.relay_messages enable row level security;
alter table public.relay_read_cursors enable row level security;

-- Revoke any default grants from anon and authenticated so even a rogue
-- client-side Supabase call cannot touch these rows.
revoke all on public.relay_threads from anon, authenticated;
revoke all on public.relay_messages from anon, authenticated;
revoke all on public.relay_read_cursors from anon, authenticated;
