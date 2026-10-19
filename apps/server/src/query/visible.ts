import type { Fragment, Sql } from "../db/index.js";

/**
 * What a ref sees. `seq` is a publication sequence number (bigint as decimal string, like `MasterRef.seq`).
 * - master: the latest publication; historic: an older master ref.
 * - release / preview: master at `seq` overlaid with a release's items or with drafts.
 */
export type RefScope =
  | { kind: "master"; seq: string }
  | { kind: "historic"; seq: string }
  | { kind: "release"; seq: string; releaseId: string }
  | { kind: "preview"; seq: string; overlay: "drafts" | { releaseId: string } };

/**
 * The visible version of each document in `scope`, as a subquery yielding `(document_id, version_id)`,
 * at most one row per document. Callers join it to `documents` / `document_versions`.
 */
export function visibleVersionsSql(sql: Sql, repoId: string, scope: RefScope): Fragment {
  switch (scope.kind) {
    case "master":
    case "historic":
      return liveAt(sql, repoId, scope.seq);
    case "release":
      return releaseOverlay(sql, repoId, scope.seq, scope.releaseId);
    case "preview":
      return scope.overlay === "drafts"
        ? draftsOverlay(sql, repoId, scope.seq)
        : releaseOverlay(sql, repoId, scope.seq, scope.overlay.releaseId);
  }
}

/** Versions whose live range covers `seq`: from_seq <= seq < to_seq (open ranges have to_seq null). */
function liveAt(sql: Sql, repoId: string, seq: string): Fragment {
  return sql`select lr.document_id, lr.version_id from live_ranges lr
    where lr.repo_id = ${repoId} and lr.from_seq <= ${seq}::bigint and (lr.to_seq is null or lr.to_seq > ${seq}::bigint)`;
}

/**
 * Master at `seq` overlaid with the release's staged versions: a staged document shows its staged
 * version (whether or not it is live); every other live document shows its live version.
 */
function releaseOverlay(sql: Sql, repoId: string, seq: string, releaseId: string): Fragment {
  return sql`select ri.document_id, ri.version_id from release_items ri
      join documents d on d.id = ri.document_id
      where ri.release_id = ${releaseId}::text and d.repo_id = ${repoId} and d.deleted_at is null
    union all
    select b.document_id, b.version_id from (${liveAt(sql, repoId, seq)}) b
      where not exists (select 1 from release_items ri2
        where ri2.release_id = ${releaseId}::text and ri2.document_id = b.document_id)`;
}

/**
 * Master at `seq` overlaid with the current draft of every unarchived, undeleted document of the
 * repo (published or not). Archived documents are hidden even though they still have a draft.
 */
function draftsOverlay(sql: Sql, repoId: string, seq: string): Fragment {
  return sql`select d.id as document_id, d.draft_version_id as version_id from documents d
      where d.repo_id = ${repoId} and d.archived_at is null and d.deleted_at is null and d.draft_version_id is not null
    union all
    select b.document_id, b.version_id from (${liveAt(sql, repoId, seq)}) b
      join documents d2 on d2.id = b.document_id
      where not (d2.archived_at is null and d2.deleted_at is null and d2.draft_version_id is not null)`;
}
