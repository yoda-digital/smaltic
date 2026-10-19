import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigration, createWriteClient, ForbiddenError, InvalidDataError } from "@prismicio/client";
import Fastify from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentService, type StagingHooks } from "../src/domain/documents.js";
import { ModelService } from "../src/domain/models.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { ensureRetryAfter } from "../src/http/errors.js";
import { startServer } from "./helpers.js";

// The official WriteClient throttles every request with a body to one per 1500 ms per host.
const SLOW = 90_000;
const REPO = "migr-repo";

const textSlice = {
  id: "text_block",
  type: "SharedSlice",
  name: "TextBlock",
  variations: [
    {
      id: "default",
      name: "Default",
      docURL: "",
      version: "initial",
      description: "Default",
      imageUrl: "",
      primary: { text: { type: "StructuredText", config: { label: "Text", multi: "paragraph" } } },
      items: {},
    },
  ],
};
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
      image: { type: "Image", config: { label: "Image" } },
      related: { type: "Link", config: { label: "Related", select: "document" } },
      file: { type: "Link", config: { label: "File", select: "media" } },
      slices: { type: "Slices", fieldset: "Slice Zone", config: { choices: { text_block: { type: "SharedSlice" } } } },
    },
  },
};

const heading = (text: string) => [{ type: "heading1", text, spans: [] }];
const para = (text: string) => [{ type: "paragraph", text, spans: [] }];

let srv: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let fixture: string;
let repoId: string;
let writeToken: string;

const client = (token = writeToken) =>
  createWriteClient(REPO, {
    writeToken: token,
    documentAPIEndpoint: `${srv.baseUrl}/r/${REPO}/api/v2`,
    migrationAPIEndpoint: `${srv.baseUrl}/migration-api`,
    assetAPIEndpoint: `${srv.baseUrl}/asset-api`,
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "smaltic-assets-"));
  srv = await startServer({ config: { dataDir } });
  const repos = new RepositoryService(srv.sql);
  const repo = await repos.create({ name: REPO, masterLocale: { code: "en-us", name: "English" } });
  repoId = repo.id;
  await repos.addLocale(repoId, { code: "fr-fr", name: "French" });
  ({ token: writeToken } = await repos.createToken(repoId, "write", "migration"));
  const models = new ModelService(srv.sql);
  await models.insertSlice(repoId, textSlice);
  await models.insertType(repoId, pageType);
  fixture = join(dataDir, "fixture-pixel.png");
  await writeFile(fixture, await sharp({ create: { width: 3, height: 2, channels: 4, background: "#ff0000" } }).png().toBuffer());
}, SLOW);
afterAll(async () => {
  await srv?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("Migration API + Asset API via the official WriteClient", () => {
  it(
    "migrate() creates assets and drafts in the migration release; publishing makes them live",
    async () => {
      const wc = client();
      const migration = createMigration();
      const png = await readFile(fixture);
      const asset = migration.createAsset(png, "pixel.png", { alt: "A red pixel", credits: "Smaltic", tags: ["hero"] });

      const target = migration.createDocument(
        { type: "page", uid: "target", lang: "en-us", tags: [], data: { title: heading("Target") } },
        "Target",
      );
      const home = migration.createDocument(
        {
          type: "page",
          uid: "home",
          lang: "en-us",
          tags: ["landing"],
          data: {
            title: heading("Home"),
            image: asset,
            related: target,
            file: { link_type: "Media", id: asset, text: "the pixel" },
            slices: [{ slice_type: "text_block", variation: "default", primary: { text: para("Hello") }, items: [] }],
          },
        } as never,
        "Home",
      );
      const accueil = migration.createDocument(
        { type: "page", uid: "accueil", lang: "fr-fr", tags: [], data: { title: heading("Accueil"), related: target } } as never,
        "Accueil",
        { masterLanguageDocument: home },
      );

      await wc.migrate(migration);

      // Asset: row, blob on disk under dataDir/assets/<repo>/<id>_<filename>, served with long cache.
      const [a] = await srv.sql`select * from assets where repo_id = ${repoId}`;
      expect(a).toMatchObject({ filename: "pixel.png", extension: "png", kind: "image", mime: "image/png", width: 3, height: 2, alt: "A red pixel", credits: "Smaltic" });
      expect(Number(a!.size)).toBe(png.length);
      expect((await stat(join(dataDir, "assets", REPO, `${a!.id}_pixel.png`))).size).toBe(png.length);
      const tags = await srv.sql`select t.name from asset_tag_links l join asset_tags t on t.id = l.tag_id where l.asset_id = ${a!.id}`;
      expect(tags.map((t) => t.name)).toEqual(["hero"]);
      const served = await fetch(`${srv.baseUrl}/assets/${REPO}/${a!.id}_pixel.png?auto=format,compress&w=10`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(served.headers.get("cache-control")).toMatch(/max-age=31536000/);
      expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);

      // Documents: drafts only, all staged in the single open migration release.
      const ids = [home.document.id!, target.document.id!, accueil.document.id!];
      const docs = await srv.sql`select d.id, d.lang, d.group_id, d.live_version_id, v.uid, v.title, v.tags, v.data
        from documents d join document_versions v on v.id = d.draft_version_id where d.id = any(${ids})`;
      expect(docs).toHaveLength(3);
      expect(docs.every((d) => d.live_version_id === null)).toBe(true);
      const byId = new Map(docs.map((d) => [d.id as string, d]));
      const h = byId.get(home.document.id!)!;
      expect(h).toMatchObject({ uid: "home", title: "Home", tags: ["landing"] });
      expect(h.data.related).toMatchObject({ link_type: "Document", id: target.document.id });
      expect(h.data.image).toMatchObject({
        id: a!.id,
        url: `${srv.baseUrl}/assets/${REPO}/${a!.id}_pixel.png`,
        dimensions: { width: 3, height: 2 },
        alt: "A red pixel",
        copyright: "Smaltic",
      });
      // The client sends only {id, link_type, text} for a link to media: the server fills the rest.
      expect(h.data.file).toMatchObject({
        link_type: "Media", id: a!.id, kind: "image", name: "pixel.png", size: String(png.length), width: "3", height: "2", text: "the pixel",
        url: `${srv.baseUrl}/assets/${REPO}/${a!.id}_pixel.png`,
      });
      expect(h.data.slices[0]).toMatchObject({ slice_type: "text_block", variation: "default", primary: { text: para("Hello") } });

      const releases = await srv.sql`select id from releases where repo_id = ${repoId} and migration and status = 'open'`;
      expect(releases).toHaveLength(1);
      const staged = await srv.sql`select document_id from release_items where release_id = ${releases[0]!.id}`;
      expect(staged.map((s) => s.document_id).sort()).toEqual([...ids].sort());

      // Publish the migration release.
      expect(await wc.publishMigrationRelease()).toEqual({ totalItems: 3 });
      const live = await srv.sql`select id, group_id, live_version_id, draft_version_id from documents where id = any(${ids})`;
      expect(live.every((d) => d.live_version_id !== null && String(d.live_version_id) === String(d.draft_version_id))).toBe(true);
      const g = new Map(live.map((d) => [d.id as string, d.group_id as string]));
      expect(g.get(accueil.document.id!)).toBe(g.get(home.document.id!));
      expect(g.get(target.document.id!)).not.toBe(g.get(home.document.id!));
      const [rel] = await srv.sql`select status from releases where id = ${releases[0]!.id}`;
      expect(rel!.status).toBe("published");
    },
    SLOW,
  );

  it(
    "a wrong write token on the Migration API rejects with ForbiddenError",
    async () => {
      const migration = createMigration();
      migration.createDocument({ type: "page", uid: "nope", lang: "en-us", tags: [], data: {} } as never, "Nope");
      await expect(client("rf_write_wrong").migrate(migration)).rejects.toBeInstanceOf(ForbiddenError);
    },
    SLOW,
  );

  it(
    "invalid data rejects with InvalidDataError carrying field errors",
    async () => {
      const migration = createMigration();
      migration.createDocument({ type: "page", uid: "bad", lang: "en-us", tags: [], data: { title: 42 } } as never, "Bad");
      const err = await client().migrate(migration).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidDataError);
      const body = (err as InvalidDataError).response as unknown as { message: string; errors: Array<{ property: string }> };
      expect(body.errors.map((e) => e.property)).toContain("data.title");
    },
    SLOW,
  );
});

describe("Migration and Asset API HTTP contract", () => {
  const h = () => ({ repository: REPO, authorization: `Bearer ${writeToken}`, "content-type": "application/json" });

  it("POST /migration-api/documents returns 201 {id,title,type,lang,uid}; unknown type is a 400 field error", async () => {
    const ok = await srv.app.inject({
      method: "POST",
      url: "/migration-api/documents",
      headers: h(),
      payload: { title: "Direct", type: "page", uid: "direct", lang: "en-us", data: {} },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), title: "Direct", type: "page", lang: "en-us", uid: "direct" });

    const put = await srv.app.inject({ method: "PUT", url: `/migration-api/documents/${ok.json().id}/`, headers: h(), payload: { data: { title: heading("x") } } });
    expect(put.statusCode).toBe(200);

    const bad = await srv.app.inject({ method: "POST", url: "/migration-api/documents", headers: h(), payload: { type: "ghost", lang: "en-us", data: {} } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({
      message: expect.any(String),
      errors: expect.arrayContaining([{ property: "title", error: "The value must be a string" }, expect.objectContaining({ property: "type" })]),
    });

    const missing = await srv.app.inject({ method: "PUT", url: "/migration-api/documents/AAAAAAAAAAAAAAAA", headers: h(), payload: { data: {} } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ message: expect.any(String) });
  });

  it("Asset API: tags list/create, patch, auth errors as {error}", async () => {
    const created = await srv.app.inject({ method: "POST", url: "/asset-api/tags", headers: h(), payload: { name: "gallery" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: expect.any(String), name: "gallery", created_at: expect.any(Number), last_modified: expect.any(Number) });
    const list = await srv.app.inject({ method: "GET", url: "/asset-api/tags", headers: { repository: REPO, authorization: `Bearer ${writeToken}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((t: { name: string }) => t.name)).toContain("gallery");

    const [a] = await srv.sql`select id from assets where repo_id = ${repoId} limit 1`;
    const patched = await srv.app.inject({
      method: "PATCH",
      url: `/asset-api/assets/${a!.id}`,
      headers: h(),
      payload: { notes: "n", alt: "new alt", tags: [created.json().id] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      id: a!.id, notes: "n", alt: "new alt", kind: "image", width: 3, height: 2, extension: "png",
      url: expect.stringMatching(new RegExp(`/assets/${REPO}/${a!.id}_pixel\\.png$`)),
      tags: [expect.objectContaining({ name: "gallery" })],
    });
    expect(typeof patched.json().created_at).toBe("number");

    const notFound = await srv.app.inject({ method: "PATCH", url: "/asset-api/assets/AAAAAAAAAAAAAAAA", headers: h(), payload: { alt: "x" } });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: expect.any(String) });

    const unauth = await srv.app.inject({ method: "GET", url: "/asset-api/tags", headers: { repository: REPO, authorization: "Bearer nope" } });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json()).toEqual({ error: expect.any(String) });
  });

  it("GET /api/v2 lists the master locale first and the master ref", async () => {
    const res = await fetch(`${srv.baseUrl}/r/${REPO}/api/v2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.languages[0]).toEqual({ id: "en-us", name: "English", is_master: true });
    expect(body.languages[1]).toMatchObject({ id: "fr-fr" });
    expect(body.refs).toEqual([{ id: "master", ref: expect.any(String), label: "Master", isMasterRef: true }]);
  });

  it("asset files 404 for unknown ids and never leave the repo", async () => {
    expect((await srv.app.inject({ method: "GET", url: `/assets/${REPO}/AAAAAAAAAAAAAAAA_x.png` })).statusCode).toBe(404);
    expect((await srv.app.inject({ method: "GET", url: `/assets/other-repo/whatever` })).statusCode).toBe(404);
  });
});

describe("429 responses", () => {
  it("always carry Retry-After", async () => {
    const app = Fastify();
    app.addHook("onSend", ensureRetryAfter);
    app.get("/limited", async (_req, reply) => reply.code(429).send({ error: "slow down" }));
    const res = await app.inject({ method: "GET", url: "/limited" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("1");
    await app.close();
  });
});

describe("Fix 1: drafts are staged in the open migration release atomically", () => {
  let stageRepo: string;
  const hooks: StagingHooks = {};
  let staging: DocumentService;
  let plain: DocumentService;
  const once = (fn: () => Promise<void>) => {
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      await fn();
    };
  };
  const openRelease = async () =>
    (await srv.sql`select id from releases where repo_id = ${stageRepo} and migration and status = 'open'`).map((r) => r.id as string);
  const stagedIn = async (docId: string) =>
    (await srv.sql`select ri.release_id, r.status from release_items ri join releases r on r.id = ri.release_id
      where ri.document_id = ${docId}`).map((r) => ({ release: r.release_id as string, status: r.status as string }));
  const isLive = async (docId: string) => {
    const [d] = await srv.sql`select live_version_id, draft_version_id from documents where id = ${docId}`;
    return d!.live_version_id !== null && String(d!.live_version_id) === String(d!.draft_version_id);
  };
  const doc = (uid: string) => ({ type: "page", lang: "en-us", uid, title: uid, data: { title: heading(uid) } });

  beforeAll(async () => {
    const repos = new RepositoryService(srv.sql);
    stageRepo = (await repos.create({ name: "stage-repo", masterLocale: { code: "en-us", name: "English" } })).id;
    const models = new ModelService(srv.sql);
    await models.insertSlice(stageRepo, textSlice);
    await models.insertType(stageRepo, pageType);
    staging = new DocumentService(srv.sql, { testHooks: hooks });
    plain = new DocumentService(srv.sql);
  });

  it("a publish committing before the release lookup: the draft lands in a NEW open release and the next publish ships it", async () => {
    const a = await staging.create(stageRepo, null, doc("a"), { stageInMigrationRelease: true });
    const [r1] = await openRelease();
    expect(await stagedIn(a.id)).toEqual([{ release: r1, status: "open" }]);

    hooks.beforeMigrationLookup = once(async () => {
      await plain.publishRelease(stageRepo, null, r1!);
    });
    const b = await staging.create(stageRepo, null, doc("b"), { stageInMigrationRelease: true });
    hooks.beforeMigrationLookup = undefined;

    expect(await isLive(a.id)).toBe(true);
    const [r2] = await openRelease();
    expect(r2).toBeDefined();
    expect(r2).not.toBe(r1);
    expect(await stagedIn(b.id)).toEqual([{ release: r2, status: "open" }]);
    expect(await isLive(b.id)).toBe(false);

    await plain.publishRelease(stageRepo, null, r2!);
    expect(await isLive(b.id)).toBe(true);
  });

  it("a publish racing right after the release is locked waits for the staging tx and includes the draft (create and update)", async () => {
    const c = await staging.create(stageRepo, null, doc("c"), { stageInMigrationRelease: true });
    const [r3] = await openRelease();

    let pending: Promise<unknown> | undefined;
    hooks.afterMigrationLookup = once(async () => {
      pending = plain.publishRelease(stageRepo, null, r3!);
      await new Promise((r) => setTimeout(r, 300)); // let the publish block on the release row lock
    });
    const d = await staging.create(stageRepo, null, doc("d"), { stageInMigrationRelease: true });
    hooks.afterMigrationLookup = undefined;
    await pending;
    expect(await isLive(c.id)).toBe(true);
    expect(await isLive(d.id)).toBe(true);
    expect(await stagedIn(d.id)).toEqual([{ release: r3, status: "published" }]);

    // Update of a document already staged in the open release: the publish locks the release row then
    // the document rows; staging takes them in the same order, so this must not deadlock.
    const e = await staging.create(stageRepo, null, doc("e"), { stageInMigrationRelease: true });
    const [r4] = await openRelease();
    hooks.afterMigrationLookup = once(async () => {
      pending = plain.publishRelease(stageRepo, null, r4!);
      await new Promise((r) => setTimeout(r, 300));
    });
    const v2 = await staging.updateDraft(stageRepo, null, e.id, { data: { title: heading("e2") } }, { stageInMigrationRelease: true });
    hooks.afterMigrationLookup = undefined;
    await pending;
    const [row] = await srv.sql`select live_version_id from documents where id = ${e.id}`;
    expect(String(row!.live_version_id)).toBe(v2);
  });
});

/** Multipart body for app.inject, built by the platform FormData encoder. */
async function multipartPng(name: string) {
  const fd = new FormData();
  fd.append("file", new File([await readFile(fixture)], name, { type: "image/png" }));
  const r = new Request("http://x/", { method: "POST", body: fd });
  return { payload: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get("content-type")! };
}

describe("Fix 2 (R12): canonical asset URLs in content", () => {
  it("prefix (/r/<repo>) and repository-header addressing store the same canonical URL", async () => {
    const auth = { authorization: `Bearer ${writeToken}` };
    const upload = async (url: string, headers: Record<string, string>) => {
      const fd = new FormData();
      fd.append("file", new File([await readFile(fixture)], "same.png", { type: "image/png" }));
      const res = await fetch(`${srv.baseUrl}${url}`, { method: "POST", body: fd, headers });
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string; url: string };
    };
    const viaPrefix = await upload(`/r/${REPO}/asset-api/assets`, auth);
    const viaHeader = await upload(`/asset-api/assets`, { ...auth, repository: REPO });
    expect(viaPrefix.url).toBe(`${srv.baseUrl}/assets/${REPO}/${viaPrefix.id}_same.png`);
    expect(viaHeader.url).toBe(`${srv.baseUrl}/assets/${REPO}/${viaHeader.id}_same.png`);

    // Same through the Migration API: the id-only image is filled with the canonical URL either way.
    const stored: string[] = [];
    for (const [url, headers] of [
      [`/r/${REPO}/migration-api/documents`, auth],
      [`/migration-api/documents`, { ...auth, repository: REPO }],
    ] as const) {
      const res = await fetch(`${srv.baseUrl}${url}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ title: "canon", type: "page", lang: "en-us", data: { image: { id: viaPrefix.id } } }),
      });
      expect(res.status).toBe(201);
      const [row] = await srv.sql`select v.data from documents d join document_versions v on v.id = d.draft_version_id
        where d.id = ${(await res.json()).id}`;
      stored.push(row!.data.image.url);
    }
    expect(stored).toEqual([viaPrefix.url, viaPrefix.url]);
  });

  it("with SMALTIC_PUBLIC_URL configured a spoofed Host / X-Forwarded-Host never reaches stored content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smaltic-assets-"));
    const s2 = await startServer({ config: { dataDir: dir, publicUrl: "https://cms.example.com" } });
    try {
      const repos = new RepositoryService(s2.sql);
      const repo = await repos.create({ name: "canon-repo", masterLocale: { code: "en-us", name: "English" } });
      const { token } = await repos.createToken(repo.id, "write", "t");
      const models = new ModelService(s2.sql);
      await models.insertSlice(repo.id, textSlice);
      await models.insertType(repo.id, pageType);
      const spoof = { host: "evil.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "http", repository: "canon-repo", authorization: `Bearer ${token}` };

      const { payload, contentType } = await multipartPng("p.png");
      const up = await s2.app.inject({ method: "POST", url: "/asset-api/assets", headers: { ...spoof, "content-type": contentType }, payload });
      expect(up.statusCode).toBe(200);
      const asset = up.json() as { id: string; url: string };
      expect(asset.url).toBe(`https://cms.example.com/assets/canon-repo/${asset.id}_p.png`);
      const [a] = await s2.sql`select id from assets where id = ${asset.id}`;
      expect(a).toBeDefined();

      const created = await s2.app.inject({
        method: "POST",
        url: "/migration-api/documents",
        headers: spoof,
        payload: { title: "x", type: "page", lang: "en-us", data: { image: { id: asset.id }, file: { link_type: "Media", id: asset.id } } },
      });
      expect(created.statusCode).toBe(201);
      const [row] = await s2.sql`select v.data from documents d join document_versions v on v.id = d.draft_version_id
        where d.id = ${created.json().id}`;
      expect(row!.data.image.url).toBe(asset.url);
      expect(row!.data.file.url).toBe(asset.url);
      expect(JSON.stringify(row!.data)).not.toContain("evil.test");
    } finally {
      await s2.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
