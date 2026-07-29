-- Correct index coverage that 009/010 got wrong or missed (mirrors lib/server-db.ts ensureSchema).
--
-- chat_threads: 010 dropped chat_threads_updated_at_idx claiming "the thread list orders by
--   coalesce(last_message_at, updated_at), a computed expression an index on updated_at cannot
--   serve". No such expression exists anywhere in the codebase -- last_message_at is not a column,
--   and lastMessageAt/lastMessagePreview are hardcoded null projections that nothing renders. The
--   list actually runs `where user_id = $1 order by updated_at desc limit $2`, so it was sorting
--   every one of the user's threads in memory. The composite below serves that directly, and it
--   supersedes chat_threads_user_id_idx as its left prefix.
create index if not exists chat_threads_user_id_updated_at_idx
  on chat_threads (user_id, updated_at desc);
drop index if exists chat_threads_user_id_idx;

-- contracts: the project-detail read is `where project_id = $1 and user_id = $2 order by
--   created_at desc`, which contracts_project_id_idx cannot order. The same predicate also drives
--   the project-delete cascade.
create index if not exists contracts_project_id_created_at_idx
  on contracts (project_id, created_at desc);
drop index if exists contracts_project_id_idx;

-- contract_files: no query in the codebase filters or joins on contract_files.user_id or
--   contract_files.project_id. Every access path reaches the table by contract_id (and joins to
--   contracts/projects for ownership). These two date from migration 001, before contract_id
--   existed; 009/010 performed exactly this cleanup for five other indexes and missed these.
drop index if exists contract_files_user_id_idx;
drop index if exists contract_files_project_id_idx;
