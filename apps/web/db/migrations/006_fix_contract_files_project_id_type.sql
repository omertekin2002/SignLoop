-- Fix contract_files.project_id type: was text, should be uuid to match projects.id.
-- Existing values are either valid UUIDs or null, so the cast is safe.
-- Guarded so the ALTER (which takes an ACCESS EXCLUSIVE lock) only runs when the column is
-- not already uuid, making re-runs cheap no-ops.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'contract_files'
      and column_name = 'project_id'
      and data_type <> 'uuid'
  ) then
    alter table contract_files
      alter column project_id type uuid using project_id::uuid;
  end if;
end $$;
