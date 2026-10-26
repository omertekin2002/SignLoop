-- A direct-to-Blob upload's cleanup intent, bound to the contract or project its client token was
-- issued for, so only that owner's finalize request can claim the uploaded object. Claiming or
-- processing the intent deletes the binding with it; deleting the target keeps the intent, so the
-- outbox still removes the object.
CREATE TABLE direct_uploads (
  storage_deletion_id uuid PRIMARY KEY REFERENCES storage_deletions(id) ON DELETE CASCADE,
  pathname text NOT NULL UNIQUE
    CHECK (pathname ~ '^uploads/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  contract_id uuid REFERENCES contracts(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  CHECK (num_nonnulls(contract_id, project_id) = 1)
);
CREATE INDEX direct_uploads_contract_idx ON direct_uploads(contract_id);
CREATE INDEX direct_uploads_project_idx ON direct_uploads(project_id);
