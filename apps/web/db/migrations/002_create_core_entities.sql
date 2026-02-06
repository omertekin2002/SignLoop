create extension if not exists "pgcrypto";

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text not null,
  description text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_idx on projects (user_id);

create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid,
  title text not null default 'Untitled Contract',
  status text not null default 'DRAFT',
  text_content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contracts_user_id_idx on contracts (user_id);
create index if not exists contracts_project_id_idx on contracts (project_id);
create index if not exists contracts_created_at_idx on contracts (created_at desc);

create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null,
  risk_badge text,
  result_json jsonb not null,
  llm_provider text,
  llm_model text,
  llm_prompt_tokens integer,
  llm_completion_tokens integer,
  processing_time_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists analyses_contract_id_idx on analyses (contract_id);
create index if not exists analyses_created_at_idx on analyses (created_at desc);

create table if not exists context_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  title text not null,
  document_type text not null default 'other',
  storage_key text,
  bucket text,
  original_filename text,
  content_type text,
  size_bytes integer,
  extracted_text text,
  word_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists context_documents_project_id_idx on context_documents (project_id);
create index if not exists context_documents_created_at_idx on context_documents (created_at desc);

alter table contract_files
  add column if not exists contract_id uuid;

alter table contract_files
  add column if not exists storage_key text;

alter table contract_files
  add column if not exists bucket text;

alter table contract_files
  add column if not exists extraction_method text;

alter table contract_files
  add column if not exists extraction_confidence double precision;

create index if not exists contract_files_contract_id_idx on contract_files (contract_id);
