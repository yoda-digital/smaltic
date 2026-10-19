import type { Sql } from "../db/index.js";
import { insertPublication, type MasterRef, type PublicationKind } from "./refs.js";

/** Shared publish core for DocumentService and ReleaseService. */

export class DocumentNotFound extends Error {
  constructor(public ids: string[]) {
    super(`Document(s) not found: ${ids.join(", ")}`);
  }
}
export class UidConflict extends Error {
  constructor(public uid: string, public type: string, public lang: string, public documentIds: string[]) {
    super(`UID "${uid}" is already used by a live ${type} document in ${lang}`);
  }
}
/** A version about to go live, with what the UID check needs. */
export interface LiveItem {
  id: string;
  versionId: string;
  type: string;
  lang: string;
  uid: string | null;
}

/**
 * Checks UID uniqueness among live, non-deleted documents per (repo, type, lang), counting the batch
 * itself. Must run under `lockRepo` in the publishing transaction (R3: no DB unique index).
 */
async function checkUids(t: Sql, repoId: string, items: LiveItem[]): Promise<void> {
  const batch = new Map<string, LiveItem>();
  for (const it of items) {
    if (!it.uid) continue;
    const key = `${it.type}\u0000${it.lang}\u0000${it.uid}`;
    const prev = batch.get(key);
    if (prev) throw new UidConflict(it.uid, it.type, it.lang, [prev.id, it.id]);
    batch.set(key, it);
  }
  const ids = items.map((i) => i.id);
  for (const it of batch.values()) {
    const holders = await t`
      select d.id from documents d join document_versions v on v.id = d.live_version_id
      where d.repo_id = ${repoId} and d.deleted_at is null and d.type = ${it.type} and d.lang = ${it.lang}
        and v.uid = ${it.uid} and d.id <> all(${ids})`;
    if (holders.length > 0) throw new UidConflict(it.uid!, it.type, it.lang, holders.map((h) => h.id as string));
  }
}

/**
 * Makes `items` live in a new publication: checks UIDs, mints the ref, closes and opens live ranges and
 * stamps publication dates. Caller holds `lockRepo` and has the document rows locked.
 */
export async function publishItems(t: Sql, repoId: string, kind: PublicationKind, items: LiveItem[]): Promise<MasterRef> {
  await checkUids(t, repoId, items);
  const pub = await insertPublication(t, repoId, kind);
  for (const it of items) {
    const [doc] = await t`select live_version_id from documents where id = ${it.id}`;
    if (doc!.live_version_id !== null && String(doc!.live_version_id) === it.versionId) continue;
    await t`update live_ranges set to_seq = ${pub.seq} where document_id = ${it.id} and to_seq is null`;
    await t`insert into live_ranges (repo_id, document_id, version_id, from_seq)
      values (${repoId}, ${it.id}, ${it.versionId}, ${pub.seq})`;
    await t`update documents set live_version_id = ${it.versionId}, archived_at = null,
        first_publication_date = coalesce(first_publication_date, ${pub.createdAt}),
        last_publication_date = ${pub.createdAt}
      where id = ${it.id}`;
  }
  return { ref: pub.ref, seq: pub.seq };
}

/** Locks and loads non-deleted documents of the repo; throws DocumentNotFound for any missing id. */
export async function lockDocs(t: Sql, repoId: string, ids: string[]) {
  const rows = await t`
    select d.id, d.type, d.lang, d.draft_version_id, d.live_version_id, d.archived_at, v.uid as draft_uid
    from documents d left join document_versions v on v.id = d.draft_version_id
    where d.repo_id = ${repoId} and d.id = any(${ids}) and d.deleted_at is null
    order by d.id
    for update of d`;
  const found = new Set(rows.map((r) => r.id as string));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new DocumentNotFound(missing);
  return rows;
}

