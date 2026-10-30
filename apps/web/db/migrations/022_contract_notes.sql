-- The owner's personal decision notes for a contract: why they would accept it and what they still
-- need answered. One row per contract, owned by the user rather than by any analysis, so
-- re-analysing or re-uploading leaves it alone; deleting the contract deletes it. updated_at is the
-- save's concurrency revision: whole milliseconds, so it survives a round trip through a JavaScript
-- Date, and moved forward by at least one millisecond on every save.
CREATE TABLE contract_notes (
  contract_id uuid PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES application_users(id),
  acceptance_reasons text NOT NULL DEFAULT ''
    CHECK (char_length(acceptance_reasons) <= 10000),
  open_questions text NOT NULL DEFAULT ''
    CHECK (char_length(open_questions) <= 10000),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX contract_notes_user_id_idx ON contract_notes(user_id);
