-- Personal application ownership is independent of the authentication provider.
-- Start fresh: leave legacy workspace rows untouched and do not import identities.
create table application_users (
  id text primary key
);

create table auth_identities (
  provider text not null,
  subject text not null,
  user_id text not null references application_users(id),
  primary key (provider, subject),
  unique (provider, user_id)
);
