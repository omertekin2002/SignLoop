-- Fix contract_files.project_id type: was text, should be uuid to match projects.id
-- Existing values are either valid UUIDs or null, so the cast is safe.

alter table contract_files
  alter column project_id type uuid using project_id::uuid;
