-- Two access paths that 009-011 did not cover.
--
-- contracts: listContractsForChat (the chat agent's list_contracts tool) runs
--   `where user_id = $1 ... order by updated_at desc, id desc`. Every composite on contracts is
--   keyed on created_at -- contracts_user_id_created_at_idx from 008 and
--   contracts_project_id_created_at_idx from 011 -- so none can serve this ordering, and each
--   call sorted the user's entire contract set in memory. The trailing id matches the query's
--   tiebreaker so the index supplies the full ordering rather than a prefix of it.
create index if not exists contracts_user_id_updated_at_idx
  on contracts (user_id, updated_at desc, id desc);

-- storage_deletions: the outbox worker reads `order by created_at limit 100` on every delete
--   request and every cleanup run, and 012 created the table with no index but its primary key.
create index if not exists storage_deletions_created_at_idx
  on storage_deletions (created_at);
