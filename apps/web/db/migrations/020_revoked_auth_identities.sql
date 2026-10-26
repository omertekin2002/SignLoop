-- Retain only a one-way fingerprint, not the deleted owner's ID or raw subject.
-- Old AuthKit sessions must never provision a new owner after account deletion.
create table revoked_auth_identities (
  provider text not null,
  subject_hash bytea not null,
  primary key (provider, subject_hash)
);
