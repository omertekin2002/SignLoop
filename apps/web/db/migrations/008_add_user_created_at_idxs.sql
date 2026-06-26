-- Composite indexes for the two primary per-user list endpoints, both of which run
-- "where user_id = $1 order by created_at desc" (listProjectsByUserId, listContractsByUserId).
-- projects previously had only a user_id index (forcing an in-memory sort), and contracts had
-- user_id and created_at as separate single-column indexes; one composite index serves the
-- filter + ordering as a single ordered index scan. Mirrors the inline ensureSchema() bootstrap.
create index if not exists projects_user_id_created_at_idx
  on projects (user_id, created_at desc);

create index if not exists contracts_user_id_created_at_idx
  on contracts (user_id, created_at desc);
