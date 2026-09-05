create table chat_attachments (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references chat_threads(id) on delete cascade,
  image_data bytea not null,
  created_at timestamptz not null default now()
);
create index chat_attachments_thread_idx on chat_attachments(thread_id);
