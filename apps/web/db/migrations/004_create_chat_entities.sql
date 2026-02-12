create table if not exists chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_threads_user_id_idx on chat_threads (user_id);
create index if not exists chat_threads_updated_at_idx on chat_threads (updated_at desc);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  role text not null,
  content text not null,
  position integer not null default 0,
  metadata_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread_id_idx on chat_messages (thread_id);
create index if not exists chat_messages_thread_position_idx on chat_messages (thread_id, position);
create index if not exists chat_messages_thread_created_at_idx on chat_messages (thread_id, created_at);
