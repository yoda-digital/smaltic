import {
  asLink,
  createClient,
  filter,
  ForbiddenError,
  NotFoundError,
  ParsingError,
  PreviewTokenExpiredError,
  PrismicError,
  type Client,
  type ClientConfig,
  type PrismicDocument,
} from "@prismicio/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ctx, documentAPIEndpoint } from "./context.js";
import { ALT_LOCALE, createPreviewConfig, LOCALE, MISSING_DOC_ID, previewSession, routes } from "./seed.js";

const c = ctx();
const log: Array<{ url: string; status: number }> = [];
const loggingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  log.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, status: res.status });
  return res;
};
const client = (opts: Partial<ClientConfig> = {}, repo = c.repo, base = c.baseUrl): Client =>
  createClient(repo, { documentAPIEndpoint: documentAPIEndpoint(c, repo, base), routes, fetch: loggingFetch, ...opts });
const cl = client();

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0000$/;
const title = (d: PrismicDocument) => (d.data as any).title?.[0]?.text as string | undefined;
const uids = (docs: PrismicDocument[]) => docs.map((d) => d.uid);
const sorted = (xs: Array<string | null>) => [...xs].sort();
const id = (key: string) => {
  const v = c.ids[key];
  if (!v) throw new Error(`no seeded document ${key}`);
  return v;
};
const bulkIds = () => Object.entries(c.ids).filter(([k]) => k.startsWith("bulk_item:")).map(([, v]) => v);

/** Product uids matching `filters` (always restricted to type product). */
async function products(filters: string[], params: Record<string, unknown> = {}): Promise<Array<string | null>> {
  const res = await cl.get({ filters: [filter.at("document.type", "product"), ...filters], pageSize: 100, ...params });
  return uids(res.results);
}

describe("Repository API", () => {
  it("REQ-SDK-003 REQ-API-007 REQ-API-011 REQ-SDK-001 getRepository() shape and absolute form actions", async () => {
    const repo = await cl.getRepository();
    expect(Object.keys(repo)).toEqual(expect.arrayContaining(["refs", "bookmarks", "types", "languages", "forms", "tags", "license", "version"]));
    expect(repo.refs[0]).toMatchObject({ id: "master", label: "Master", isMasterRef: true });
    expect(repo.types).toMatchObject({ page: "Page", blog_post: "Blog post", kitchen_sink: "Kitchen sink" });
    const prefix = `${c.baseUrl}/r/${c.repo}`;
    expect(repo.forms.everything!.action).toBe(`${prefix}/api/v2/documents/search`);
    expect((repo.forms as any).tags.action).toBe(`${prefix}/api/tags`);
  });

  it("REQ-API-008 getMasterRef() / getRefs(): one master ref, opaque 16-char id", async () => {
    const master = await cl.getMasterRef();
    expect(master.ref).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect((await cl.getRefs()).filter((r) => r.isMasterRef)).toEqual([master]);
  });

  it("REQ-API-010 languages list the master locale first", async () => {
    const repo = await cl.getRepository();
    expect(repo.languages.map((l) => l.id)).toEqual([LOCALE, ALT_LOCALE]);
    expect((repo.languages[0] as any).is_master).toBe(true);
  });

  it("REQ-API-005 getRefByLabel / getReleaseByLabel of an unknown label throw PrismicError", async () => {
    await expect(cl.getRefByLabel("nope")).rejects.toBeInstanceOf(PrismicError);
    await expect(cl.getReleaseByLabel("nope")).rejects.toBeInstanceOf(PrismicError);
  });

  it("REQ-API-003 REQ-SDK-011 REQ-API-013 CORS and JSON headers on /api/v2, search and tags", async () => {
    const master = (await cl.getMasterRef()).ref;
    const base = documentAPIEndpoint(c);
    for (const url of [base, `${base}/documents/search?ref=${master}`, `${c.baseUrl}/r/${c.repo}/api/tags`]) {
      const res = await fetch(url);
      expect(res.status, url).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), url).toBe("*");
      expect(res.headers.get("content-type"), url).toMatch(/^application\/json/);
      expect(res.headers.get("x-prismic-version"), url).toBe("6");
    }
  });

  it("REQ-API-037 /api/v2 is not cached; master-ref search responses are immutable", async () => {
    const master = (await cl.getMasterRef()).ref;
    expect((await fetch(documentAPIEndpoint(c))).headers.get("cache-control")).toMatch(/no-store/);
    const search = await fetch(`${documentAPIEndpoint(c)}/documents/search?ref=${master}`);
    expect(search.headers.get("cache-control")).toMatch(/max-age=31536000/);
  });
});

describe("Tags API", () => {
  it("REQ-API-014 getTags() follows forms.tags.action and returns unique tags in byte order", async () => {
    log.length = 0;
    const tags = await cl.getTags();
    expect(tags).toEqual(["bulk", "even", "featured", "garden", "kitchen", "landing", "news", "sale"]);
    expect(log.some((r) => r.url.startsWith(`${c.baseUrl}/r/${c.repo}/api/tags`))).toBe(true);
  });
});

describe("Search envelope and pagination", () => {
  it("REQ-API-027 REQ-SDK-005 get() envelope fields and absolute next_page", async () => {
    const res = await cl.get({ pageSize: 10 });
    expect(Object.keys(res)).toEqual(
      expect.arrayContaining(["page", "results_per_page", "results_size", "total_results_size", "total_pages", "next_page", "prev_page", "results"]),
    );
    expect(res).toMatchObject({ page: 1, results_per_page: 10, results_size: 10, prev_page: null });
    expect(res.total_pages).toBe(Math.ceil(res.total_results_size / 10));
    expect(res.next_page).toMatch(new RegExp(`^${c.baseUrl}/r/${c.repo}/api/v2/documents/search\\?`));
  });

  it("REQ-API-016 get({ page: 2, pageSize: 10 }) and pageSize above 100 is clamped", async () => {
    const p2 = await cl.get({ page: 2, pageSize: 10 });
    expect(p2).toMatchObject({ page: 2, results_per_page: 10, results_size: 10 });
    expect(p2.prev_page).not.toBeNull();
    const big = await cl.get({ pageSize: 101 });
    expect(big.results_per_page).toBe(100);
    expect(big.results_size).toBe(100);
  });

  it("REQ-API-016 a page past the end is 200 with no results and correct totals", async () => {
    const total = (await cl.get({ pageSize: 1 })).total_results_size;
    const res = await cl.get({ page: 999, pageSize: 100 });
    expect(res.results).toEqual([]);
    expect(res.total_results_size).toBe(total);
  });

  it("REQ-SDK-040 identical requests return identical results (stable default order)", async () => {
    const a = await cl.get({ pageSize: 50, page: 2 });
    const b = await cl.get({ pageSize: 50, page: 2 });
    expect(b.results.map((d) => d.id)).toEqual(a.results.map((d) => d.id));
  });

  it("REQ-SDK-004 buildQueryURL() fetched directly returns what get() returns; unknown params are ignored", async () => {
    const params = { filters: [filter.at("document.type", "product")], orderings: { field: "my.product.price" } };
    const url = await cl.buildQueryURL(params);
    const direct = (await (await fetch(url)).json()) as { results: PrismicDocument[] };
    expect(direct.results.map((d) => d.id)).toEqual((await cl.get(params)).results.map((d) => d.id));
    const extra = (await (await fetch(`${url}&referer=https%3A%2F%2Fsite.example&unknownParam=1`)).json()) as { results: PrismicDocument[] };
    expect(extra.results.map((d) => d.id)).toEqual(direct.results.map((d) => d.id));
  });

  it("REQ-API-028 REQ-SDK-027 document metadata shape (+0000 timestamps, href, slugs)", async () => {
    const doc = await cl.getByUID("page", "home");
    expect(doc).toMatchObject({ id: id("page:home"), uid: "home", type: "page", lang: LOCALE, tags: ["landing", "featured"], linked_documents: [] });
    expect(doc.first_publication_date).toMatch(TS_RE);
    expect(doc.last_publication_date).toMatch(TS_RE);
    expect(Array.isArray(doc.slugs)).toBe(true);
    const href = new URL(doc.href);
    expect(href.href.startsWith(`${c.baseUrl}/r/${c.repo}/api/v2/documents/search?`)).toBe(true);
    expect(href.searchParams.get("q")).toBe(`[[:d = at(document.id, "${doc.id}") ]]`);
  });
});

describe("get* helpers", () => {
  it("REQ-SDK-001 getFirst(), getByID(), getByID(missing) -> NotFoundError", async () => {
    expect((await cl.getFirst({ filters: [filter.at("my.product.uid", "beta")] })).uid).toBe("beta");
    expect((await cl.getByID(id("product:alpha"))).uid).toBe("alpha");
    await expect(cl.getByID(MISSING_DOC_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("REQ-SDK-007 getByIDs([b, a]) preserves order; getAllByIDs over more than 100 ids", async () => {
    const res = await cl.getByIDs([id("product:beta"), id("product:alpha")]);
    expect(uids(res.results)).toEqual(["beta", "alpha"]);
    const many = bulkIds().slice(0, 150);
    const all = await cl.getAllByIDs(many);
    expect(all.map((d) => d.id)).toEqual(many);
  });

  it("REQ-SDK-007 getByUID, getByUIDs (order kept), getAllByUIDs", async () => {
    expect(title(await cl.getByUID("page", "home"))).toBe("Home");
    expect(uids((await cl.getByUIDs("product", ["gamma", "alpha"])).results)).toEqual(["gamma", "alpha"]);
    const wanted = Array.from({ length: 120 }, (_, i) => `bulk-${String(i).padStart(3, "0")}`).reverse();
    expect(uids(await cl.getAllByUIDs("bulk_item", wanted))).toEqual(wanted);
  });

  it("getSingle('settings'); getSingle of an unknown type -> NotFoundError", async () => {
    expect((await cl.getSingle("settings")).data).toMatchObject({ site_name: "Compat site" });
    await expect(cl.getSingle("none")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("REQ-API-016 getByType and getAllByType over more than 250 documents (multi-page, terminates)", async () => {
    expect((await cl.getByType("product")).total_results_size).toBe(3);
    log.length = 0;
    const all = await cl.getAllByType("bulk_item");
    expect(all).toHaveLength(c.bulkCount);
    expect(new Set(all.map((d) => d.id)).size).toBe(c.bulkCount);
    const pages = log.filter((r) => r.url.includes("/documents/search")).map((r) => new URL(r.url).searchParams.get("page") ?? "1");
    expect(pages).toEqual(["1", "2", "3"]);
  });

  it("REQ-API-021 getByTag, getAllByTag, getByEveryTag, getAllByEveryTag, getBySomeTags, getAllBySomeTags", async () => {
    expect(sorted(uids((await cl.getByTag("news")).results))).toEqual(["hello-world", "second-post"]);
    expect(await cl.getAllByTag("even")).toHaveLength(c.bulkCount / 2);
    expect(uids((await cl.getByEveryTag(["kitchen", "sale"])).results)).toEqual(["alpha"]);
    expect(uids(await cl.getAllByEveryTag(["kitchen", "sale"]))).toEqual(["alpha"]);
    expect(sorted(uids((await cl.getBySomeTags(["garden", "news"])).results))).toEqual(["gamma", "hello-world", "second-post"]);
    expect(await cl.getAllBySomeTags(["bulk", "featured"])).toHaveLength(c.bulkCount + 2);
  });

  it("REQ-API-016 dangerouslyGetAll() walks every page with page-number pagination", async () => {
    const total = (await cl.get({ pageSize: 1 })).total_results_size;
    expect(total).toBeGreaterThanOrEqual(250);
    log.length = 0;
    const all = await cl.dangerouslyGetAll();
    expect(all).toHaveLength(total);
    const searches = log.filter((r) => r.url.includes("/documents/search")).map((r) => new URL(r.url).searchParams);
    expect(searches.map((p) => p.get("page") ?? "1")).toEqual(Array.from({ length: Math.ceil(total / 100) }, (_, i) => String(i + 1)));
    expect(searches.every((p) => p.get("pageSize") === "100")).toBe(true);
  });
});

describe("Locales", () => {
  it("REQ-API-034 lang defaults to the master locale; lang selects one locale", async () => {
    const fr = await cl.get({ lang: ALT_LOCALE });
    expect(uids(fr.results)).toEqual(["accueil"]);
    expect((await cl.getByType("page")).results.every((d) => d.lang === LOCALE)).toBe(true);
    expect((await cl.get({ lang: "de-de" })).results).toEqual([]);
  });

  it("REQ-SDK-008 getAllByType('page', { lang: '*' }) returns every locale with alternate_languages", async () => {
    const all = await cl.getAllByType("page", { lang: "*" });
    expect(sorted(all.map((d) => d.lang)).filter((l, i, a) => a.indexOf(l) === i)).toEqual([LOCALE, ALT_LOCALE]);
    const home = all.find((d) => d.uid === "home")!;
    expect(home.alternate_languages).toEqual([{ id: id("page:accueil"), uid: "accueil", type: "page", lang: ALT_LOCALE }]);
  });
});

describe("Orderings and after", () => {
  it("REQ-API-025 orderings on a number field desc, then first_publication_date", async () => {
    const res = await products([], {
      orderings: [{ field: "my.product.price", direction: "desc" }, { field: "document.first_publication_date" }],
    });
    expect(res).toEqual(["gamma", "beta", "alpha"]);
  });

  it("REQ-API-026 after=<id> continues after that document in the current ordering", async () => {
    expect(await products([], { orderings: { field: "my.product.price" }, after: id("product:alpha") })).toEqual(["beta", "gamma"]);
  });
});

describe("Filters (all 28)", () => {
  const cases: Array<[string, string[], Array<string | null>, boolean?]> = [
    ["REQ-API-019 at(my.product.uid)", [filter.at("my.product.uid", "beta")], ["beta"]],
    ["REQ-API-021 at(document.tags) with array is all-of", [filter.at("document.tags", ["kitchen", "sale"])], ["alpha"]],
    ["REQ-API-021 not(document.tags) with array is none-of", [filter.not("document.tags", ["sale"])], ["beta"]],
    ["REQ-API-021 any(document.tags) is any-of", [filter.any("document.tags", ["garden", "nothing"])], ["gamma"]],
    ["REQ-API-021 REQ-SDK-007 in(my.product.uid) keeps the array order", [filter.in("my.product.uid", ["gamma", "alpha"])], ["gamma", "alpha"], true],
    ["REQ-API-022 fulltext(document) ANDs terms", [filter.fulltext("document", "espresso")], ["alpha", "beta"]],
    ["REQ-API-022 fulltext on a rich text field is accent-insensitive", [filter.fulltext("my.product.description", "cafe espresso")], ["alpha"]],
    ["REQ-API-021 has(my.product.subtitle)", [filter.has("my.product.subtitle")], ["alpha", "beta"]],
    ["REQ-API-021 missing(my.product.subtitle) restricts to the type", [filter.missing("my.product.subtitle")], ["gamma"]],
    ["REQ-API-024 geopointNear orders nearest first", [filter.geopointNear("my.product.location", 48.8566, 2.3522, 500)], ["alpha", "gamma", "beta"], true],
    ["REQ-API-019 numberLessThan is strict", [filter.numberLessThan("my.product.price", 20)], ["alpha"]],
    ["REQ-API-019 numberGreaterThan is strict", [filter.numberGreaterThan("my.product.price", 20)], ["gamma"]],
    ["REQ-API-019 numberInRange is inclusive", [filter.numberInRange("my.product.price", 10, 20)], ["alpha", "beta"]],
    ["REQ-API-019 dateAfter is exclusive", [filter.dateAfter("my.product.release_date", "2024-03-10")], ["gamma"]],
    ["REQ-API-019 dateAfter accepts 13-digit epoch ms", [filter.dateAfter("my.product.release_date", Date.UTC(2024, 2, 10))], ["gamma"]],
    ["REQ-API-019 dateBefore is exclusive", [filter.dateBefore("my.product.release_date", "2024-03-10")], ["alpha"]],
    ["REQ-API-019 dateBetween is inclusive", [filter.dateBetween("my.product.release_date", "2024-01-15", "2024-03-10")], ["alpha", "beta"]],
    ["REQ-API-019 dateDayOfMonth", [filter.dateDayOfMonth("my.product.release_date", 10)], ["beta"]],
    ["REQ-API-019 dateDayOfMonthAfter is strict", [filter.dateDayOfMonthAfter("my.product.release_date", 10)], ["alpha"]],
    ["REQ-API-019 dateDayOfMonthBefore is strict", [filter.dateDayOfMonthBefore("my.product.release_date", 10)], ["gamma"]],
    ["REQ-API-019 dateDayOfWeek with a short lowercase name", [filter.dateDayOfWeek("my.product.release_date", "mon" as never)], ["alpha"]],
    ["REQ-API-019 dateDayOfWeekAfter with a capitalized name", [filter.dateDayOfWeekAfter("my.product.release_date", "Friday")], ["beta"]],
    ["REQ-API-019 dateDayOfWeekBefore with an all-caps name", [filter.dateDayOfWeekBefore("my.product.release_date", "FRIDAY" as never)], ["alpha"]],
    ["REQ-API-019 dateMonth", [filter.dateMonth("my.product.release_date", "March")], ["beta"]],
    ["REQ-API-019 dateMonthAfter", [filter.dateMonthAfter("my.product.release_date", "mar" as never)], ["gamma"]],
    ["REQ-API-019 dateMonthBefore with a month number", [filter.dateMonthBefore("my.product.release_date", 3 as never)], ["alpha"]],
    ["REQ-API-019 dateYear", [filter.dateYear("my.product.release_date", 2024)], ["alpha", "beta"]],
    ["REQ-API-019 dateHour on a timestamp", [filter.dateHour("my.product.launched_at", 14)], ["beta"]],
    ["REQ-API-019 dateHourAfter", [filter.dateHourAfter("my.product.launched_at", 14)], ["gamma"]],
    ["REQ-API-019 dateHourBefore", [filter.dateHourBefore("my.product.launched_at", 14)], ["alpha"]],
  ];
  for (const [name, filters, expected, ordered] of cases) {
    it(name, async () => {
      const got = await products(filters);
      expect(ordered ? got : sorted(got)).toEqual(ordered ? expected : sorted(expected));
    });
  }

  it("REQ-API-023 similar(id, max) excludes the source document", async () => {
    const res = await cl.get({ filters: [filter.similar(id("product:alpha"), 10)], pageSize: 100 });
    expect(res.results.map((d) => d.id)).not.toContain(id("product:alpha"));
    expect(uids(res.results)).toContain("beta");
  });

  it("REQ-API-018 an invalid filter surfaces as ParsingError", async () => {
    await expect(cl.get({ filters: ['[foo(document.type, "x")]'] })).rejects.toBeInstanceOf(ParsingError);
    await expect(cl.get({ filters: ["[[at(document.type"] })).rejects.toBeInstanceOf(ParsingError);
  });
});

describe("Linked documents", () => {
  it("REQ-API-030 fetchLinks: ['author.name'] fills the linked author's data", async () => {
    const post = await cl.getByUID("blog_post", "hello-world", { fetchLinks: ["author.name"] });
    const author = (post.data as any).author;
    expect(author).toMatchObject({ link_type: "Document", id: id("author:jane"), type: "author", uid: "jane", isBroken: false });
    expect(author.data).toEqual({ name: "Jane Doe" });
  });

  it("REQ-API-031 graphQuery selects fields and linked-document fields", async () => {
    const graphQuery = `{ blog_post { title author { ...on author { name } } } }`;
    const post = await cl.getByUID("blog_post", "hello-world", { graphQuery });
    const data = post.data as any;
    expect(Object.keys(data).sort()).toEqual(["author", "title"]);
    expect(data.author.data).toEqual({ name: "Jane Doe" });
  });

  it("REQ-API-029 REQ-FLD-017 document links carry the stub fields", async () => {
    const about = await cl.getByUID("page", "about");
    expect((about.data as any).parent).toMatchObject({
      link_type: "Document",
      id: id("page:home"),
      type: "page",
      tags: ["landing", "featured"],
      lang: LOCALE,
      uid: "home",
      isBroken: false,
    });
  });
});

describe("Routes", () => {
  it("REQ-API-045 REQ-API-048 REQ-SDK-009 uid-scoped route wins; generic route with :lang? omits the master locale", async () => {
    expect((await cl.getByUID("page", "home")).url).toBe("/");
    expect((await cl.getByUID("page", "contact")).url).toBe("/contact");
  });

  it("REQ-API-046 REQ-API-048 lang-scoped route for another locale", async () => {
    expect((await cl.getByUID("page", "accueil", { lang: ALT_LOCALE })).url).toBe("/fr/accueil");
  });

  it("REQ-API-047 resolvers: one level and two levels (author.company)", async () => {
    expect((await cl.getByUID("page", "about")).url).toBe("/home/about");
    expect((await cl.getByUID("blog_post", "hello-world")).url).toBe("/blog/acme/jane/hello-world");
  });

  it("REQ-API-045 REQ-SDK-017 linked stubs get root-relative urls; unmatched types get url null; asLink(doc) === doc.url", async () => {
    const about = await cl.getByUID("page", "about");
    expect((about.data as any).parent.url).toBe("/");
    expect(asLink(about)).toBe(about.url);
    expect((await cl.getSingle("settings")).url).toBeNull();
  });

  it("REQ-API-049 REQ-FLD-018 brokenRoute on a link to a document that does not exist", async () => {
    const contact = await cl.getByUID("page", "contact", { brokenRoute: "/404" });
    expect((contact.data as any).related).toMatchObject({ link_type: "Document", isBroken: true, url: "/404" });
  });

  it.skipIf(!c.archivedLinkSource)("REQ-API-049 brokenRoute on a link to an unpublished document", async () => {
    const linker = await cl.getByID(c.archivedLinkSource!, { brokenRoute: "/404" });
    expect((linker.data as any).related).toMatchObject({ isBroken: true, url: "/404" });
    expect((await cl.get({ filters: [filter.at("my.page.uid", "old-page")] })).results).toEqual([]);
  });
});

describe("Releases", () => {
  it.skipIf(!c.release)("REQ-API-009 REQ-SDK-012 getReleases / getReleaseByLabel / getReleaseByID with a release-scoped token", async () => {
    const rc = client({ accessToken: c.release!.accessToken });
    const releases = await rc.getReleases();
    expect(releases.map((r) => r.label)).toEqual(["Spring"]);
    const spring = await rc.getReleaseByLabel("Spring");
    expect(spring).toMatchObject({ label: "Spring", isMasterRef: false, scheduledAt: Date.parse("2030-03-21T09:00:00Z") });
    expect(await rc.getReleaseByID(spring.id)).toEqual(spring);
  });

  it.skipIf(!c.release)("REQ-SDK-012 queryContentFromReleaseByLabel returns release content; queryLatestContent reverts", async () => {
    const rc = client({ accessToken: c.release!.accessToken });
    rc.queryContentFromReleaseByLabel("Spring");
    expect(title(await rc.getByUID("page", "spring-sale"))).toBe("Spring sale");
    expect(title(await rc.getByUID("page", "about"))).toBe("About (Spring)");
    rc.queryLatestContent();
    await expect(rc.getByUID("page", "spring-sale")).rejects.toBeInstanceOf(NotFoundError);
    expect(title(await rc.getByUID("page", "about"))).toBe("About");
  });

  it.skipIf(!c.release)("REQ-API-005 releases are hidden without a master+releases token", async () => {
    expect(await cl.getReleases()).toEqual([]);
    const spring = await client({ accessToken: c.release!.accessToken }).getReleaseByLabel("Spring");
    await expect(cl.get({ ref: spring.ref })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Previews", () => {
  let token: string;
  beforeAll(async () => {
    ({ token } = await previewSession(c, id("page:draft-page")));
  });

  it("REQ-PRV-001 REQ-SDK-014 queryContentFromRef(previewToken) returns a never-published draft", async () => {
    await expect(cl.getByUID("page", "draft-page")).rejects.toBeInstanceOf(NotFoundError);
    const pc = client();
    pc.queryContentFromRef(token);
    expect(title(await pc.getByUID("page", "draft-page"))).toBe("Draft page");
  });

  it("REQ-PRV-003 REQ-SDK-014 the raw toolbar cookie JSON is accepted as ref, plain and URL-encoded", async () => {
    const host = new URL(c.baseUrl).host;
    const blob = JSON.stringify({ _tracker: "x", [host]: { preview: token } });
    for (const ref of [blob, encodeURIComponent(blob)]) {
      const pc = client();
      pc.queryContentFromRef(ref);
      expect(title(await pc.getByUID("page", "draft-page")), ref).toBe("Draft page");
    }
  });

  it("REQ-SDK-016 resolvePreviewURL returns the route URL of a never-published draft", async () => {
    expect(await cl.resolvePreviewURL({ previewToken: token, documentID: id("page:draft-page"), defaultURL: "/" })).toBe("/home/draft-page");
    expect(await cl.resolvePreviewURL({ previewToken: token, documentID: id("settings"), defaultURL: "/fallback" })).toBe("/fallback");
    // The official client lets the lookup's NotFoundError through for an unknown document.
    await expect(cl.resolvePreviewURL({ previewToken: token, documentID: MISSING_DOC_ID, defaultURL: "/" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it.skipIf(!c.expiredPreviewToken)("REQ-SDK-013 an expired preview token -> PreviewTokenExpiredError", async () => {
    await expect(cl.getByID(id("page:draft-page"), { ref: c.expiredPreviewToken! })).rejects.toBeInstanceOf(PreviewTokenExpiredError);
    await expect(
      cl.resolvePreviewURL({ previewToken: c.expiredPreviewToken!, documentID: id("page:draft-page"), defaultURL: "/" }),
    ).rejects.toBeInstanceOf(PreviewTokenExpiredError);
  });

  it("REQ-PRV-002 REQ-SDK-015 preview sessions redirect to <previewURL>?token=<ref>&documentId=<id>", async () => {
    await createPreviewConfig(c, { name: "Compat site", website_url: "https://site.example", resolver_path: "/api/preview" });
    const s = await previewSession(c, id("page:draft-page"));
    expect(s.previewUrl).toBe(`https://site.example/api/preview?token=${encodeURIComponent(s.token)}&documentId=${id("page:draft-page")}`);
  });
});

describe("Access control", () => {
  it.skipIf(!c.privateRepo)("REQ-SDK-010 REQ-API-006 private repo: no token -> ForbiddenError; accessToken in config or per query -> OK", async () => {
    const { name, accessToken } = c.privateRepo!;
    await expect(client({}, name).get()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(client({}, name).getRepository()).rejects.toBeInstanceOf(ForbiddenError);
    expect((await client({ accessToken }, name).get()).page).toBe(1);
    expect((await client({}, name).get({ accessToken })).page).toBe(1);
    const res = await fetch(documentAPIEndpoint(c, name));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid access token" });
  });

  it.skipIf(!c.accessToken)("REQ-API-006 a valid access token is accepted on a public repository", async () => {
    expect((await client({ accessToken: c.accessToken }).getByUID("page", "home")).uid).toBe("home");
  });
});

describe("Errors and retries", () => {
  it("REQ-API-017 REQ-SDK-013 unknown ref -> 404 ending with the master ref; the client retries with it", async () => {
    const master = (await cl.getMasterRef()).ref;
    const res = await fetch(`${documentAPIEndpoint(c)}/documents/search?ref=bogusbogusbogus1`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string; message: string };
    expect(body.type).toBe("api_notfound_error");
    expect(body.message.endsWith(` Master ref is: ${master}`)).toBe(true);
    expect((await cl.get({ ref: "bogusbogusbogus1", pageSize: 1 })).results).toHaveLength(1);
  });

  it.skipIf(!c.rateLimitedBaseUrl)("REQ-SDK-029 429 carries Retry-After and the client retries until it succeeds", async () => {
    const rl = client({}, c.repo, c.rateLimitedBaseUrl!);
    log.length = 0;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => rl.get({ page: i + 1, pageSize: 1 })));
    expect(results.map((r) => r.page)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(log.some((r) => r.status === 429)).toBe(true);
    // Raw check: a 429 always carries a numeric Retry-After.
    let limited: Response | undefined;
    for (let i = 0; i < 10 && !limited; i++) {
      const r = await fetch(documentAPIEndpoint(c, c.repo, c.rateLimitedBaseUrl!));
      if (r.status === 429) limited = r;
    }
    expect(limited?.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("Later plans", () => {
  it.todo("REQ-SDK-033 REQ-API-040 graphQLFetch against <base>/graphql <reason: Plan 3 GraphQL API>");
  it.todo("REQ-SDK-018 REQ-SDK-020 toolbar iframe handshake and preview update events <reason: Plan 6 toolbar bridge>");
  it.todo("REQ-SDK-022 slice simulator iframe protocol <reason: Plan 5 Page Builder>");
  it.todo("REQ-SDK-034 documentsPublished webhooks refresh static sites <reason: Plan 6 webhooks>");
  it.todo("REQ-SDK-035 environments as separate repositories <reason: Plan 6 environments>");
  it.todo("REQ-SDK-039 REQ-API-035 integrationFieldsRef catalogs <reason: Plan 6 integration fields>");
  it.todo("REQ-SDK-036 REQ-SDK-037 Slice Machine and legacy v5 clients <reason: Plan 7 compat hardening>");
  it.todo("Next.js App Router, Pages Router, Nuxt, SvelteKit and React starters (matrix items 27-31, 34) <reason: Plan 7 compat hardening>");
  it.todo("prismic-ts-codegen against the Custom Types API (matrix item 35) <reason: Plan 7 compat hardening>");
});
