import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { DocumentService } from "../src/domain/documents.js";
import { ModelService } from "../src/domain/models.js";
import { RefService } from "../src/domain/refs.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { search, type SearchParams } from "../src/query/compile.js";
import { parseQueries, QueryParseError } from "../src/query/filterParser.js";
import type { RefScope } from "../src/query/visible.js";
import { createTestDb } from "./helpers.js";

const productType = {
  id: "product",
  label: "Product",
  repeatable: true,
  status: true,
  json: {
    Main: {
      uid: { type: "UID", config: { label: "UID" } },
      title: { type: "StructuredText", config: { label: "Title", single: "heading1" } },
      body: { type: "StructuredText", config: { label: "Body", multi: "paragraph" } },
      price: { type: "Number", config: { label: "Price" } },
      released: { type: "Date", config: { label: "Released" } },
      launch: { type: "Timestamp", config: { label: "Launch" } },
      color: { type: "Select", config: { label: "Color", options: ["red", "green", "blue"] } },
      featured: { type: "Boolean", config: { label: "Featured" } },
      location: { type: "GeoPoint", config: { label: "Location" } },
      related: { type: "Link", config: { label: "Related", select: "document" } },
      site: { type: "Link", config: { label: "Site", select: "web" } },
      photo: { type: "Image", config: { label: "Photo" } },
      variants: {
        type: "Group",
        config: {
          label: "Variants",
          fields: { sku: { type: "Text", config: { label: "SKU" } }, size: { type: "Number", config: { label: "Size" } } },
        },
      },
    },
  },
};
const articleType = {
  id: "article",
  label: "Article",
  repeatable: true,
  status: true,
  json: {
    Main: {
      uid: { type: "UID", config: { label: "UID" } },
      title: { type: "StructuredText", config: { label: "Title", single: "heading1" } },
      body: { type: "StructuredText", config: { label: "Body", multi: "paragraph" } },
    },
  },
};

const h1 = (text: string) => [{ type: "heading1", text, spans: [] }];
const p = (text: string) => [{ type: "paragraph", text, spans: [] }];
const cr = (id: string) => ({ link_type: "Document", id });

let db: Awaited<ReturnType<typeof createTestDb>>;
let repoId: string;
let svc: DocumentService;
let refs: RefService;
const ids: Record<string, string> = {};
const uidOf = new Map<string, string>();
let historicSeq: string;
let master: RefScope;

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db.sql);
  const repos = new RepositoryService(db.sql);
  const r = await repos.create({ name: "search-repo", masterLocale: { code: "en-us", name: "English" } });
  repoId = r.id;
  await repos.addLocale(repoId, { code: "fr-fr", name: "French" });
  const models = new ModelService(db.sql);
  await models.insertType(repoId, productType);
  await models.insertType(repoId, articleType);
  svc = new DocumentService(db.sql);
  refs = new RefService(db.sql, { secret: "test-secret" });

  const add = async (uid: string, type: string, data: Record<string, unknown>, opts: { lang?: string; tags?: string[]; alt?: string; publish?: boolean } = {}) => {
    const { id } = await svc.create(repoId, "u", {
      type, lang: opts.lang ?? "en-us", uid, tags: opts.tags ?? [], data,
      ...(opts.alt ? { alternateOf: ids[opts.alt] } : {}),
    });
    ids[uid] = id;
    uidOf.set(id, uid);
    if (opts.publish !== false) await svc.publish(repoId, "u", [id]);
  };
  // Publish order = default order reversed (last_publication_date desc).
  await add("intro", "article", { title: h1("Introduction"), body: p("Welcome to the coffee shop") });
  await add("news", "article", { title: h1("News"), body: p("Tea arrived") });
  await add("kishinev", "article", { title: h1("Кишинёв"), body: p("City guide") });
  historicSeq = (await refs.currentMaster(repoId)).seq;
  await add("cafe-culture", "article", { title: h1("Café culture"), body: p("About coffee") });
  await add("alpha", "product", {
    title: h1("Alpha Café"), body: p("Fresh coffee beans"), price: 10, released: "2024-01-15",
    launch: "2024-03-05T08:30:00+0000", color: "red", featured: true, location: { latitude: 48.8566, longitude: 2.3522 },
    related: cr(ids.intro!), variants: [{ sku: "A-S", size: 1 }, { sku: "A-L", size: 3 }],
  }, { tags: ["food", "hot"] });
  await add("beta", "product", {
    title: h1("Beta Tea"), body: p("Green tea leaves from Кишинёв"), price: 20, released: "2024-02-29",
    launch: "2024-06-15T14:00:00+0000", color: "green", featured: false, location: { latitude: 51.5074, longitude: -0.1278 },
    related: cr(ids.news!), variants: [{ sku: "B-M", size: 2 }],
  }, { tags: ["food"] });
  await add("gamma", "product", {
    title: h1("Gamma Mug"), body: p("Ceramic mug"), price: 30, released: "2023-12-31",
    launch: "2023-12-31T23:59:59+0000", color: "blue", featured: true, location: { latitude: 47.0105, longitude: 28.8638 },
    related: cr(ids.intro!), variants: [],
  }, { tags: ["gear"] });
  await add("delta", "product", { title: h1("Delta Grinder"), body: p("Coffee grinder"), price: 10, featured: false });
  await add("epsilon", "product", {
    title: h1("Epsilon Kettle"), body: p("Steel kettle"), price: 25, released: "2024-07-04",
    launch: "2024-07-04T00:00:00+0000", color: "red", featured: false, location: { latitude: 45.764, longitude: 4.8357 },
  }, { tags: ["gear", "hot"] });
  await add("alpha-fr", "product", { title: h1("Alpha Café FR"), body: p("Grains"), price: 12, released: "2024-01-15" },
    { lang: "fr-fr", tags: ["food"], alt: "alpha" });
  await add("bienvenue", "article", { title: h1("Bienvenue"), body: p("café du jour") }, { lang: "fr-fr" });
  await add("zeta", "product", { title: h1("Zeta draft coffee"), price: 10 }, { publish: false });
  const m = await refs.currentMaster(repoId);
  master = { kind: "master", seq: m.seq };
});
afterAll(async () => db.drop());

async function run(q: string | string[], opts: Partial<SearchParams> & { scope?: RefScope } = {}) {
  const filters = parseQueries(Array.isArray(q) ? q : q ? [q] : []);
  const { scope, ...rest } = opts;
  return search(db.sql, repoId, scope ?? master, { filters, page: 1, pageSize: 100, lang: "en-us", ...rest });
}
const uids = async (q: string | string[], opts: Partial<SearchParams> & { scope?: RefScope } = {}) =>
  (await run(q, opts)).rows.map((r) => uidOf.get(r.id));
const set = async (q: string | string[], opts: Partial<SearchParams> & { scope?: RefScope } = {}) => (await uids(q, opts)).sort();
const s = (...xs: string[]) => [...xs].sort();

describe("search: one assertion per filter", () => {
  it("at", async () => {
    expect(await set('[[at(document.type, "article")]]')).toEqual(s("intro", "news", "kishinev", "cafe-culture"));
    expect(await set('[[at(document.tags, ["food", "hot"])]]')).toEqual(["alpha"]);
    expect(await set(`[[at(document.id, "${ids.beta}")]]`)).toEqual(["beta"]);
    expect(await set('[[at(my.product.uid, "gamma")]]')).toEqual(["gamma"]);
    expect(await set("[[at(my.product.price, 10)]]")).toEqual(s("alpha", "delta"));
    expect(await set("[[at(my.product.featured, true)]]")).toEqual(s("alpha", "gamma"));
    expect(await set('[[at(my.product.color, "red")]]')).toEqual(s("alpha", "epsilon"));
    expect(await set(`[[at(my.product.related, "${ids.intro}")]]`)).toEqual(s("alpha", "gamma"));
    expect(await set('[[at(my.product.released, "2024-01-15")]]')).toEqual(["alpha"]);
    expect(await set('[[at(my.product.variants.sku, "B-M")]]')).toEqual(["beta"]);
  });
  it("not", async () => {
    expect(await set('[[not(document.type, "article")]]')).toEqual(s("alpha", "beta", "gamma", "delta", "epsilon"));
    expect(await set('[[at(document.type, "product")][not(document.tags, ["food", "hot"])]]')).toEqual(s("gamma", "delta"));
    expect(await set("[[not(my.product.featured, true)]]")).toEqual(s("beta", "delta", "epsilon"));
  });
  it("any", async () => {
    expect(await set('[[any(document.tags, ["gear", "nope"])]]')).toEqual(s("gamma", "epsilon"));
    expect(await set('[[any(my.product.color, ["blue", "green"])]]')).toEqual(s("beta", "gamma"));
  });
  it("in preserves array order", async () => {
    expect(await uids(`[[in(document.id, ["${ids.gamma}", "${ids.alpha}", "${ids.news}"])]]`)).toEqual(["gamma", "alpha", "news"]);
    expect(await uids('[[in(my.product.uid, ["epsilon", "beta"])]]')).toEqual(["epsilon", "beta"]);
  });
  it("fulltext (AND of terms, ranked A > B)", async () => {
    expect(await set('[[fulltext(document, "coffee")]]')).toEqual(s("alpha", "delta", "intro", "cafe-culture"));
    expect(await set('[[fulltext(document, "coffee grinder")]]')).toEqual(["delta"]);
    expect(await uids('[[fulltext(document, "tea")]]')).toEqual(["beta", "news"]);
    expect(await set('[[fulltext(my.product.title, "alpha")]]')).toEqual(["alpha"]);
  });
  it("fulltext unicode and accents", async () => {
    expect(await set('[[fulltext(document, "cafe")]]')).toEqual(s("alpha", "cafe-culture"));
    expect(await set('[[fulltext(document, "CAFÉ")]]')).toEqual(s("alpha", "cafe-culture"));
    expect(await set('[[fulltext(document, "Кишинёв")]]')).toEqual(s("kishinev", "beta"));
    expect(await set('[[fulltext(document, "кишинёв")]]')).toEqual(s("kishinev", "beta"));
    expect(await set('[[fulltext(document, "café")]]', { lang: "*" })).toEqual(s("alpha", "cafe-culture", "alpha-fr", "bienvenue"));
  });
  it("has / missing restrict to the type", async () => {
    expect(await set("[[has(my.product.color)]]")).toEqual(s("alpha", "beta", "gamma", "epsilon"));
    expect(await set("[[missing(my.product.color)]]")).toEqual(["delta"]);
    expect(await set("[[has(my.product.location)]]")).toEqual(s("alpha", "beta", "gamma", "epsilon"));
    expect(await set("[[missing(my.product.related)]]")).toEqual(s("delta", "epsilon"));
    expect(await set("[[has(my.product.variants.sku)]]")).toEqual(s("alpha", "beta"));
  });
  it("similar", async () => {
    const all = await uids(`[[similar("${ids.alpha}", 10)]]`);
    expect([...all].sort()).toEqual(s("delta", "intro", "cafe-culture", "epsilon"));
    expect(all[0]).toBe("cafe-culture"); // shares two lexemes (coffee, cafe)
    expect(await uids(`[[similar("${ids.alpha}", 2)]]`)).toEqual(["epsilon"]); // only "red" (df 2) survives
  });
  it("geopoint.near orders by distance", async () => {
    expect(await uids("[[geopoint.near(my.product.location, 48.8566, 2.3522, 500)]]")).toEqual(["alpha", "beta", "epsilon"]);
    expect(await uids("[[geopoint.near(my.product.location, 48.8566, 2.3522, 1)]]")).toEqual(["alpha"]);
  });
  it("number.lt / number.gt / number.inRange (inclusive)", async () => {
    expect(await set("[[number.lt(my.product.price, 20)]]")).toEqual(s("alpha", "delta"));
    expect(await set("[[lt(my.product.price, 20)]]")).toEqual(s("alpha", "delta"));
    expect(await set("[[number.gt(my.product.price, 20)]]")).toEqual(s("gamma", "epsilon"));
    expect(await set("[[number.inRange(my.product.price, 10, 25)]]")).toEqual(s("alpha", "beta", "delta", "epsilon"));
    expect(await set("[[number.inRange(my.product.price, 11, 24)]]")).toEqual(["beta"]);
    expect(await set("[[number.gt(my.product.variants.size, 2)]]")).toEqual(["alpha"]);
  });
  it("date.after (exclusive) / date.before (exclusive) / date.between (inclusive)", async () => {
    expect(await set('[[date.after(my.product.released, "2024-01-15")]]')).toEqual(s("beta", "epsilon"));
    expect(await set('[[date.before(my.product.released, "2024-01-15")]]')).toEqual(["gamma"]);
    expect(await set('[[date.between(my.product.released, "2024-01-15", "2024-02-29")]]')).toEqual(s("alpha", "beta"));
    expect(await set('[[date.after(my.product.launch, "2024-03-05T10:00:00+0300")]]')).toEqual(s("alpha", "beta", "epsilon"));
    const ms = Date.UTC(2024, 2, 5, 8, 30);
    expect(await set(`[[date.before(my.product.launch, ${ms})]]`)).toEqual(["gamma"]);
    expect(await set(`[[date.between(my.product.launch, ${ms}, "2024-07-04T00:00:00+0000")]]`)).toEqual(s("alpha", "beta", "epsilon"));
    expect((await run('[[date.after(document.first_publication_date, "2000-01-01")]]')).total).toBe(9);
    expect((await run('[[date.before(document.last_publication_date, "2000-01-01")]]')).total).toBe(0);
  });
  it("date.day-of-month(-after/-before)", async () => {
    expect(await set("[[date.day-of-month(my.product.released, 15)]]")).toEqual(["alpha"]);
    expect(await set("[[date.day-of-month-after(my.product.released, 15)]]")).toEqual(s("beta", "gamma"));
    expect(await set("[[date.day-of-month-before(my.product.released, 15)]]")).toEqual(["epsilon"]);
  });
  it("date.day-of-week(-after/-before) with names in any casing and numbers", async () => {
    expect(await set('[[date.day-of-week(my.product.launch, "tuesday")]]')).toEqual(["alpha"]);
    expect(await set('[[date.day-of-week(my.product.launch, "TUE")]]')).toEqual(["alpha"]);
    expect(await set("[[date.day-of-week(my.product.launch, 2)]]")).toEqual(["alpha"]);
    expect(await set('[[date.day-of-week-after(my.product.launch, "Thursday")]]')).toEqual(s("beta", "gamma"));
    expect(await set('[[date.day-of-week-before(my.product.launch, "thu")]]')).toEqual(["alpha"]);
  });
  it("date.month(-after/-before)", async () => {
    expect(await set('[[date.month(my.product.released, "february")]]')).toEqual(["beta"]);
    expect(await set('[[date.month(my.product.released, "FEB")]]')).toEqual(["beta"]);
    expect(await set("[[date.month(my.product.released, 2)]]")).toEqual(["beta"]);
    expect(await set('[[date.month-after(my.product.released, "jan")]]')).toEqual(s("beta", "gamma", "epsilon"));
    expect(await set('[[date.month-before(my.product.released, "July")]]')).toEqual(s("alpha", "beta"));
  });
  it("date.year / date.hour(-after/-before) in UTC", async () => {
    expect(await set("[[date.year(my.product.released, 2024)]]")).toEqual(s("alpha", "beta", "epsilon"));
    expect(await set("[[date.hour(my.product.launch, 8)]]")).toEqual(["alpha"]);
    expect(await set("[[date.hour-after(my.product.launch, 8)]]")).toEqual(s("beta", "gamma"));
    expect(await set("[[date.hour-before(my.product.launch, 8)]]")).toEqual(["epsilon"]);
  });
});

describe("search: compatibility", () => {
  const bad = async (q: string) => {
    const err = await run(q).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(QueryParseError);
    return err as QueryParseError;
  };
  it("rejects incompatible field filters, unknown types and unknown fields", async () => {
    expect((await bad('[[fulltext(my.product.price, "x")]]')).message).toContain(
      "unsupported filter 'fulltext' for field 'my.product.price' of type Number",
    );
    await bad('[[number.lt(my.product.color, 3)]]');
    await bad('[[at(my.product.site, "x")]]');
    await bad("[[has(my.product.photo)]]");
    await bad("[[has(my.product.variants)]]");
    await bad('[[at(my.nope.x, "x")]]');
    await bad('[[at(my.product.nope, "x")]]');
    await bad('[[at(my.product.price.sub, 1)]]');
    await bad('[[date.after(my.product.released, "not a date")]]');
    await bad('[[date.month(my.product.released, "smarch")]]');
    await bad('[[date.day-of-week(my.product.launch, 8)]]');
  });
  it("rejects bad orderings", async () => {
    await expect(run('[[at(document.type, "product")]]', { orderings: "[my.product.nope]" })).rejects.toBeInstanceOf(QueryParseError);
    await expect(run("", { orderings: "[my.product.price sideways]" })).rejects.toBeInstanceOf(QueryParseError);
  });
});

describe("search: orderings, pagination, lang, scope", () => {
  const products = '[[at(document.type, "product")]]';
  it("orderings [my.product.price desc,my.product.title]", async () => {
    expect(await uids(products, { orderings: "[my.product.price desc,my.product.title]" }))
      .toEqual(["gamma", "epsilon", "beta", "alpha", "delta"]);
    expect(await uids(products, { orderings: "[my.product.price, my.product.title desc]" }))
      .toEqual(["delta", "alpha", "beta", "epsilon", "gamma"]);
  });
  it("default order is last_publication_date desc", async () => {
    expect(await uids(products)).toEqual(["epsilon", "delta", "gamma", "beta", "alpha"]);
    expect(await uids("")).toEqual(["epsilon", "delta", "gamma", "beta", "alpha", "cafe-culture", "kishinev", "news", "intro"]);
  });
  it("after pages equal slices of the full ordering; total is the whole set", async () => {
    const orderings = "[my.product.price desc,my.product.title]";
    const full = await uids(products, { orderings });
    for (let i = 0; i < full.length; i++) {
      const res = await run(products, { orderings, after: ids[full[i]!], pageSize: 2 });
      expect(res.rows.map((r) => uidOf.get(r.id))).toEqual(full.slice(i + 1, i + 3));
      expect(res.total).toBe(5);
    }
    const p2 = await run(products, { orderings, after: ids.gamma, pageSize: 2, page: 2 });
    expect(p2.rows.map((r) => uidOf.get(r.id))).toEqual(full.slice(3, 5));
  });
  it("page/pageSize clamp and past-the-end", async () => {
    const r1 = await run("", { pageSize: 0 });
    expect(r1.rows).toHaveLength(1);
    expect(r1.total).toBe(9);
    const r2 = await run("", { pageSize: 2, page: 2 });
    expect(r2.rows.map((r) => uidOf.get(r.id))).toEqual(["gamma", "beta"]);
    const r3 = await run("", { pageSize: 5, page: 9 });
    expect(r3).toEqual({ total: 9, rows: [] });
    const r4 = await run("", { pageSize: 1000, page: 0 });
    expect(r4.rows).toHaveLength(9);
  });
  it("lang default master vs *", async () => {
    expect((await run("")).total).toBe(9);
    expect((await run("", { lang: "*" })).total).toBe(11);
    expect(await set("", { lang: "fr-fr" })).toEqual(s("alpha-fr", "bienvenue"));
    expect((await run("", { lang: "de-de" })).total).toBe(0);
  });
  it("historic scope sees only what was live at that seq; drafts never visible", async () => {
    expect(await set("", { scope: { kind: "historic", seq: historicSeq } })).toEqual(s("intro", "news", "kishinev"));
    expect(await set('[[at(my.product.uid, "zeta")]]')).toEqual([]);
  });
  it("rows carry the document envelope", async () => {
    const { rows } = await run('[[at(my.product.uid, "alpha")]]');
    const r = rows[0]!;
    expect(r).toMatchObject({ id: ids.alpha, uid: "alpha", type: "product", lang: "en-us", tags: ["food", "hot"], groupId: ids.alpha });
    expect(r.firstPublicationDate).toBeInstanceOf(Date);
    expect(r.lastPublicationDate).toBeInstanceOf(Date);
    expect(r.versionId).toMatch(/^\d+$/);
    expect((r.data as Record<string, unknown>).price).toBe(10);
  });
});
