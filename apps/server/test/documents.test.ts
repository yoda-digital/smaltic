import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import {
  DocumentNotFound,
  DocumentService,
  NotArchived,
  ReleaseNotOpen,
  UidConflict,
  ValidationFailed,
} from "../src/domain/documents.js";
import { DomainEvents } from "../src/domain/events.js";
import { HasExistingDocuments, ModelService } from "../src/domain/models.js";
import { lockRepo, RefService } from "../src/domain/refs.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { createTestDb } from "./helpers.js";

const pageType = {
  id: "page",
  label: "Page",
  repeatable: true,
  status: true,
  format: "page",
  json: {
    Main: {
      uid: { type: "UID", config: { label: "UID" } },
      title: { type: "StructuredText", config: { label: "Title", single: "heading1" } },
      body: { type: "StructuredText", config: { label: "Body", multi: "paragraph" } },
    },
  },
};
const otherType = { ...pageType, id: "post", label: "Post" };

const title = (text: string) => [{ type: "heading1", text, spans: [] }];
const body = (text: string) => [{ type: "paragraph", text, spans: [] }];
const ACTOR = "user-1";

let db: Awaited<ReturnType<typeof createTestDb>>;
let svc: DocumentService;
let refs: RefService;
let events: DomainEvents;
let models: ModelService;
const seen: Array<{ name: string; payload: unknown }> = [];

async function newRepo(name: string): Promise<string> {
  const r = await new RepositoryService(db.sql).create({ name, masterLocale: { code: "en-us", name: "English" } });
  await new RepositoryService(db.sql).addLocale(r.id, { code: "fr-fr", name: "French" });
  await models.insertType(r.id, pageType);
  await models.insertType(r.id, otherType);
  return r.id;
}

const versionRows = () => db.sql`select * from document_versions order by id`;

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db.sql);
  events = new DomainEvents();
  for (const name of ["documents.published", "documents.unpublished", "release.published", "release.created"] as const) {
    events.on(name, (payload) => seen.push({ name, payload }));
  }
  models = new ModelService(db.sql);
  svc = new DocumentService(db.sql, { events });
  refs = new RefService(db.sql);
});
afterAll(async () => db.drop());

describe("DocumentService lifecycle", () => {
  it("create -> publish -> updateDraft -> publish -> unpublish -> deleteArchived, never updating versions", async () => {
    const repoId = await newRepo("lifecycle");
    const m0 = await refs.currentMaster(repoId);
    expect(m0.ref).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const { id } = await svc.create(repoId, ACTOR, {
      type: "page", lang: "en-us", uid: "hello", tags: ["a"], title: "Hello", data: { title: title("Hello"), body: body("World") },
    });
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const [created] = await db.sql`select * from document_versions where document_id = ${id}`;
    expect(created!.data.title[0].text).toBe("Hello");
    expect(created!.author_id).toBe(ACTOR);
    expect(String(created!.search_a)).toContain("hello");
    expect(String(created!.search_b)).toContain("world");

    const snap1 = await versionRows();
    const p1 = await svc.publish(repoId, ACTOR, [id]);
    expect(p1.ref).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(p1.ref).not.toBe(m0.ref);
    expect(BigInt(p1.seq)).toBeGreaterThan(BigInt(m0.seq));
    expect(await refs.currentMaster(repoId)).toEqual(p1);
    const [d1] = await db.sql`select * from documents where id = ${id}`;
    expect(d1!.live_version_id).toBe(d1!.draft_version_id);
    expect(d1!.first_publication_date).toBeInstanceOf(Date);
    expect(+d1!.last_publication_date).toBe(+d1!.first_publication_date);
    expect(seen.find((e) => e.name === "documents.published" && (e.payload as { ref: string }).ref === p1.ref)).toBeTruthy();

    const v2 = await svc.updateDraft(repoId, ACTOR, id, { uid: "hello", data: { title: title("Hello 2") } });
    const [d2] = await db.sql`select * from documents where id = ${id}`;
    expect(d2!.draft_version_id).toBe(v2);
    expect(d2!.live_version_id).toBe(d1!.live_version_id);

    const p2 = await svc.publish(repoId, ACTOR, [id]);
    expect(BigInt(p2.seq)).toBeGreaterThan(BigInt(p1.seq));
    const [d3] = await db.sql`select * from documents where id = ${id}`;
    expect(d3!.live_version_id).toBe(v2);
    expect(+d3!.first_publication_date).toBe(+d1!.first_publication_date);
    expect(+d3!.last_publication_date).toBeGreaterThanOrEqual(+d1!.last_publication_date);

    const ranges = await db.sql`select version_id, from_seq, to_seq from live_ranges where document_id = ${id} order by from_seq`;
    expect(ranges.map((r) => [r.version_id, r.from_seq, r.to_seq])).toEqual([
      [d1!.live_version_id, p1.seq, p2.seq],
      [v2, p2.seq, null],
    ]);

    await expect(svc.deleteArchived(repoId, ACTOR, [id])).rejects.toBeInstanceOf(NotArchived);
    const p3 = await svc.unpublish(repoId, ACTOR, [id]);
    expect(BigInt(p3.seq)).toBeGreaterThan(BigInt(p2.seq));
    const [d4] = await db.sql`select * from documents where id = ${id}`;
    expect(d4!.live_version_id).toBeNull();
    expect(d4!.archived_at).toBeInstanceOf(Date);
    const [open] = await db.sql`select count(*)::int as n from live_ranges where document_id = ${id} and to_seq is null`;
    expect(open!.n).toBe(0);

    // Republish after unpublish opens a third range and clears archived_at.
    const p4 = await svc.publish(repoId, ACTOR, [id]);
    const [dr] = await db.sql`select * from documents where id = ${id}`;
    expect(dr!.archived_at).toBeNull();
    expect(dr!.live_version_id).toBe(v2);
    const ranges2 = await db.sql`select version_id, from_seq, to_seq from live_ranges where document_id = ${id} order by from_seq`;
    expect(ranges2.map((r) => [r.version_id, r.from_seq, r.to_seq])).toEqual([
      [d1!.live_version_id, p1.seq, p2.seq],
      [v2, p2.seq, p3.seq],
      [v2, p4.seq, null],
    ]);
    await svc.unpublish(repoId, ACTOR, [id]);

    await svc.deleteArchived(repoId, ACTOR, [id]);
    const [d5] = await db.sql`select * from documents where id = ${id}`;
    expect(d5!.deleted_at).toBeInstanceOf(Date);
    await expect(svc.updateDraft(repoId, ACTOR, id, { data: {} })).rejects.toBeInstanceOf(DocumentNotFound);

    // Immutability: every row that existed before is still deep-equal afterwards.
    const after = await versionRows();
    expect(after.slice(0, snap1.length)).toEqual(snap1);
    expect(after.length).toBe(snap1.length + 1);
  });

  it("restoreVersion copies a version as a new draft and listVersions lists them", async () => {
    const repoId = await newRepo("restore");
    const { id } = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", data: { title: title("v1") } });
    const [v1] = (await svc.listVersions(repoId, id)).map((v) => v.id);
    await svc.updateDraft(repoId, ACTOR, id, { data: { title: title("v2") } });
    const v3 = await svc.restoreVersion(repoId, ACTOR, id, v1!);
    const versions = await svc.listVersions(repoId, id);
    expect(versions.map((v) => (v.data.title as Array<{ text: string }>)[0]!.text)).toEqual(["v1", "v2", "v1"]);
    expect(versions[2]!.id).toBe(v3);
    expect(versions[2]!.isDraft).toBe(true);
  });

  it("rejects invalid data and unknown locales", async () => {
    const repoId = await newRepo("invalid");
    await expect(svc.create(repoId, ACTOR, { type: "page", lang: "en-us", data: { title: 42 } })).rejects.toBeInstanceOf(ValidationFailed);
    await expect(svc.create(repoId, ACTOR, { type: "page", lang: "en-us", uid: "Bad Uid", data: {} })).rejects.toBeInstanceOf(ValidationFailed);
    await expect(svc.create(repoId, ACTOR, { type: "page", lang: "xx-xx", data: {} })).rejects.toBeInstanceOf(ValidationFailed);
  });

  it("alternateOf joins the group", async () => {
    const repoId = await newRepo("alternates");
    const en = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", data: {} });
    const fr = await svc.create(repoId, ACTOR, { type: "page", lang: "fr-fr", data: {}, alternateOf: en.id });
    const rows = await db.sql`select id, group_id from documents where id in ${db.sql([en.id, fr.id])}`;
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
  });
});

describe("updateDraft concurrency", () => {
  it("a partial updateDraft racing a committed update keeps the committed uid/tags/title", async () => {
    const repoId = await newRepo("draftrace");
    const { id } = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", uid: "orig", tags: ["t0"], title: "T0", data: {} });
    let release!: () => void;
    const go = new Promise<void>((r) => (release = r));
    let holderReady!: () => void;
    const ready = new Promise<void>((r) => (holderReady = r));
    // Separate connection: lock the document row and stage a full update (uid "first") without committing.
    const holder = db.sql.begin(async (t) => {
      await t`select 1 from documents where id = ${id} for update`;
      const [v] = await t`insert into document_versions (document_id, repo_id, uid, tags, title, data, search_a, search_b, author_id)
        values (${id}, ${repoId}, 'first', ${["t1"]}, 'T1', '{}'::jsonb, to_tsvector('simple', 'first'), to_tsvector('simple', ''), 'other')
        returning id`;
      await t`update documents set draft_version_id = ${v!.id} where id = ${id}`;
      holderReady();
      await go;
    });
    await ready;
    // Partial update (no uid/tags/title): reads the old draft ("orig"), then blocks on the row lock.
    const racing = svc.updateDraft(repoId, ACTOR, id, { data: { title: title("racing") } });
    for (let i = 0; i < 200; i++) {
      const [w] = await db.sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`;
      if (w!.n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await holder;
    const vid = await racing;
    const [v] = await db.sql`select uid, tags, title, data, search_a from document_versions where id = ${vid}`;
    expect(v!.uid).toBe("first");
    expect(v!.tags).toEqual(["t1"]);
    expect(v!.title).toBe("T1");
    expect(v!.data.title[0].text).toBe("racing");
    expect(String(v!.search_a)).toContain("first");
    const [d] = await db.sql`select draft_version_id from documents where id = ${id}`;
    expect(d!.draft_version_id).toBe(vid);
  });
});

describe("UID uniqueness", () => {
  it("UID collision on publish rejects with UidConflict", async () => {
    const repoId = await newRepo("uids");
    const a = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", uid: "same", data: {} });
    const b = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", uid: "same", data: {} });
    // Same uid in another lang and another type is fine.
    const c = await svc.create(repoId, ACTOR, { type: "page", lang: "fr-fr", uid: "same", data: {} });
    const d = await svc.create(repoId, ACTOR, { type: "post", lang: "en-us", uid: "same", data: {} });
    await svc.publish(repoId, ACTOR, [a.id, c.id, d.id]);
    const before = await refs.currentMaster(repoId);
    await expect(svc.publish(repoId, ACTOR, [b.id])).rejects.toBeInstanceOf(UidConflict);
    expect(await refs.currentMaster(repoId)).toEqual(before);
    // Within one batch too.
    const e = await svc.create(repoId, ACTOR, { type: "post", lang: "fr-fr", uid: "dup", data: {} });
    const f = await svc.create(repoId, ACTOR, { type: "post", lang: "fr-fr", uid: "dup", data: {} });
    await expect(svc.publish(repoId, ACTOR, [e.id, f.id])).rejects.toBeInstanceOf(UidConflict);
    // Once the holder is unpublished, the uid is free.
    await svc.unpublish(repoId, ACTOR, [a.id]);
    await expect(svc.publish(repoId, ACTOR, [b.id])).resolves.toBeTruthy();
  });
});

describe("releases", () => {
  it("releases don't affect master until publishRelease", async () => {
    const repoId = await newRepo("releases");
    const { id } = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", data: { title: title("live") } });
    await svc.publish(repoId, ACTOR, [id]);
    const fresh = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", data: { title: title("new") } });

    const rel = await svc.createRelease(repoId, ACTOR, "Spring");
    expect(rel.ref).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const staged = await svc.updateDraft(repoId, ACTOR, id, { data: { title: title("staged") } });
    await svc.addToRelease(repoId, ACTOR, rel.id, id);
    await svc.addToRelease(repoId, ACTOR, rel.id, fresh.id);
    await svc.removeFromRelease(repoId, ACTOR, rel.id, fresh.id);
    await svc.addToRelease(repoId, ACTOR, rel.id, fresh.id);
    // Draft moves on after snapshot; the release keeps the snapshot.
    const later = await svc.updateDraft(repoId, ACTOR, id, { data: { title: title("later") } });

    const master = await refs.currentMaster(repoId);
    const [doc] = await db.sql`select live_version_id from documents where id = ${id}`;
    expect(doc!.live_version_id).not.toBe(staged);
    const [fd] = await db.sql`select live_version_id from documents where id = ${fresh.id}`;
    expect(fd!.live_version_id).toBeNull();

    const pub = await svc.publishRelease(repoId, ACTOR, rel.id);
    expect(BigInt(pub.seq)).toBeGreaterThan(BigInt(master.seq));
    expect(await refs.currentMaster(repoId)).toEqual(pub);
    const [after] = await db.sql`select live_version_id, draft_version_id from documents where id = ${id}`;
    expect(after!.live_version_id).toBe(staged);
    expect(after!.draft_version_id).toBe(later);
    const [fa] = await db.sql`select live_version_id from documents where id = ${fresh.id}`;
    expect(fa!.live_version_id).not.toBeNull();
    const [r] = await db.sql`select status from releases where id = ${rel.id}`;
    expect(r!.status).toBe("published");
    await expect(svc.addToRelease(repoId, ACTOR, rel.id, id)).rejects.toBeInstanceOf(ReleaseNotOpen);
    expect(seen.some((e) => e.name === "release.published")).toBe(true);

    const gone = await svc.createRelease(repoId, ACTOR, "Gone");
    await svc.deleteRelease(repoId, ACTOR, gone.id);
    await expect(svc.publishRelease(repoId, ACTOR, gone.id)).rejects.toBeInstanceOf(ReleaseNotOpen);
  });
});

describe("concurrency", () => {
  it("concurrent publishes are serialized", async () => {
    const repoId = await newRepo("concurrent");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", data: {} })).id);
    // Half the publishes target a shared document so ranges for it must chain without overlap.
    const shared = ids[0]!;
    const results = await Promise.all(
      ids.map(async (id, i) => {
        if (i % 2 === 0) await svc.updateDraft(repoId, ACTOR, shared, { data: { title: title(`s${i}`) } });
        return svc.publish(repoId, ACTOR, i % 2 === 0 ? [shared, id] : [id]);
      }),
    );
    expect(new Set(results.map((r) => r.ref)).size).toBe(10);
    const seqs = results.map((r) => BigInt(r.seq)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);
    const pubs = await db.sql`select seq from publications where repo_id = ${repoId} order by seq`;
    expect(pubs.map((p) => p.seq)).toEqual([...pubs.map((p) => p.seq)].sort((a, b) => Number(a) - Number(b)));

    const ranges = await db.sql`select document_id, from_seq, to_seq from live_ranges where repo_id = ${repoId}
      order by document_id, from_seq`;
    const byDoc = new Map<string, Array<{ from: bigint; to: bigint | null }>>();
    for (const r of ranges) {
      const list = byDoc.get(r.document_id) ?? [];
      list.push({ from: BigInt(r.from_seq), to: r.to_seq === null ? null : BigInt(r.to_seq) });
      byDoc.set(r.document_id, list);
    }
    expect(byDoc.size).toBe(10);
    for (const list of byDoc.values()) {
      expect(list.filter((r) => r.to === null)).toHaveLength(1);
      for (let i = 1; i < list.length; i++) expect(list[i - 1]!.to).toBe(list[i]!.from);
      for (const r of list) if (r.to !== null) expect(r.to > r.from).toBe(true);
    }
  });

  it("publish waits for the repo lock held by another publisher", async () => {
    const repoId = await newRepo("lockwait");
    const { id } = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", data: {} });
    const order: string[] = [];
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db.sql.begin(async (t) => {
      await lockRepo(t as unknown as typeof db.sql, repoId);
      locked();
      await new Promise((r) => setTimeout(r, 300));
      order.push("holder");
    });
    await isLocked;
    const pub = svc.publish(repoId, ACTOR, [id]).then(() => order.push("publish"));
    await Promise.all([holder, pub]);
    expect(order).toEqual(["holder", "publish"]);
  });
});

describe("ModelService.removeType with real document count", () => {
  it("rejects with HasExistingDocuments when a document of that type exists", async () => {
    const repoId = await newRepo("counting");
    await svc.create(repoId, ACTOR, { type: "post", lang: "en-us", data: {} });
    await expect(models.removeType(repoId, "post")).rejects.toBeInstanceOf(HasExistingDocuments);
    // A deleted document no longer counts.
    const { id } = await svc.create(repoId, ACTOR, { type: "page", lang: "en-us", data: {} });
    await svc.unpublish(repoId, ACTOR, [id]);
    await svc.deleteArchived(repoId, ACTOR, [id]);
    await expect(models.removeType(repoId, "page")).resolves.toBeUndefined();
  });
});
