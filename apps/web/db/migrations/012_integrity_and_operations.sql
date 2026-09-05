-- Protect new writes without deleting legacy orphan data. Validate where possible.
alter table contracts add constraint contracts_project_fk
  foreign key (project_id) references projects(id) on delete cascade not valid;
alter table analyses add constraint analyses_contract_fk
  foreign key (contract_id) references contracts(id) on delete cascade not valid;
alter table contract_files add constraint contract_files_contract_fk
  foreign key (contract_id) references contracts(id) on delete cascade not valid;
alter table context_documents add constraint context_documents_project_fk
  foreign key (project_id) references projects(id) on delete cascade not valid;
alter table chat_messages add constraint chat_messages_thread_fk
  foreign key (thread_id) references chat_threads(id) on delete cascade not valid;
do $$
declare item record;
begin
  for item in select conrelid::regclass as relation, conname from pg_constraint
    where conname in ('contracts_project_fk', 'analyses_contract_fk',
      'contract_files_contract_fk', 'context_documents_project_fk', 'chat_messages_thread_fk')
  loop
    begin
      execute format('alter table %s validate constraint %I', item.relation, item.conname);
    exception when foreign_key_violation then
      raise warning 'Legacy orphan rows remain: %.%', item.relation, item.conname;
    end;
  end loop;
end $$;

create table storage_deletions (
  id uuid primary key default gen_random_uuid(),
  storage_key text not null,
  created_at timestamptz not null default now()
);
create function enqueue_deleted_object() returns trigger language plpgsql as $$
declare object_key text;
begin
  object_key := to_jsonb(old)->>'storage_key';
  if object_key is null then object_key := to_jsonb(old)->>'blob_path'; end if;
  if object_key is not null then
    insert into storage_deletions(storage_key) values (object_key);
  end if;
  return old;
end $$;
create trigger contract_file_cleanup after delete on contract_files
  for each row execute function enqueue_deleted_object();
create trigger context_file_cleanup after delete on context_documents
  for each row execute function enqueue_deleted_object();

-- Serialize evidence changes against uploads and analysis revision checks.
create function invalidate_project_analyses() returns trigger language plpgsql as $$
declare project uuid;
begin
  project := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  perform id from contracts where project_id = project order by id for update;
  update contracts set status = 'DRAFT', updated_at = clock_timestamp()
    where project_id = project;
  return null;
end $$;
create trigger context_evidence_changed after insert or update or delete on context_documents
  for each row execute function invalidate_project_analyses();

create table generation_operations (
  entity_key text primary key,
  token uuid not null,
  expires_at timestamptz not null
);
create index generation_operations_expiry_idx on generation_operations(expires_at);
