-- Preview configurations (Task 12): named website preview URLs per repository (REQ-PRV-008).
-- The preview URL opened for a session is website_url + resolver_path + ?token=&documentId=.
create table preview_configs (
  id text primary key,
  repo_id text not null references repositories(id) on delete cascade,
  name text not null,
  website_url text not null,
  resolver_path text not null,
  created_at timestamptz not null default now(),
  unique (repo_id, name)
);
