-- Drop single-column indexes that are redundant left-prefixes of existing composite indexes (or
-- otherwise unused), removing their write/storage overhead. The composites added in 002/004/007/008
-- cover every query these served. Mirrors the inline ensureSchema() bootstrap in lib/server-db.ts.
drop index if exists projects_user_id_idx;          -- ⊂ projects_user_id_created_at_idx
drop index if exists contracts_user_id_idx;         -- ⊂ contracts_user_id_created_at_idx
drop index if exists contracts_created_at_idx;       -- unused: no global created_at sort
drop index if exists analyses_contract_id_idx;       -- ⊂ analyses_contract_id_created_at_idx
drop index if exists chat_messages_thread_id_idx;    -- ⊂ chat_messages_thread_(position|created_at)_idx
