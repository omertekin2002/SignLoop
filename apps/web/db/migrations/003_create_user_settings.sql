create table if not exists user_settings (
  user_id text primary key,
  primary_model text,
  updated_at timestamptz not null default now()
);

