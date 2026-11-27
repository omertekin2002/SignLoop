-- The owner's decision on each "Before you sign" item: resolved, accepted as is, or still open, with
-- an optional reason. One row per (contract, item key, source revision). item_key is the item's
-- stable key (lib/clarify-keys.ts) and source_revision the analysed text's revision, copied by the
-- server from the analysis the decision was made on, so a decision only ever matches the same item
-- in the same contract text. The decision outlives that analysis (analysis_id goes null when it is
-- replaced or deleted) and goes with the contract. item_label is the item's wording when saved,
-- shown once the item no longer matches. Decisions are the owner's own: they are never sent to a
-- model. updated_at is the save's concurrency revision: whole milliseconds, so it survives a round
-- trip through a JavaScript Date, and moved forward by at least one millisecond on every save.
CREATE TABLE clarify_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES application_users(id),
  item_key text NOT NULL
    CHECK (char_length(item_key) <= 200 AND item_key ~ '^v[0-9]+:[a-z]+:[a-z0-9:-]+$'),
  source_revision text NOT NULL CHECK (source_revision ~ '^sha256:[0-9a-f]{64}$'),
  analysis_id uuid REFERENCES analyses(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('resolved', 'accepted', 'open')),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 2000),
  item_label text NOT NULL CHECK (char_length(item_label) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  UNIQUE (contract_id, item_key, source_revision)
);
CREATE INDEX clarify_decisions_user_id_idx ON clarify_decisions(user_id);
CREATE INDEX clarify_decisions_analysis_id_idx ON clarify_decisions(analysis_id);
