-- Composite index for "analyses of a contract, newest first" — the access pattern used by
-- getContractByIdForUser and getContractWithLatestAnalysisForUser
-- (where contract_id = $1 order by created_at desc). The two single-column indexes can't serve
-- this as efficiently as one composite index.
create index if not exists analyses_contract_id_created_at_idx
  on analyses (contract_id, created_at desc);
