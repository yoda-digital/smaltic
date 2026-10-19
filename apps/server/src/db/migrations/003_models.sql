create table custom_types (
  repo_id text not null references repositories(id) on delete cascade,
  id text not null,
  model jsonb not null,
  hash text not null,
  updated_at timestamptz not null default now(),
  primary key (repo_id, id)
);

create table shared_slices (
  repo_id text not null references repositories(id) on delete cascade,
  id text not null,
  model jsonb not null,
  hash text not null,
  updated_at timestamptz not null default now(),
  primary key (repo_id, id)
);

create table model_history (
  seq bigserial primary key,
  repo_id text not null references repositories(id) on delete cascade,
  kind text not null check (kind in ('custom_type','shared_slice')),
  id text not null,
  op text not null check (op in ('insert','update','delete')),
  model jsonb,
  changed_at timestamptz not null default now(),
  changed_by text
);
create index model_history_lookup on model_history (repo_id, kind, id, seq);
