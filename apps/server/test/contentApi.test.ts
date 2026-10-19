import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClient,
  ForbiddenError,
  ParsingError,
  PreviewTokenExpiredError,
  type Client,
} from "@prismicio/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentService } from "../src/domain/documents.js";
import { ModelService } from "../src/domain/models.js";
import { RefService } from "../src/domain/refs.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { startServer } from "./helpers.js";

const EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/research/evidence");
const evidence = (f: string) => JSON.parse(readFileSync(join(EVIDENCE, f), "utf8"));

const pageType = {
  id: "page",
  label: "Page",
  repeatable: true,
  status: true,
  json: {
    Main: {
      uid: { type: "UID", config: { label: "UID" } },
      title: { type: "StructuredText", config: { label: "Title", single: "heading1" } },
    },
  },
};
const h1 = (text: string) => [{ type: "heading1", text, spans: [] }];
const routes = [{ type: "page", path: "/:uid" }];

let srv: Awaited<ReturnType<typeof startServer>>;
let repos: RepositoryService;
let docs: DocumentService;
let refs: RefService;
const repoIds: Record<string, string> = {};
const ids: Record<string, string> = {};
let releaseToken: string; // master+releases access token of "blog"
let privateToken: string; // master-scope access token of "secret"
let secretReleaseRef: string;
let historicRef: string;

const endpoint = (repo: string) => `${srv.baseUrl}/r/${repo}/api/v2`;
const client = (repo = "blog", opts: { accessToken?: string } = {}): Client =>
  createClient(repo, { documentAPIEndpoint: endpoint(repo), routes, fetch, ...opts });
const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await srv.app.inject({ method: "GET", url: path, headers });
  return { status: res.statusCode, headers: res.headers, body: res.body ? (res.json() as any) : undefined };
};
const master = async (repo: string) => (await refs.currentMaster(repoIds[repo]!)).ref;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

beforeAll(async () => {
  srv = await startServer();
  repos = new RepositoryService(srv.sql);
  docs = new DocumentService(srv.sql);
  refs = new RefService(srv.sql, { secret: srv.app.config.secret, refTtlSeconds: srv.app.config.refTtlSeconds });
  const models = new ModelService(srv.sql);
  for (const [name, visibility] of [["blog", "public"], ["secret", "private"], ["openrepo", "open"]] as const) {
    const r = await repos.create({ name, masterLocale: { code: "en-us", name: "English" }, visibility });
    repoIds[name] = r.id;
    await repos.addLocale(r.id, { code: "fr-fr", name: "French" });
    await models.insertType(r.id, pageType);
  }
  const add = async (repo: string, uid: string, title: string, opts: { tags?: string[]; publish?: boolean; lang?: string; alt?: string } = {}) => {
    const { id } = await docs.create(repoIds[repo]!, "u", {
      type: "page", lang: opts.lang ?? "en-us", uid, tags: opts.tags ?? [], data: { title: h1(title) },
      ...(opts.alt ? { alternateOf: ids[opts.alt] } : {}),
    });
    ids[uid] = id;
    if (opts.publish !== false) await docs.publish(repoIds[repo]!, "u", [id]);
    return id;
  };
  await add("blog", "home", "Home v1", { tags: ["b-tag", "A-tag"] });
  historicRef = await master("blog");
  await docs.updateDraft(repoIds.blog!, "u", ids.home!, { data: { title: h1("Home v2") } });
  await docs.publish(repoIds.blog!, "u", [ids.home!]);
  for (let i = 1; i <= 4; i++) await add("blog", `post-${i}`, `Post ${i}`, { tags: i === 1 ? ["café"] : [] });
  await add("blog", "accueil", "Accueil", { lang: "fr-fr", alt: "home" });
  await add("blog", "draft", "Draft only", { publish: false, tags: ["hidden"] });
  // A release staging a doc that is not on master.
  await add("blog", "spring", "Spring sale", { publish: false });
  const rel = await docs.createRelease(repoIds.blog!, "u", "Spring", { scheduledAt: new Date("2030-01-01T00:00:00Z") });
  await docs.addToRelease(repoIds.blog!, "u", rel.id, ids.spring!);
  ({ token: releaseToken } = await repos.createToken(repoIds.blog!, "access", "rel", "master+releases"));

  await add("secret", "hidden-home", "Secret");
  await add("secret", "hidden-two", "Secret 2");
  await add("secret", "hidden-three", "Secret 3");
  ({ token: privateToken } = await repos.createToken(repoIds.secret!, "access", "ro", "master"));
  const srel = await docs.createRelease(repoIds.secret!, "u", "Secret release");
  secretReleaseRef = srel.ref;

  await add("openrepo", "open-home", "Open");
  const orel = await docs.createRelease(repoIds.openrepo!, "u", "Open release");
  await docs.addToRelease(repoIds.openrepo!, "u", orel.id, ids["open-home"]!);
});
afterAll(async () => srv.close());

describe("GET /api/v2", () => {
  it("returns the repository document with live-shaped forms and headers", async () => {
    const r = await get("/r/blog/api/v2");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("max-age=0, no-store");
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["x-prismic-version"]).toBe("6");
    expect(r.headers["content-type"]).toBe("application/json");
    const live = evidence("api-root.prismic-main.json");
    expect(Object.keys(r.body).filter((k) => k !== "integrationFieldsRef")).toEqual(Object.keys(live));
    expect(Object.keys(r.body.forms.everything.fields)).toEqual(Object.keys(live.forms.everything.fields));
    expect(r.body.forms.everything.fields).toEqual(live.forms.everything.fields);
    expect(r.body.forms.everything).toMatchObject({ method: "GET", enctype: "application/x-www-form-urlencoded" });
    expect(r.body.forms.everything.action).toMatch(/\/r\/blog\/api\/v2\/documents\/search$/);
    expect(r.body.forms.tags).toEqual({ ...live.forms.tags, action: expect.stringMatching(/\/r\/blog\/api\/tags$/) });
    expect(r.body.refs).toEqual([{ id: "master", ref: await master("blog"), label: "Master", isMasterRef: true }]);
    expect(r.body.languages).toEqual([
      { id: "en-us", name: "English", is_master: true },
      { id: "fr-fr", name: "French", is_master: false },
    ]);
    expect(r.body.types).toEqual({ page: "Page" });
    expect(r.body).toMatchObject({
      tags: [], bookmarks: {}, experiments: { draft: [], running: [] }, license: "All Rights Reserved",
      integrationFieldsRef: null, version: expect.any(String),
    });
    expect(r.body.oauth_initiate).toMatch(/\/r\/blog\/studio\/auth$/);
    expect(r.body.oauth_token).toMatch(/\/r\/blog\/studio\/auth\/token$/);
  });

  it("lists open non-migration releases only with a master+releases token (public) or on an open repo", async () => {
    const rel = await get(`/r/blog/api/v2?access_token=${releaseToken}`);
    expect(rel.body.refs).toHaveLength(2);
    expect(rel.body.refs[1]).toEqual({
      id: expect.any(String), ref: expect.any(String), label: "Spring", isMasterRef: false,
      scheduledAt: Date.parse("2030-01-01T00:00:00Z"),
    });
    const open = await get("/r/openrepo/api/v2");
    expect(open.body.refs.map((x: any) => x.label)).toEqual(["Master", "Open release"]);
    const priv = await get(`/r/secret/api/v2?access_token=${privateToken}`);
    expect(priv.body.refs).toHaveLength(1);
  });

  it("private repo: 401 without or with a bad token; the token may also come as Authorization: Token", async () => {
    expect(await get("/r/secret/api/v2")).toMatchObject({ status: 401, body: { error: "Invalid access token" } });
    expect((await get("/r/secret/api/v2?access_token=nope")).status).toBe(401);
    expect((await get("/r/secret/api/v2", { authorization: `Token ${privateToken}` })).status).toBe(200);
  });

  it("answers CORS preflight", async () => {
    const res = await srv.app.inject({
      method: "OPTIONS", url: "/r/blog/api/v2/documents/search",
      headers: { origin: "https://site.test", "access-control-request-method": "GET" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(String(res.headers["access-control-allow-methods"])).toContain("GET");
  });
});

describe("GET /api/v2/documents/search", () => {
  it("envelope keys equal the live key list, documents have the live key order", async () => {
    const r = await get(`/r/blog/api/v2/documents/search?${qs({ ref: await master("blog"), pageSize: "2" })}`);
    expect(r.status).toBe(200);
    const live = evidence("search.ordering.json");
    expect(Object.keys(r.body)).toEqual(Object.keys(live));
    expect(Object.keys(r.body.results[0])).toEqual(Object.keys(live.results[0]));
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["x-prismic-version"]).toBe("6");
    expect(r.body).toMatchObject({ page: 1, results_per_page: 2, results_size: 2, total_results_size: 5, total_pages: 3, prev_page: null });
    expect(r.body.license).toBe("All Rights Reserved");
  });

  it("renders the document envelope (href, dates, slugs, alternate_languages)", async () => {
    const ref = await master("blog");
    const q = `[[at(document.id, "${ids.home}")]]`;
    const r = await get(`/r/blog/api/v2/documents/search?${qs({ ref, q })}`);
    const d = r.body.results[0];
    expect(d).toMatchObject({
      id: ids.home, uid: "home", url: null, type: "page", tags: ["b-tag", "A-tag"], slugs: ["home-v2"],
      linked_documents: [], lang: "en-us", data: { title: h1("Home v2") },
      alternate_languages: [{ id: ids.accueil, uid: "accueil", type: "page", lang: "fr-fr" }],
    });
    expect(d.first_publication_date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/);
    const href = new URL(d.href);
    expect(href.pathname).toBe("/r/blog/api/v2/documents/search");
    expect(href.searchParams.get("ref")).toBe(ref);
    expect(href.searchParams.get("q")).toBe(`[[:d = at(document.id, "${ids.home}") ]]`);
  });

  it("no ref -> 400 api_validation_error", async () => {
    expect(await get("/r/blog/api/v2/documents/search")).toMatchObject({
      status: 400, body: { type: "api_validation_error", message: "Please specify ref" },
    });
  });

  it("bad ref -> 404 ending in the master ref; the official client recovers via retry", async () => {
    const r = await get("/r/blog/api/v2/documents/search?ref=stale");
    expect(r.status).toBe(404);
    expect(r.body.type).toBe("api_notfound_error");
    expect(r.body.message.endsWith(`Master ref is: ${await master("blog")}`)).toBe(true);
    expect(r.headers["cache-control"]).toBe("no-store");
    const res = await client().get({ ref: "stale" });
    expect(res.total_results_size).toBe(5);
  });

  it("a parse error gives a 400 api_parsing_error body; the client throws ParsingError", async () => {
    const ref = await master("blog");
    const r = await get(`/r/blog/api/v2/documents/search?${qs({ ref, q: '[[foo(document.type,"blog")]]' })}`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      type: "api_parsing_error", message: expect.any(String),
      pos: { line: expect.any(Number), column: expect.any(Number), id: 0, location: "query" },
    });
    const bad = await get(`/r/blog/api/v2/documents/search?${qs({ ref, routes: "not json" })}`);
    expect(bad).toMatchObject({ status: 400, body: { type: "api_parsing_error", message: expect.any(String) } });
    await expect(client().get({ filters: ['[foo(document.type,"x")]'] })).rejects.toBeInstanceOf(ParsingError);
  });

  it("private repo without a token -> 401 and ForbiddenError; bad ref is checked first", async () => {
    const ref = await master("secret");
    expect(await get(`/r/secret/api/v2/documents/search?ref=${ref}`)).toMatchObject({ status: 401, body: { error: "Invalid access token" } });
    expect((await get("/r/secret/api/v2/documents/search?ref=nope")).status).toBe(404);
    expect((await get(`/r/secret/api/v2/documents/search?ref=${ref}&access_token=${privateToken}`)).body.total_results_size).toBe(3);
    await expect(client("secret").get()).rejects.toBeInstanceOf(ForbiddenError);
    expect((await client("secret", { accessToken: privateToken }).get()).total_results_size).toBe(3);
  });

  it("private repo, no token, malformed q -> 401 (token is checked before the query is parsed)", async () => {
    const r = await get(`/r/secret/api/v2/documents/search?${qs({ ref: await master("secret"), q: "[[foo(" })}`);
    expect(r).toMatchObject({ status: 401, body: { error: "Invalid access token" } });
  });

  it("cache-control (R18): public master immutable, private master private, release no-store", async () => {
    const pub = await get(`/r/blog/api/v2/documents/search?ref=${await master("blog")}`);
    expect(pub.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const priv = await get(`/r/secret/api/v2/documents/search?ref=${await master("secret")}`, { authorization: `Token ${privateToken}` });
    expect(priv.status).toBe(200);
    expect(priv.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    const historic = await get(`/r/blog/api/v2/documents/search?ref=${historicRef}`);
    expect(historic.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const [orel] = await srv.sql`select ref from releases where repo_id = ${repoIds.openrepo!}`;
    const rel = await get(`/r/openrepo/api/v2/documents/search?ref=${orel!.ref}`);
    expect(rel.status).toBe(200);
    expect(rel.headers["cache-control"]).toBe("no-store");
  });

  it("next_page does not echo access_token (R19); dangerouslyGetAll with accessToken still pages through", async () => {
    const r = await get(`/r/secret/api/v2/documents/search?${qs({ ref: await master("secret"), pageSize: "1", access_token: privateToken })}`);
    expect(r.body.total_pages).toBe(3);
    const next = new URL(r.body.next_page);
    expect(next.searchParams.has("access_token")).toBe(false);
    expect(next.searchParams.get("page")).toBe("2");
    const p2 = await get(`/r/secret/api/v2/documents/search?${qs({ ref: await master("secret"), pageSize: "1", page: "2", access_token: privateToken })}`);
    expect(new URL(p2.body.prev_page).searchParams.has("access_token")).toBe(false);
    const all = await client("secret", { accessToken: privateToken }).dangerouslyGetAll({ pageSize: 1 });
    expect(all.map((d) => d.uid).sort()).toEqual(["hidden-home", "hidden-three", "hidden-two"]);
  });

  it("a release ref with a master-scope token on a private repo -> 401", async () => {
    const r = await get(`/r/secret/api/v2/documents/search?ref=${secretReleaseRef}&access_token=${privateToken}`);
    expect(r).toMatchObject({ status: 401, body: { error: "Invalid access token" } });
  });

  it("page past the end", async () => {
    const r = await get(`/r/blog/api/v2/documents/search?${qs({ ref: await master("blog"), page: "99" })}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page: 99, results: [], results_size: 0, total_results_size: 5, next_page: null });
  });

  it("pageSize=101 -> results_per_page: 100", async () => {
    const r = await get(`/r/blog/api/v2/documents/search?${qs({ ref: await master("blog"), pageSize: "101" })}`);
    expect(r.body.results_per_page).toBe(100);
  });

  it("next_page/prev_page echo the params (not routes) with the page changed", async () => {
    const ref = await master("blog");
    const r = await get(`/r/blog/api/v2/documents/search?${qs({
      ref, q: '[[at(document.type,"page")]]', orderings: "[my.page.title]", page: "2", pageSize: "2",
      routes: JSON.stringify(routes), lang: "en-us",
    })}`);
    const next = new URL(r.body.next_page);
    expect([...next.searchParams.keys()]).toEqual(["ref", "q", "orderings", "page", "pageSize", "lang"]);
    expect(next.searchParams.get("page")).toBe("3");
    expect(new URL(r.body.prev_page).searchParams.get("page")).toBe("1");
    expect(r.body.results[0].url).toMatch(/^\/post-/);
  });

  it("emits proxied absolute URLs", async () => {
    const headers = { "x-forwarded-host": "cms.example.com", "x-forwarded-proto": "https" };
    const r = await get(`/r/blog/api/v2/documents/search?${qs({ ref: await master("blog"), pageSize: "1" })}`, headers);
    expect(r.body.next_page.startsWith("https://cms.example.com/r/blog/")).toBe(true);
    expect(r.body.results[0].href.startsWith("https://cms.example.com/r/blog/")).toBe(true);
    const api = await get("/r/blog/api/v2", headers);
    expect(api.body.forms.tags.action.startsWith("https://cms.example.com/r/blog/")).toBe(true);
    expect(api.body.forms.everything.action.startsWith("https://cms.example.com/r/blog/")).toBe(true);
  });

  it("lang=* returns every locale; the default is the master locale", async () => {
    const ref = await master("blog");
    expect((await get(`/r/blog/api/v2/documents/search?${qs({ ref, lang: "*" })}`)).body.total_results_size).toBe(6);
    expect((await get(`/r/blog/api/v2/documents/search?${qs({ ref, lang: "fr-fr" })}`)).body.total_results_size).toBe(1);
  });
});

describe("GET /api/tags", () => {
  it("returns tags of live documents, byte-ordered, and getTags() goes through forms.tags.action", async () => {
    const r = await get("/r/blog/api/tags");
    expect(r.status).toBe(200);
    expect(r.body).toEqual(["A-tag", "b-tag", "café"]);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(await client().getTags()).toEqual(["A-tag", "b-tag", "café"]);
    expect((await get("/r/secret/api/tags")).status).toBe(401);
    expect((await get(`/r/secret/api/tags?access_token=${privateToken}`)).body).toEqual([]);
  });
});

describe("official client end to end (refs, releases, previews)", () => {
  it("getByUID through queryContentFromReleaseByLabel sees release content; master does not", async () => {
    const c = client("blog", { accessToken: releaseToken });
    c.queryContentFromReleaseByLabel("Spring");
    const doc = await c.getByUID("page", "spring");
    expect(doc.data.title).toEqual(h1("Spring sale"));
    await expect(client().getByUID("page", "spring")).rejects.toThrow();
    const r = await get(`/r/blog/api/v2/documents/search?${qs({ ref: (await c.getReleaseByLabel("Spring")).ref, access_token: releaseToken })}`);
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("a release ref without a master+releases token on a public repo -> 401", async () => {
    const [rel] = await srv.sql`select ref from releases where repo_id = ${repoIds.blog!} and label = 'Spring'`;
    expect((await get(`/r/blog/api/v2/documents/search?ref=${rel!.ref}`)).status).toBe(401);
    // Open repo: releases are public.
    const [orel] = await srv.sql`select ref from releases where repo_id = ${repoIds.openrepo!}`;
    expect((await get(`/r/openrepo/api/v2/documents/search?ref=${orel!.ref}`)).status).toBe(200);
  });

  it("resolvePreviewURL with a preview token returns the draft doc's route URL", async () => {
    const previewToken = refs.createPreviewToken(repoIds.blog!, "drafts", ids.draft);
    const url = await client().resolvePreviewURL({ defaultURL: "/", previewToken, documentID: ids.draft! });
    expect(url).toBe("/draft");
  });

  it("a preview token sees an unpublished draft, with non-null +0000 dates and no-store caching", async () => {
    const previewToken = refs.createPreviewToken(repoIds.blog!, "drafts");
    const doc = await client().getByUID("page", "draft", { ref: previewToken });
    expect(doc.data.title).toEqual(h1("Draft only"));
    expect(doc.first_publication_date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/);
    expect(doc.last_publication_date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/);
    const r = await get(`/r/blog/api/v2/documents/search?${qs({ ref: previewToken })}`);
    expect(r.headers["cache-control"]).toBe("no-store");
    await expect(client().getByUID("page", "draft")).rejects.toThrow();
  });

  it("an expired preview token -> PreviewTokenExpiredError", async () => {
    const expired = refs.createPreviewToken(repoIds.blog!, "drafts", undefined, -10);
    await expect(client().get({ ref: expired })).rejects.toBeInstanceOf(PreviewTokenExpiredError);
  });

  it("toolbar JSON cookie as ref resolves to the preview (keyed by this request's host)", async () => {
    const token = refs.createPreviewToken(repoIds.blog!, "drafts");
    const host = new URL(srv.baseUrl).host;
    // Two hosts: only keying by this request's host picks the right entry.
    const cookie = `{%22_tracker%22:%22abcd1234%22%2C%22other.test%22:{%22preview%22:%22stale%22}%2C%22${host}%22:{%22preview%22:%22${token}%22}}`;
    const doc = await client().getByUID("page", "draft", { ref: cookie });
    expect(doc.data.title).toEqual(h1("Draft only"));
  });

  it("historic ref within TTL returns old content; past TTL the client retries onto master", async () => {
    const c = client();
    expect((await c.getByUID("page", "home", { ref: historicRef })).data.title).toEqual(h1("Home v1"));
    // Age the publication that superseded the historic ref beyond the TTL.
    await srv.sql`update publications set created_at = now() - interval '2 hours'
      where repo_id = ${repoIds.blog!} and seq = (select min(seq) from publications
        where repo_id = ${repoIds.blog!} and seq > (select seq from publications where ref = ${historicRef}))`;
    const raw = await get(`/r/blog/api/v2/documents/search?ref=${historicRef}`);
    expect(raw.status).toBe(410);
    expect((await client().getByUID("page", "home", { ref: historicRef })).data.title).toEqual(h1("Home v2"));
  });
});

describe("rate limiting (SMALTIC_RATE_LIMIT)", () => {
  it("returns 429 with Retry-After and x-ratelimit-* when the per-repo limit is exceeded", async () => {
    const s = await startServer({ env: { SMALTIC_RATE_LIMIT: "2" } });
    try {
      await new RepositoryService(s.sql).create({ name: "limited", masterLocale: { code: "en-us", name: "English" } });
      const results = await Promise.all(Array.from({ length: 6 }, () => s.app.inject({ method: "GET", url: "/r/limited/api/v2" })));
      const limited = results.filter((r) => r.statusCode === 429);
      expect(limited.length).toBeGreaterThan(0);
      expect(limited[0]!.headers["retry-after"]).toBe("1");
      expect(limited[0]!.headers["x-ratelimit-limit"]).toBe("2");
      expect(limited[0]!.headers["x-ratelimit-remaining"]).toBe("0");
      expect(Number(limited[0]!.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
      const ok = results.find((r) => r.statusCode === 200)!;
      expect(ok.headers["x-ratelimit-limit"]).toBe("2");
    } finally {
      await s.close();
    }
    // Off by default.
    const many = await Promise.all(Array.from({ length: 6 }, () => srv.app.inject({ method: "GET", url: "/r/blog/api/v2" })));
    expect(many.every((r) => r.statusCode === 200)).toBe(true);
  });
});
