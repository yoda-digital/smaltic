import {
  extractSearchText,
  newId,
  normalizeDocumentData,
  validateUid,
  type CustomType,
  type AssetInfo,
  type FieldError,
  type NormalizeCtx,
  type SharedSlice,
  type StoredData,
} from "@smaltic/model";
import type { Fragment, Sql } from "../db/index.js";
import { DomainEvents, type PublishedDoc } from "./events.js";
import { ModelService } from "./models.js";
import { DocumentNotFound, UidConflict, lockDocs, publishItems, type LiveItem } from "./publishing.js";
import { insertPublication, lockRepo, type MasterRef } from "./refs.js";
import {
  lockOpenMigrationRelease,
  ReleaseService,
  type CreateReleaseOpts,
  type LockedRelease,
  type Release,
} from "./releases.js";

type StagedIn = LockedRelease;

/** Stages (or re-stages) a draft version in a release locked by the caller's transaction. */
async function stageItem(t: Sql, release: LockedRelease, docId: string, versionId: string): Promise<StagedIn> {
  await t`insert into release_items (release_id, document_id, version_id) values (${release.id}, ${docId}, ${versionId})
    on conflict (release_id, document_id) do update set version_id = excluded.version_id`;
  return release;
}

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

/** Absolute URL for a server path (an asset's `/assets/...` path); usually `publicUrl` bound to the request. */
export type UrlFor = (path: string) => string;

/** Asset lookup scoped to a repository (AssetService.lookup when wired by buildApp). */
export type AssetLookup = (repoId: string, id: string, urlFor?: UrlFor) => Promise<AssetInfo | null>;

export interface DocumentServiceOpts {
  events?: DomainEvents;
  models?: ModelService;
  /** oEmbed / asset hooks for normalization. Default: no oEmbed resolution, every asset id accepted. */
  normalizeCtx?: NormalizeCtx;
  /** Real asset lookup; overrides `normalizeCtx` asset hooks so images and media links are validated and filled. */
  assets?: AssetLookup;
  /** Test-only interleaving points inside the staging transaction (see `WriteOpts.stageInMigrationRelease`). */
  testHooks?: StagingHooks;
}

export interface StagingHooks {
  /** In the write tx, before the open migration release is looked up and locked. */
  beforeMigrationLookup?: () => Promise<void>;
  /** In the write tx, right after the open migration release is locked (before staging). */
  afterMigrationLookup?: () => Promise<void>;
}

/** Per-call options of writes. */
export interface WriteOpts {
  /** How asset URLs are made absolute while filling id-only media (defaults to the lookup's own). */
  urlFor?: UrlFor;
  /**
   * Stage the new draft in the repo's single open migration release (opened on demand) in the SAME
   * transaction as the draft write, so a concurrent publish can never leave it outside an open release.
   */
  stageInMigrationRelease?: boolean;
}

/**
 * Text search configuration (migration 006: `simple` + `unaccent`); the one place to change it. Both the stored
 * vectors and the query side (src/query/compile.ts) go through `searchVector` / `searchQuery` below.
 */
export const SEARCH_CONFIG = "smaltic_search";
/** tsvector of a text value or SQL text expression. */
export const searchVector = (t: Sql, text: string | Fragment) => t`to_tsvector(${SEARCH_CONFIG}::regconfig, ${text}::text)`;
/** websearch-style tsquery (space-separated terms are ANDed) for user input. */
export const searchQuery = (t: Sql, text: string) => t`websearch_to_tsquery(${SEARCH_CONFIG}::regconfig, ${text}::text)`;
const tsvector = searchVector;

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
  private assets?: AssetLookup;
  private hooks: StagingHooks;
  private releases: ReleaseService;

  constructor(private sql: Sql, opts: DocumentServiceOpts = {}) {
    this.events = opts.events ?? new DomainEvents();
    this.models = opts.models ?? new ModelService(sql);
    this.normalizeCtx = opts.normalizeCtx ?? { resolveEmbed: () => null, assetExists: () => true };
    this.assets = opts.assets;
    this.hooks = opts.testHooks ?? {};
    this.releases = new ReleaseService(sql, this.events);
  }

  async create(repoId: string, actor: Actor, input: CreateDocumentInput, opts: WriteOpts = {}): Promise<{ id: string; versionId: string }> {
    const prepared = await this.prepare(repoId, input.type, input.lang, input, opts);
    const id = newId();
    let staged: StagedIn | null = null;
    const versionId = await tx(this.sql, async (t) => {
      // Release row first: the same lock order as ReleaseService.publish (release, then documents).
      const release = opts.stageInMigrationRelease ? await this.lockMigrationRelease(t, repoId) : null;
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
      if (release) staged = await stageItem(t, release, id, vid);
      return vid;
    });
    this.events.emit("documents.created", { repoId, actor, id, versionId });
    this.emitStaged(repoId, actor, staged);
    return { id, versionId };
  }

  /** Always inserts a new version and moves the draft pointer to it. Returns the version id. */
  async updateDraft(repoId: string, actor: Actor, id: string, input: UpdateDraftInput, opts: WriteOpts = {}): Promise<string> {
    // Carried-over uid/tags/title come from the current draft. Optimistic attempts read and normalize outside
    // the write tx (normalization may hit the network) and re-check under the row lock that the draft is still
    // the one read, retrying if not. The last attempt reads under the row lock, so it cannot lose an update
    // and cannot fail spuriously under contention.
    let versionId: string | null = null;
    let staged: StagedIn | null = null;
    // Release row before document rows: the same lock order as ReleaseService.publish.
    const stageLock = (t: Sql) => (opts.stageInMigrationRelease ? this.lockMigrationRelease(t, repoId) : Promise.resolve(null));
    const write = async (t: Sql, release: LockedRelease | null, prepared: PreparedVersion) => {
      const vid = await this.writeDraft(t, repoId, actor, id, prepared);
      if (release) staged = await stageItem(t, release, id, vid);
      return vid;
    };
    for (let attempt = 1; versionId === null; attempt++) {
      const pessimistic = attempt >= UPDATE_DRAFT_ATTEMPTS;
      versionId = pessimistic
        ? await tx(this.sql, async (t) => {
            const release = await stageLock(t);
            await lockDocs(t, repoId, [id]);
            const { prepared } = await this.prepareDraft(t, repoId, id, input, opts);
            return write(t, release, prepared);
          })
        : await (async () => {
            const { seenDraft, prepared } = await this.prepareDraft(this.sql, repoId, id, input, opts);
            return tx(this.sql, async (t) => {
              const release = await stageLock(t);
              const [locked] = await lockDocs(t, repoId, [id]);
              if (String(locked!.draft_version_id) !== seenDraft) return null;
              return write(t, release, prepared);
            });
          })();
    }
    this.events.emit("documents.updated", { repoId, actor, id, versionId });
    this.emitStaged(repoId, actor, staged);
    return versionId;
  }

  private async prepareDraft(q: Sql, repoId: string, id: string, input: UpdateDraftInput, opts: WriteOpts) {
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
    }, opts);
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
  /** The open migration release, if any. */
  findMigrationRelease(repoId: string): Promise<Release | null> {
    return this.releases.findOpenMigrationRelease(repoId);
  }

  /** Open migration release locked for this tx (created on demand), with the test hooks around the lookup. */
  private async lockMigrationRelease(t: Sql, repoId: string): Promise<LockedRelease> {
    await this.hooks.beforeMigrationLookup?.();
    const release = await lockOpenMigrationRelease(t, repoId);
    await this.hooks.afterMigrationLookup?.();
    return release;
  }

  private emitStaged(repoId: string, actor: Actor, staged: StagedIn | null): void {
    if (!staged) return;
    if (staged.created) this.events.emit("release.created", { repoId, actor, releaseId: staged.id, ref: staged.ref });
    this.events.emit("release.updated", { repoId, actor, releaseId: staged.id });
  }

  private async prepare(
    repoId: string,
    type: string,
    lang: string,
    input: { uid?: string | null; tags?: string[]; title?: string | null; data: Record<string, unknown> },
    opts: WriteOpts = {},
  ): Promise<PreparedVersion> {
    const [locale] = await this.sql`select 1 from locales where repo_id = ${repoId} and code = ${lang}`;
    if (!locale) throw new ValidationFailed([{ property: "lang", value: lang, error: `Unknown locale "${lang}"` }]);
    const model = (await this.models.getType(repoId, type)) as unknown as CustomType;
    const sharedSlices = new Map<string, SharedSlice>(
      (await this.models.listSlices(repoId)).map((s) => [s.id, s as unknown as SharedSlice]),
    );
    const assets = this.assets;
    const ctx: NormalizeCtx = assets
      ? { resolveEmbed: this.normalizeCtx.resolveEmbed, getAsset: (assetId) => assets(repoId, assetId, opts.urlFor) }
      : this.normalizeCtx;
    const { data, errors } = await normalizeDocumentData(model, sharedSlices, input.data, ctx);
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
