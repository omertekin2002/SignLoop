-- Durable admission limits shared by all instances. Reservations expire after the route budget.
create table chat_admissions (
  token uuid primary key,
  principal text not null,
  expires_at timestamptz not null
);
create index chat_admissions_expiry_idx on chat_admissions(expires_at);
create index chat_admissions_principal_idx on chat_admissions(principal);
create table chat_request_budgets (
  bucket text not null,
  window_start timestamptz not null,
  requests integer not null,
  primary key(bucket, window_start)
);

alter table storage_deletions
  add column attempts integer not null default 0,
  add column available_at timestamptz not null default now(),
  add column lease_token uuid,
  add column lease_until timestamptz;
create index storage_deletions_available_idx on storage_deletions(available_at, created_at);
