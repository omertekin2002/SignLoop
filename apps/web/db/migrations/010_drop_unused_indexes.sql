-- Drop indexes no query path uses (mirrors the omissions in lib/server-db.ts ensureSchema):
-- analyses_created_at_idx: every analyses read filters by contract_id (served by
--   analyses_contract_id_created_at_idx); nothing sorts analyses globally. Same rationale that
--   dropped contracts_created_at_idx in 009.
-- context_documents_created_at_idx: reads filter by project_id and sort tiny per-project sets.
-- chat_threads_updated_at_idx: DROPPED IN ERROR. The stated rationale ("the thread list orders by
--   coalesce(last_message_at, updated_at), a computed expression an index on updated_at cannot
--   serve") described a query that has never existed -- the list orders by plain updated_at.
--   Migration 011 restores coverage as chat_threads (user_id, updated_at desc). Left here as-is
--   because migration history is append-only; see 011 for the correction.
drop index if exists analyses_created_at_idx;
drop index if exists context_documents_created_at_idx;
drop index if exists chat_threads_updated_at_idx;
