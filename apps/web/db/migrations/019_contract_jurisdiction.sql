-- The jurisdiction the owner confirmed for a contract, which lets analyses compare its terms with
-- typical practice there. Nullable columns only, so this applies ahead of the code that uses them.
ALTER TABLE contracts
  ADD COLUMN confirmed_jurisdiction text
    CHECK (char_length(confirmed_jurisdiction) BETWEEN 1 AND 100),
  ADD COLUMN jurisdiction_confirmed_at timestamptz,
  ADD CONSTRAINT contracts_jurisdiction_confirmation_check
    CHECK ((confirmed_jurisdiction IS NULL) = (jurisdiction_confirmed_at IS NULL));
