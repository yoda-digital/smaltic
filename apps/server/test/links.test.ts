import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { DocumentService } from "../src/domain/documents.js";
import { ModelService } from "../src/domain/models.js";
import { RefService } from "../src/domain/refs.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { search, type VersionRow } from "../src/query/compile.js";
import { parseQueries } from "../src/query/filterParser.js";
import { applyGraphQuery, parseGraphQuery } from "../src/query/graphQuery.js";
import {
  LinkParamError, loadModels, parseRoutes, renderDocuments, resolveUrl,
  type LinkOptions, type RenderEnv, type Route, type RoutableDoc,
} from "../src/query/links.js";
import type { RefScope } from "../src/query/visible.js";
import { createTestDb } from "./helpers.js";

const cr = (id: string) => ({ link_type: "Document", id });
const p = (text: string) => ({ type: "paragraph", text, spans: [] });
const h1 = (text: string) => [{ type: "heading1", text, spans: [] }];

const types = [
  {
    id: "page", label: "Page", repeatable: true, status: true,
    json: { Main: { uid: { type: "UID" }, title: { type: "StructuredText", config: { single: "heading1" } } } },
  },
  {
    id: "category", label: "Category", repeatable: true, status: true,
    json: { Main: { uid: { type: "UID" }, name: { type: "Text" } } },
  },
  {
    id: "company", label: "Company", repeatable: true, status: true,
    json: { Main: { uid: { type: "UID" }, label: { type: "Text" }, country: { type: "Text" } } },
  },
  {
    id: "author", label: "Author", repeatable: true, status: true,
    json: {
      Main: {
        uid: { type: "UID" },
        name: { type: "StructuredText", config: { multi: "paragraph" } },
        bio: { type: "Text" },
        company: { type: "Link", config: { select: "document", customtypes: ["company"] } },
      },
    },
  },
  {
    id: "blog", label: "Blog", repeatable: true, status: true,
    json: {
      Main: {
        uid: { type: "UID" },
        title: { type: "StructuredText", config: { single: "heading1" } },
        category: { type: "Link", config: { select: "document", customtypes: ["category"] } },
        // Model-level field selection, 2 levels: author -> company.
        author: {
          type: "Link",
          config: {
            select: "document",
            customtypes: [{ id: "author", fields: ["bio", { id: "company", customtypes: [{ id: "company", fields: ["label"] }] }] }],
          },
        },
        writer: { type: "Link", config: { select: "document" } },
        related: { type: "Link", config: { select: "document" } },
        credits: { type: "Group", config: { fields: { person: { type: "Link", config: { select: "document" } }, role: { type: "Text" } } } },
        body: {
          type: "Slices",
          config: {
            choices: {
              quote: { type: "Slice", "non-repeat": { who: { type: "Link", config: { select: "document" } } }, repeat: {} },
              cta: { type: "SharedSlice" },
            },
          },
        },
      },
    },
  },
];
const ctaSlice = {
  id: "cta", type: "SharedSlice", name: "Cta",
  variations: [{ id: "default", name: "Default", primary: { target: { type: "Link", config: { select: "document" } } }, items: {} }],
};

let db: Awaited<ReturnType<typeof createTestDb>>;
let repoId: string;
let svc: DocumentService;
let master: RefScope;
let env: RenderEnv;
const ids: Record<string, string> = {};

const routes: Route[] = [
  { type: "page", path: "/:lang?/:uid" },
  { type: "blog", path: "/blog/:category/:uid", resolvers: { category: "category" } },
];

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db.sql);
  const repos = new RepositoryService(db.sql);
  repoId = (await repos.create({ name: "links-repo", masterLocale: { code: "en-us", name: "English" } })).id;
  await repos.addLocale(repoId, { code: "fr-fr", name: "French" });
  const models = new ModelService(db.sql);
  await models.insertSlice(repoId, ctaSlice);
  for (const t of types) await models.insertType(repoId, t);
  svc = new DocumentService(db.sql);

  const add = async (uid: string, type: string, data: Record<string, unknown>, lang = "en-us") => {
    ids[uid] = (await svc.create(repoId, "u", { type, lang, uid, data })).id;
    await svc.publish(repoId, "u", [ids[uid]!]);
  };
  await add("tech", "category", { name: "Tech" });
  await add("acme", "company", { label: "ACME", country: "MD" });
  await add("ada", "author", { name: [p("Ada"), p("Lovelace")], bio: "Mathematician", company: cr(ids.acme!) });
  await add("home", "page", { title: h1("Home") });
  await add("accueil", "page", { title: h1("Accueil") }, "fr-fr");
  await add("gone", "page", { title: h1("Gone") });
  await add("post-1", "blog", {
    title: h1("First post"),
    category: cr(ids.tech!),
    author: cr(ids.ada!),
    writer: cr(ids.ada!),
    related: cr(ids.gone!),
    credits: [{ person: cr(ids.ada!), role: "editor" }],
    body: [
      { slice_type: "quote", primary: { who: cr(ids.ada!) }, items: [] },
      { slice_type: "cta", variation: "default", primary: { target: cr(ids.home!) }, items: [] },
    ],
  });
  await svc.unpublish(repoId, "u", [ids.gone!]);
  await svc.deleteArchived(repoId, "u", [ids.gone!]);

  master = { kind: "master", seq: (await new RefService(db.sql).currentMaster(repoId)).seq };
  env = { sql: db.sql, repoId, scope: master, masterLang: "en-us", models: await loadModels(db.sql, repoId) };
});
afterAll(async () => db.drop());

async function rows(q: string, lang = "*"): Promise<VersionRow[]> {
  return (await search(db.sql, repoId, master, { filters: parseQueries([q]), page: 1, pageSize: 100, lang })).rows;
}
async function renderOne(uid: string, opts: LinkOptions = {}) {
  const r = await rows(`[[at(document.id, "${ids[uid]}")]]`);
  const [out] = await renderDocuments(env, r, opts);
  return out! as { url: string | null; data: Record<string, any> };
}

describe("routes", () => {
  it("resolves :lang?, :uid and resolver keywords for documents and linked stubs", async () => {
    expect((await renderOne("home", { routes })).url).toBe("/home");
    expect((await renderOne("accueil", { routes })).url).toBe("/fr-fr/accueil");
    const post = await renderOne("post-1", { routes });
    expect(post.url).toBe("/blog/tech/post-1");
    expect(post.data.body[1].primary.target.url).toBe("/home");
    expect((await renderOne("ada", { routes })).url).toBeNull();
    expect((await renderOne("home")).url).toBeNull();
  });

  it("omits the url key on unmatched linked stubs", async () => {
    const post = await renderOne("post-1", { routes });
    expect(post.data.writer).not.toHaveProperty("url");
    expect(Object.keys(post.data.writer)).toEqual([
      "id", "type", "tags", "lang", "slug", "first_publication_date", "last_publication_date", "uid", "link_type", "key", "isBroken",
    ]);
    expect(post.data.writer).toMatchObject({ id: ids.ada, type: "author", uid: "ada", lang: "en-us", tags: [], isBroken: false });
    expect(post.data.writer.first_publication_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0000$/);
    expect(post.data.writer).not.toHaveProperty("data");
  });

  it("resolveUrl: first match wins, uid/lang scoping, 2-level resolvers, missing required keyword", () => {
    const docs: Record<string, RoutableDoc> = {
      root: { id: "root", type: "page", uid: "about-us", lang: "en-us", data: {} },
      mid: { id: "mid", type: "page", uid: "our-team", lang: "en-us", data: { parent: cr("root") } },
      leaf: { id: "leaf", type: "page", uid: "jane-doe", lang: "fr-fr", data: { parent: cr("mid") } },
    };
    const parent = (d: RoutableDoc, field: string) => {
      const v = d.data[field] as { id?: string } | undefined;
      return v?.id ? docs[v.id] ?? null : null;
    };
    const nested: Route[] = [{ type: "page", path: "/:grandparent?/:parent?/:uid", resolvers: { parent: "parent", grandparent: "parent.parent" } }];
    expect(resolveUrl(docs.leaf!, nested, parent, "en-us")).toBe("/about-us/our-team/jane-doe");
    expect(resolveUrl(docs.mid!, nested, parent, "en-us")).toBe("/about-us/our-team");
    expect(resolveUrl(docs.root!, nested, parent, "en-us")).toBe("/about-us");
    const scoped: Route[] = [
      { type: "page", uid: "about-us", path: "/" },
      { type: "page", lang: "fr-fr", path: "/fr/:uid" },
      { type: "page", path: "/:lang/:uid" },
    ];
    expect(resolveUrl(docs.root!, scoped, parent, "en-us")).toBe("/");
    expect(resolveUrl(docs.leaf!, scoped, parent, "en-us")).toBe("/fr/jane-doe");
    expect(resolveUrl(docs.mid!, scoped, parent, "en-us")).toBe("/en-us/our-team");
    expect(resolveUrl(docs.root!, [{ type: "page", path: "/:parent/:uid", resolvers: { parent: "parent" } }], parent, "en-us")).toBeNull();
    expect(resolveUrl(docs.root!, [{ type: "blog", path: "/:uid" }], parent, "en-us")).toBeNull();
  });

  it("parseRoutes validates the JSON", () => {
    expect(parseRoutes('[{"type":"page","path":"/:uid"}]')).toEqual([{ type: "page", path: "/:uid" }]);
    expect(() => parseRoutes("[{")).toThrow(LinkParamError);
    expect(() => parseRoutes('[{"type":"page"}]')).toThrow(LinkParamError);
  });
});

describe("linked data selection", () => {
  it("fetchLinks=author.name populates data at depth (group and slice), rich text first block only", async () => {
    const post = await renderOne("post-1", { fetchLinks: "author.name" });
    const expected = { name: [{ type: "paragraph", text: "Ada", spans: [] }] };
    expect(post.data.writer.data).toEqual(expected);
    expect(post.data.credits[0].person.data).toEqual(expected);
    expect(post.data.body[0].primary.who.data).toEqual(expected);
    expect(post.data.category).not.toHaveProperty("data");
    // Key order: data sits between uid/url and link_type.
    expect(Object.keys(post.data.writer).slice(-5)).toEqual(["uid", "data", "link_type", "key", "isBroken"]);
  });

  it("fetchLinks accepts the bracketed list and group sub-fields", async () => {
    const post = await renderOne("post-1", { fetchLinks: "[author.bio, category.name]" });
    expect(post.data.writer.data).toEqual({ bio: "Mathematician" });
    expect(post.data.category.data).toEqual({ name: "Tech" });
  });

  it("model field selection nests 2 levels without any query param", async () => {
    const post = await renderOne("post-1");
    expect(post.data.author.data).toEqual({
      bio: "Mathematician",
      company: expect.objectContaining({ id: ids.acme, type: "company", data: { label: "ACME" }, isBroken: false }),
    });
    // Only the field carrying the selection gets data.
    expect(post.data.writer).not.toHaveProperty("data");
  });

  it("graphQuery returns only selected fields and linked data", async () => {
    const post = await renderOne("post-1", { graphQuery: "{ blog { title author { ...on author { name } } } }" });
    expect(Object.keys(post.data)).toEqual(["title", "author"]);
    expect(post.data.author.data).toEqual({ name: [p("Ada"), p("Lovelace")] });
  });

  it("graphQuery selects slices by type with primary and variation", async () => {
    const post = await renderOne("post-1", {
      graphQuery: "{ blog { body { ...on cta { variation primary { target { ...on page { title } } } } } } }",
    });
    expect(post.data.body).toHaveLength(1);
    expect(post.data.body[0]).toMatchObject({ slice_type: "cta", variation: "default" });
    expect(post.data.body[0].primary.target.data).toEqual({ title: h1("Home") });
  });

  it("deprecated fetch=blog.title returns only title", async () => {
    const post = await renderOne("post-1", { fetch: "blog.title" });
    expect(post.data).toEqual({ title: h1("First post") });
  });

  it("a link to a deleted document renders a broken stub, with brokenRoute as url", async () => {
    const post = await renderOne("post-1", { routes });
    expect(post.data.related).toEqual({ id: ids.gone, type: "broken", link_type: "Document", key: expect.any(String), isBroken: true });
    const withRoute = await renderOne("post-1", { routes, brokenRoute: "/404" });
    expect(withRoute.data.related).toMatchObject({ type: "broken", url: "/404", isBroken: true });
  });

  it("rejects malformed fetchLinks / graphQuery", async () => {
    await expect(renderOne("post-1", { graphQuery: "{ blog { title " })).rejects.toThrow(LinkParamError);
    await expect(renderOne("post-1", { fetchLinks: "author" })).rejects.toThrow(LinkParamError);
  });
});

describe("graphQuery unit", () => {
  it("parses spreads and unions and projects without mutating input", () => {
    const sel = parseGraphQuery("{ blog { ...blogFields } page { title } }");
    const data = { title: h1("t"), body: [] as unknown[], extra: 1 };
    expect(applyGraphQuery(sel, data, "blog")).toEqual(data);
    const out = applyGraphQuery(sel, data, "page");
    expect(out).toEqual({ title: h1("t") });
    expect(out).not.toBe(data);
    expect(data.extra).toBe(1);
  });
});

describe("assets (R12)", () => {
  it("rebuilds image urls from the asset id, keeping the query string", async () => {
    await db.sql`insert into assets (id, repo_id, filename, extension, kind, mime, size, storage_key)
      values ('ASSET00000000001', ${repoId}, 'pic.png', 'png', 'image', 'image/png', 10, 'k')`;
    await new ModelService(db.sql).insertType(repoId, {
      id: "gallery", label: "Gallery", repeatable: true, status: true,
      json: { Main: { uid: { type: "UID" }, photo: { type: "Image" }, lost: { type: "Image" } } },
    });
    const { id } = await svc.create(repoId, "u", {
      type: "gallery", lang: "en-us", uid: "g1",
      data: {
        photo: { id: "ASSET00000000001", url: "https://old.test/x/pic.png?auto=format", dimensions: { width: 1, height: 1 }, alt: null, copyright: null },
        lost: { id: "MISSING000000001", url: "https://old.test/x/lost.png", dimensions: { width: 1, height: 1 }, alt: null, copyright: null },
      },
    });
    await svc.publish(repoId, "u", [id]);
    const scope: RefScope = { kind: "master", seq: (await new RefService(db.sql).currentMaster(repoId)).seq };
    const r = (await search(db.sql, repoId, scope, { filters: parseQueries([`[[at(document.id, "${id}")]]`]), page: 1, pageSize: 1, lang: "*" })).rows;
    const [out] = await renderDocuments(
      { ...env, scope, models: await loadModels(db.sql, repoId), assetOrigin: "https://cms.test", repoName: "links-repo" },
      r,
      {},
    );
    expect((out!.data.photo as { url: string }).url).toBe("https://cms.test/assets/links-repo/ASSET00000000001_pic.png?auto=format");
    expect((out!.data.lost as { url: string }).url).toBe("https://old.test/x/lost.png");
  });
});

describe("batching", () => {
  it("20 results with 40 links issue <= 3 SQL statements for linked docs", async () => {
    const cats: string[] = [];
    for (let i = 0; i < 40; i++) {
      cats.push((await svc.create(repoId, "u", { type: "category", lang: "en-us", uid: `cat-${i}`, data: { name: `C${i}` } })).id);
    }
    const posts: string[] = [];
    for (let i = 0; i < 20; i++) {
      posts.push((await svc.create(repoId, "u", {
        type: "blog", lang: "en-us", uid: `bulk-${i}`,
        data: { title: h1(`Bulk ${i}`), category: cr(cats[2 * i]!), writer: cr(cats[2 * i + 1]!) },
      })).id);
    }
    await svc.publish(repoId, "u", [...cats, ...posts]);
    const scope: RefScope = { kind: "master", seq: (await new RefService(db.sql).currentMaster(repoId)).seq };
    const r = (await search(db.sql, repoId, scope, { filters: parseQueries(['[[at(document.type, "blog")]]', '[[fulltext(document, "bulk")]]']), page: 1, pageSize: 20, lang: "en-us" })).rows;
    expect(r).toHaveLength(20);

    let statements = 0;
    const counting = postgres(db.url, { max: 1, onnotice: () => {}, debug: () => { statements++; } });
    try {
      const models = await loadModels(db.sql, repoId);
      const out = await renderDocuments({ ...env, sql: counting, scope, models }, r, { routes, fetchLinks: "category.name" });
      expect(statements).toBeGreaterThanOrEqual(1);
      expect(statements).toBeLessThanOrEqual(3);
      for (const d of out) {
        expect(d.url).toMatch(/^\/blog\/cat-\d+\/bulk-\d+$/);
        expect((d.data.category as { isBroken: boolean; data: unknown }).isBroken).toBe(false);
        expect((d.data.category as { data: unknown }).data).toEqual({ name: expect.stringMatching(/^C\d+$/) });
        expect((d.data.writer as { isBroken: boolean }).isBroken).toBe(false);
      }
    } finally {
      await counting.end();
    }
  });
});
