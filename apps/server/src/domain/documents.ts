import {
  extractSearchText,
  newId,
  normalizeDocumentData,
  validateUid,
  type CustomType,
  type FieldError,
  type NormalizeCtx,
  type SharedSlice,
  type StoredData,
} from "@smaltic/model";
import type { Sql } from "../db/index.js";
import { DomainEvents, type PublishedDoc } from "./events.js";
import { ModelService } from "./models.js";
import { DocumentNotFound, UidConflict, lockDocs, publishItems, type LiveItem } from "./publishing.js";
import { insertPublication, lockRepo, type MasterRef } from "./refs.js";
import { ReleaseService, type CreateReleaseOpts, type Release } from "./releases.js";

export { DocumentNotFound, UidConflict };
export { ReleaseNotFound, ReleaseNotOpen, type CreateReleaseOpts, type Release } from "./releases.js";

export class VersionNotFound extends Error {
  constructor(public documentId: string, public versionId: string) {
    super(`Version ${versionId} not found for document ${documentId}`);
  }
}
export class ValidationFailed extends Error {
  constructor(public errors: FieldError[]) {
    super(errors.map((e) => `${e.property}: ${e.error}`).join("; "));
  }
}
export class NotArchived extends Error {
  constructor(public ids: string[]) {
    super(`Document(s) must be archived before deletion: ${ids.join(", ")}`);
  }
}
export class AlternateLangConflict extends Error {
  constructor(public groupId: string, public lang: string) {
    super(`An alternate in ${lang} already exists for this document`);
  }
}

export type Actor = string | null;

/** Optimistic attempts before updateDraft falls back to reading under the row lock. */
const UPDATE_DRAFT_ATTEMPTS = 3;

export interface CreateDocumentInput {
  type: string;
  lang: string;
  uid?: string | null;
  tags?: string[];
  title?: string | null;
  data: Record<string, unknown>;
  /** Id of a document whose translation group this one joins. */
  alternateOf?: string;
}

export interface UpdateDraftInput {
  /** Omitted fields carry over from the current draft. */
  uid?: string | null;
  tags?: string[];
  title?: string | null;
  data: Record<string, unknown>;
}

export interface DocumentVersion {
  id: string;
  uid: string | null;
  tags: string[];
  title: string | null;
  data: StoredData;
  authorId: string | null;
  createdAt: Date;
  message: string | null;
  isDraft: boolean;
  isLive: boolean;
}

export interface DocumentServiceOpts {
  events?: DomainEvents;
  models?: ModelService;
  /** oEmbed / asset hooks for normalization. Default: no oEmbed resolution, every asset id accepted. */
  normalizeCtx?: NormalizeCtx;
}

/** Text search configuration; the one place to change it (Task 9 may switch to an unaccent config). */
export const SEARCH_CONFIG = "simple";
const tsvector = (t: Sql, text: string) => t`to_tsvector(${SEARCH_CONFIG}::regconfig, ${text})`;

interface PreparedVersion {
  uid: string | null;
  tags: string[];
  title: string | null;
  data: StoredData;
  weightA: string;
  weightB: string;
}

const tx = <T>(sql: Sql, fn: (t: Sql) => Promise<T>): Promise<T> =>
  sql.begin((t) => fn(t as unknown as Sql)) as Promise<T>;

const unique = (ids: string[]) => [...new Set(ids)];

export class DocumentService {
  readonly events: DomainEvents;
  private models: ModelService;
  private normalizeCtx: NormalizeCtx;
  private releases: ReleaseService;

  constructor(private sql: Sql, opts: DocumentServiceOpts = {}) {
    this.events = opts.events ?? new DomainEvents();
    this.models = opts.models ?? new ModelService(sql);
    this.normalizeCtx = opts.normalizeCtx ?? { resolveEmbed: () => null, assetExists: () => true };
    this.releases = new ReleaseService(sql, this.events);
  }

  async create(repoId: string, actor: Actor, input: CreateDocumentInput): Promise<{ id: string; versionId: string }> {
    const prepared = await this.prepare(repoId, input.type, input.lang, input);
    const id = newId();
    const versionId = await tx(this.sql, async (t) => {
      let groupId = id;
      if (input.alternateOf) {
        const [src] = await t`select group_id from documents
          where id = ${input.alternateOf} and repo_id = ${repoId} and deleted_at is null`;
        if (!src) throw new DocumentNotFound([input.alternateOf]);
        groupId = src.group_id;
        const [clash] = await t`select 1 from documents
          where repo_id = ${repoId} and group_id = ${groupId} and lang = ${input.lang} and deleted_at is null`;
        if (clash) throw new AlternateLangConflict(groupId, input.lang);
      }
      await t`insert into documents (id, repo_id, type, lang, group_id)
        values (${id}, ${repoId}, ${input.type}, ${input.lang}, ${groupId})`;
      const vid = await this.insertVersion(t, repoId, id, actor, prepared, null);
      await t`update documents set draft_version_id = ${vid} where id = ${id}`;
      return vid;
    });
    this.events.emit("documents.created", { repoId, actor, id, versionId });
    return { id, versionId };
  }

  /** Always inserts a new version and moves the draft pointer to it. Returns the version id. */
  async updateDraft(repoId: string, actor: Actor, id: string, input: UpdateDraftInput): Promise<string> {
    // Carried-over uid/tags/title come from the current draft. Optimistic attempts read and normalize outside
    // the write tx (normalization may hit the network) and re-check under the row lock that the draft is still
    // the one read, retrying if not. The last attempt reads under the row lock, so it cannot lose an update
    // and cannot fail spuriously under contention.
    let versionId: string | null = null;
    for (let attempt = 1; versionId === null; attempt++) {
      const pessimistic = attempt >= UPDATE_DRAFT_ATTEMPTS;
      versionId = pessimistic
        ? await tx(this.sql, async (t) => {
            await lockDocs(t, repoId, [id]);
            const { prepared } = await this.prepareDraft(t, repoId, id, input);
            return this.writeDraft(t, repoId, actor, id, prepared);
          })
        : await (async () => {
            const { seenDraft, prepared } = await this.prepareDraft(this.sql, repoId, id, input);
            return tx(this.sql, async (t) => {
              const [locked] = await lockDocs(t, repoId, [id]);
              if (String(locked!.draft_version_id) !== seenDraft) return null;
              return this.writeDraft(t, repoId, actor, id, prepared);
            });
          })();
    }
    this.events.emit("documents.updated", { repoId, actor, id, versionId });
    return versionId;
  }

  private async prepareDraft(q: Sql, repoId: string, id: string, input: UpdateDraftInput) {
    const [doc] = await q`
      select d.type, d.lang, d.draft_version_id, v.uid, v.tags, v.title from documents d
      left join document_versions v on v.id = d.draft_version_id
      where d.id = ${id} and d.repo_id = ${repoId} and d.deleted_at is null`;
    if (!doc) throw new DocumentNotFound([id]);
    const prepared = await this.prepare(repoId, doc.type, doc.lang, {
      uid: input.uid === undefined ? doc.uid : input.uid,
      tags: input.tags ?? doc.tags ?? [],
      title: input.title === undefined ? doc.title : input.title,
      data: input.data,
    });
    return { seenDraft: String(doc.draft_version_id), prepared };
  }

  private async writeDraft(t: Sql, repoId: string, actor: Actor, id: string, prepared: PreparedVersion): Promise<string> {
    const vid = await this.insertVersion(t, repoId, id, actor, prepared, null);
    await t`update documents set draft_version_id = ${vid} where id = ${id}`;
    return vid;
  }

  /** Publishes the current drafts of `ids` in a single publication (one new master ref). */
  async publish(repoId: string, actor: Actor, ids: string[]): Promise<MasterRef> {
    let documents: PublishedDoc[] = [];
    const master = await tx(this.sql, async (t) => {
      await lockRepo(t, repoId);
      const docs = await lockDocs(t, repoId, unique(ids));
      const items: LiveItem[] = docs.map((d) => ({
        id: d.id, versionId: String(d.draft_version_id), type: d.type, lang: d.lang, uid: d.draft_uid,
      }));
      documents = items.map(({ id, versionId }) => ({ id, versionId }));
      return publishItems(t, repoId, "publish", items);
    });
    this.events.emit("documents.published", { repoId, actor, ...master, documents });
    return master;
  }

  /** Takes documents off master and archives them, in one publication. */
  async unpublish(repoId: string, actor: Actor, ids: string[]): Promise<MasterRef> {
    const list = unique(ids);
    const master = await tx(this.sql, async (t) => {
      await lockRepo(t, repoId);
      await lockDocs(t, repoId, list);
      const pub = await insertPublication(t, repoId, "unpublish");
      await t`update live_ranges set to_seq = ${pub.seq} where document_id = any(${list}) and to_seq is null`;
      await t`update documents set live_version_id = null, archived_at = coalesce(archived_at, now())
        where id = any(${list})`;
      return { ref: pub.ref, seq: pub.seq };
    });
    this.events.emit("documents.unpublished", { repoId, actor, ...master, ids: list });
    return master;
  }

  /** Soft-deletes archived documents. Versions are kept (immutable history). */
  async deleteArchived(repoId: string, actor: Actor, ids: string[]): Promise<void> {
    const list = unique(ids);
    await tx(this.sql, async (t) => {
      const docs = await lockDocs(t, repoId, list);
      const notArchived = docs.filter((d) => d.archived_at === null || d.live_version_id !== null).map((d) => d.id);
      if (notArchived.length) throw new NotArchived(notArchived);
      await t`update documents set deleted_at = now() where id = any(${list})`;
    });
    this.events.emit("documents.deleted", { repoId, actor, ids: list });
  }

  /** Copies an earlier version as a new draft version. Returns the new version id. */
  async restoreVersion(repoId: string, actor: Actor, id: string, versionId: string): Promise<string> {
    const newVersionId = await tx(this.sql, async (t) => {
      await lockDocs(t, repoId, [id]);
      const [row] = await t`
        insert into document_versions (document_id, repo_id, uid, tags, title, data, search_a, search_b, author_id, message)
        select document_id, repo_id, uid, tags, title, data, search_a, search_b, ${actor}, ${`Restored from version ${versionId}`}
        from document_versions where id = ${versionId} and document_id = ${id}
        returning id`;
      if (!row) throw new VersionNotFound(id, versionId);
      await t`update documents set draft_version_id = ${row.id} where id = ${id}`;
      return String(row.id);
    });
    this.events.emit("documents.updated", { repoId, actor, id, versionId: newVersionId });
    return newVersionId;
  }

  async listVersions(repoId: string, id: string): Promise<DocumentVersion[]> {
    const [doc] = await this.sql`select draft_version_id, live_version_id from documents
      where id = ${id} and repo_id = ${repoId} and deleted_at is null`;
    if (!doc) throw new DocumentNotFound([id]);
    const rows = await this.sql`select id, uid, tags, title, data, author_id, created_at, message
      from document_versions where document_id = ${id} order by id`;
    return rows.map((r) => ({
      id: String(r.id),
      uid: r.uid,
      tags: r.tags,
      title: r.title,
      data: r.data,
      authorId: r.author_id,
      createdAt: r.created_at,
      message: r.message,
      isDraft: doc.draft_version_id !== null && String(doc.draft_version_id) === String(r.id),
      isLive: doc.live_version_id !== null && String(doc.live_version_id) === String(r.id),
    }));
  }

  // Releases (implemented in releases.ts).
  createRelease(repoId: string, actor: Actor, label: string, opts?: CreateReleaseOpts): Promise<Release> {
    return this.releases.create(repoId, actor, label, opts);
  }
  addToRelease(repoId: string, actor: Actor, releaseId: string, docId: string): Promise<void> {
    return this.releases.add(repoId, actor, releaseId, docId);
  }
  removeFromRelease(repoId: string, actor: Actor, releaseId: string, docId: string): Promise<void> {
    return this.releases.remove(repoId, actor, releaseId, docId);
  }
  publishRelease(repoId: string, actor: Actor, releaseId: string): Promise<MasterRef> {
    return this.releases.publish(repoId, actor, releaseId);
  }
  deleteRelease(repoId: string, actor: Actor, releaseId: string): Promise<void> {
    return this.releases.delete(repoId, actor, releaseId);
  }

  private async prepare(
    repoId: string,
    type: string,
    lang: string,
    input: { uid?: string | null; tags?: string[]; title?: string | null; data: Record<string, unknown> },
  ): Promise<PreparedVersion> {
    const [locale] = await this.sql`select 1 from locales where repo_id = ${repoId} and code = ${lang}`;
    if (!locale) throw new ValidationFailed([{ property: "lang", value: lang, error: `Unknown locale "${lang}"` }]);
    const model = (await this.models.getType(repoId, type)) as unknown as CustomType;
    const sharedSlices = new Map<string, SharedSlice>(
      (await this.models.listSlices(repoId)).map((s) => [s.id, s as unknown as SharedSlice]),
    );
    const { data, errors } = await normalizeDocumentData(model, sharedSlices, input.data, this.normalizeCtx);
    const uid = input.uid ?? null;
    if (uid !== null) {
      const e = validateUid(uid);
      if (e) errors.push(e);
    }
    if (errors.length) throw new ValidationFailed(errors);
    const { weightA, weightB } = extractSearchText(model, data, { sharedSlices, uid });
    return { uid, tags: input.tags ?? [], title: input.title ?? null, data, weightA, weightB };
  }

  private async insertVersion(t: Sql, repoId: string, id: string, actor: Actor, p: PreparedVersion, message: string | null) {
    const [row] = await t`
      insert into document_versions (document_id, repo_id, uid, tags, title, data, search_a, search_b, author_id, message)
      values (${id}, ${repoId}, ${p.uid}, ${p.tags}, ${p.title}, ${t.json(p.data as never)},
        ${tsvector(t, p.weightA)}, ${tsvector(t, p.weightB)}, ${actor}, ${message})
      returning id`;
    return String(row!.id);
  }
}
