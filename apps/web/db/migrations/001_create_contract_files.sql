create extension if not exists "pgcrypto";

create table if not exists contract_files (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id text,
  title text not null default 'Untitled Contract',
  file_name text not null,
  blob_path text,
  content_type text,
  size_bytes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contract_files_user_id_idx on contract_files (user_id);
create index if not exists contract_files_project_id_idx on contract_files (project_id);
