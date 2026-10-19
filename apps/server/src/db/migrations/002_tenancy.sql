create table users (
  id text primary key,
  email text not null unique,
  name text not null default '',
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table repositories (
  id text primary key,
  name text not null unique,
  display_name text not null,
  api_visibility text not null default 'public' check (api_visibility in ('public','private','open')),
  created_at timestamptz not null default now()
);

create table locales (
  repo_id text not null references repositories(id) on delete cascade,
  code text not null,
  name text not null,
  position int not null default 0,
  is_master boolean not null default false,
  primary key (repo_id, code)
);
create unique index locales_one_master on locales (repo_id) where is_master;

create table memberships (
  repo_id text not null references repositories(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'admin',
  primary key (repo_id, user_id)
);

create table api_tokens (
  id text primary key,
  repo_id text not null references repositories(id) on delete cascade,
  kind text not null check (kind in ('access','write')),
  name text not null,
  token_hash text not null unique,
  scope text not null default 'master' check (scope in ('master','master+releases')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index api_tokens_repo on api_tokens (repo_id);
