import { newId } from "@smaltic/model";
import type { Sql } from "../db/index.js";
import type { DomainEvents } from "./events.js";
import { DocumentNotFound, lockDocs, publishItems, type LiveItem } from "./publishing.js";
import { lockRepo, type MasterRef } from "./refs.js";

export class ReleaseNotFound extends Error {
  constructor(public id: string) {
    super(`Release ${id} not found`);
  }
}
export class ReleaseNotOpen extends Error {
  constructor(public id: string, public status: string) {
    super(`Release ${id} is ${status}`);
  }
}

export interface CreateReleaseOpts {
  scheduledAt?: Date | null;
  migration?: boolean;
}
export interface Release {
  id: string;
  ref: string;
}

type Actor = string | null;

const tx = <T>(sql: Sql, fn: (t: Sql) => Promise<T>): Promise<T> =>
  sql.begin((t) => fn(t as unknown as Sql)) as Promise<T>;

export interface LockedRelease extends Release {
  /** True when this transaction created it. */
  created: boolean;
}

/**
 * Returns the repo's single open migration release locked FOR UPDATE in `t`, creating it on demand.
 * The row lock serializes against `ReleaseService.publish` (which locks the release row first): a
 * publish that commits while we wait makes the row no longer `open` on re-check, so we open a new
 * one. Concurrent creators meet on the partial unique index `releases_one_open_migration`.
 */
export async function lockOpenMigrationRelease(t: Sql, repoId: string): Promise<LockedRelease> {
  for (let i = 0; i < 5; i++) {
    const [r] = await t`select id, ref from releases
      where repo_id = ${repoId} and migration and status = 'open' for update`;
    if (r) return { id: r.id, ref: r.ref, created: false };
    const [ins] = await t`insert into releases (id, repo_id, label, ref, migration)
      values (${newId()}, ${repoId}, 'Migration release', ${newId()}, true)
      on conflict (repo_id) where migration and status = 'open' do nothing
      returning id, ref`;
    if (ins) return { id: ins.id, ref: ins.ref, created: true };
    // Another tx created it and committed while our insert waited: the next select sees it.
  }
  throw new Error(`Could not open a migration release for repository ${repoId}`);
}

/** Locks an open release row of the repo. */
async function lockOpen(t: Sql, repoId: string, id: string): Promise<void> {
  const [r] = await t`select status from releases where id = ${id} and repo_id = ${repoId} for update`;
  if (!r) throw new ReleaseNotFound(id);
  if (r.status !== "open") throw new ReleaseNotOpen(id, r.status);
}

/**
 * Releases stage snapshots of document drafts under their own ref. Master is untouched until
 * `publish`, which makes every staged version live in one publication.
 */
export class ReleaseService {
  constructor(private sql: Sql, private events: DomainEvents) {}

  async create(repoId: string, actor: Actor, label: string, opts: CreateReleaseOpts = {}): Promise<Release> {
    const id = newId();
    const ref = newId();
    await this.sql`insert into releases (id, repo_id, label, ref, scheduled_at, migration)
      values (${id}, ${repoId}, ${label}, ${ref}, ${opts.scheduledAt ?? null}, ${opts.migration ?? false})`;
    this.events.emit("release.created", { repoId, actor, releaseId: id, ref });
    return { id, ref };
  }

  async findOpenMigrationRelease(repoId: string): Promise<Release | null> {
    const [r] = await this.sql`select id, ref from releases where repo_id = ${repoId} and migration and status = 'open'`;
    return r ? { id: r.id, ref: r.ref } : null;
  }

  /** Stages the document's current draft version (re-adding replaces the snapshot). */
  async add(repoId: string, actor: Actor, releaseId: string, docId: string): Promise<void> {
    await tx(this.sql, async (t) => {
      await lockOpen(t, repoId, releaseId);
      const [doc] = await lockDocs(t, repoId, [docId]);
      await t`insert into release_items (release_id, document_id, version_id)
        values (${releaseId}, ${docId}, ${doc!.draft_version_id})
        on conflict (release_id, document_id) do update set version_id = excluded.version_id`;
    });
    this.events.emit("release.updated", { repoId, actor, releaseId });
  }

  async remove(repoId: string, actor: Actor, releaseId: string, docId: string): Promise<void> {
    await tx(this.sql, async (t) => {
      await lockOpen(t, repoId, releaseId);
      await t`delete from release_items where release_id = ${releaseId} and document_id = ${docId}`;
    });
    this.events.emit("release.updated", { repoId, actor, releaseId });
  }

  async publish(repoId: string, actor: Actor, releaseId: string): Promise<MasterRef> {
    let items: LiveItem[] = [];
    const master = await tx(this.sql, async (t) => {
      await lockRepo(t, repoId);
      await lockOpen(t, repoId, releaseId);
      const staged = await t`select document_id, version_id from release_items where release_id = ${releaseId}`;
      const docs = await lockDocs(t, repoId, staged.map((s) => s.document_id as string));
      const byId = new Map(docs.map((d) => [d.id as string, d]));
      const versions = await t`select id, uid from document_versions where id = any(${staged.map((s) => String(s.version_id))})`;
      const uidOf = new Map(versions.map((v) => [String(v.id), v.uid as string | null]));
      items = staged.map((s) => {
        const d = byId.get(s.document_id);
        if (!d) throw new DocumentNotFound([s.document_id]);
        const versionId = String(s.version_id);
        return { id: d.id, versionId, type: d.type, lang: d.lang, uid: uidOf.get(versionId) ?? null };
      });
      const m = await publishItems(t, repoId, "release", items);
      await t`update releases set status = 'published' where id = ${releaseId}`;
      return m;
    });
    this.events.emit("release.published", {
      repoId, actor, releaseId, ...master, documents: items.map(({ id, versionId }) => ({ id, versionId })),
    });
    return master;
  }

  async delete(repoId: string, actor: Actor, releaseId: string): Promise<void> {
    await tx(this.sql, async (t) => {
      await lockOpen(t, repoId, releaseId);
      await t`update releases set status = 'deleted' where id = ${releaseId}`;
    });
    this.events.emit("release.deleted", { repoId, actor, releaseId });
  }
}
