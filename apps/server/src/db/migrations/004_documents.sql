-- Versioned document store (Task 6). Version rows are immutable; pointers live on `documents`.
create table documents (
  id text primary key,
  repo_id text not null references repositories(id) on delete cascade,
  type text not null,
  lang text not null,
  group_id text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  first_publication_date timestamptz,
  last_publication_date timestamptz,
  draft_version_id bigint,
  live_version_id bigint
);
create index documents_repo_type on documents (repo_id, type) where deleted_at is null;
create index documents_group on documents (repo_id, group_id);
create index documents_live on documents (repo_id, live_version_id) where live_version_id is not null;

create table document_versions (
  id bigserial primary key,
  document_id text not null references documents(id) on delete cascade,
  repo_id text not null references repositories(id) on delete cascade,
  uid text,
  tags text[] not null default '{}',
  title text,
  data jsonb not null,
  search_a tsvector not null,
  search_b tsvector not null,
  author_id text,
  created_at timestamptz not null default now(),
  message text
);
create index document_versions_doc on document_versions (document_id, id);
-- UID lookups for the publish-time uniqueness check. Uniqueness among *live* versions is enforced by
-- DocumentService.publish under the repo advisory lock, because liveness is a pointer on `documents`.
create index document_versions_uid on document_versions (repo_id, uid) where uid is not null;
create index document_versions_data on document_versions using gin (data jsonb_path_ops);
create index document_versions_search_a on document_versions using gin (search_a);
create index document_versions_search_b on document_versions using gin (search_b);

alter table documents
  add constraint documents_draft_fk foreign key (draft_version_id) references document_versions(id),
  add constraint documents_live_fk foreign key (live_version_id) references document_versions(id);

create table publications (
  seq bigserial primary key,
  repo_id text not null references repositories(id) on delete cascade,
  ref text not null unique,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('init','publish','unpublish','release'))
);
create index publications_repo on publications (repo_id, seq desc);

create table live_ranges (
  repo_id text not null references repositories(id) on delete cascade,
  document_id text not null references documents(id) on delete cascade,
  version_id bigint not null references document_versions(id),
  from_seq bigint not null references publications(seq),
  to_seq bigint references publications(seq),
  check (to_seq is null or to_seq > from_seq),
  primary key (document_id, from_seq)
);
create unique index live_ranges_one_open on live_ranges (document_id) where to_seq is null;
create index live_ranges_repo_seq on live_ranges (repo_id, from_seq, to_seq);

create table releases (
  id text primary key,
  repo_id text not null references repositories(id) on delete cascade,
  label text not null,
  ref text not null unique,
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','published','deleted')),
  migration boolean not null default false
);
create index releases_repo on releases (repo_id, status);

create table release_items (
  release_id text not null references releases(id) on delete cascade,
  document_id text not null references documents(id) on delete cascade,
  version_id bigint not null references document_versions(id),
  action text not null default 'publish' check (action in ('publish')),
  primary key (release_id, document_id)
);
