import type { Fragment, Sql } from "../db/index.js";

/**
 * What a ref sees. `seq` is a publication sequence number (bigint as decimal string, like `MasterRef.seq`).
 * - master: the latest publication; historic: an older master ref.
 * - release / preview: master at `seq` overlaid with a release's items or with drafts (Task 12).
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
    case "preview":
      // Extension point (Task 12): overlay release items / drafts on `liveAt(seq)`.
      throw new Error(`ref scope '${scope.kind}' is not supported yet`);
  }
}

/** Versions whose live range covers `seq`: from_seq <= seq < to_seq (open ranges have to_seq null). */
function liveAt(sql: Sql, repoId: string, seq: string): Fragment {
  return sql`select lr.document_id, lr.version_id from live_ranges lr
    where lr.repo_id = ${repoId} and lr.from_seq <= ${seq}::bigint and (lr.to_seq is null or lr.to_seq > ${seq}::bigint)`;
}
