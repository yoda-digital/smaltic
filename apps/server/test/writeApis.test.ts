import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigration, createWriteClient, ForbiddenError, InvalidDataError } from "@prismicio/client";
import Fastify from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
