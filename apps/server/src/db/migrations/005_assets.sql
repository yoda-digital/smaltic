-- Media library (Task 7). Originals live under <dataDir>/assets/<storage_key>.
create table assets (
  id text primary key,
  repo_id text not null references repositories(id) on delete cascade,
  filename text not null,
  extension text not null default '',
  kind text not null check (kind in ('image','audio','video','document')),
  mime text not null,
  size bigint not null,
  width int,
  height int,
  alt text,
  credits text,
  notes text,
  storage_key text not null,
  uploader_id text,
  created_at timestamptz not null default now(),
  last_modified timestamptz not null default now()
);
create index assets_repo on assets (repo_id, created_at desc);

create table asset_tags (
  id text primary key,
  repo_id text not null references repositories(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (repo_id, name)
);

create table asset_tag_links (
  asset_id text not null references assets(id) on delete cascade,
  tag_id text not null references asset_tags(id) on delete cascade,
  primary key (asset_id, tag_id)
);

-- At most one open migration release per repository (created on demand by the Migration API).
create unique index releases_one_open_migration on releases (repo_id) where migration and status = 'open';
