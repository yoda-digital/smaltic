create table if not exists _migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
