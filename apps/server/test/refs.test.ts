import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEV_SECRET, loadConfig } from "../src/config.js";
import { migrate } from "../src/db/index.js";
import { DocumentService } from "../src/domain/documents.js";
import { ModelService } from "../src/domain/models.js";
import {
  PreviewExpiredError,
  RefExpiredError,
  RefNotFoundError,
  RefService,
} from "../src/domain/refs.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { search } from "../src/query/compile.js";
import { parseQueries } from "../src/query/filterParser.js";
import type { RefScope } from "../src/query/visible.js";
import { createTestDb, startServer } from "./helpers.js";

const SECRET = "test-secret";
const articleType = {
  id: "article",
  label: "Article",
  repeatable: true,
  status: true,
  json: {
    Main: {
      uid: { type: "UID", config: { label: "UID" } },
      title: { type: "StructuredText", config: { label: "Title", single: "heading1" } },
    },
  },
};
const h1 = (text: string) => ({ title: [{ type: "heading1", text, spans: [] }] });
const titleOf = (data: any): string => data?.title?.[0]?.text;

let db: Awaited<ReturnType<typeof createTestDb>>;
let repoId: string;
let otherRepoId: string;
let docs: DocumentService;
let refs: RefService;
const ids: Record<string, string> = {};
let historicRef: string;
let releaseRef: string;
let releaseId: string;

beforeAll(async () => {
  db = await createTestDb();
  await migrate(db.sql);
  const repos = new RepositoryService(db.sql);
  repoId = (await repos.create({ name: "refs-repo", masterLocale: { code: "en-us", name: "English" } })).id;
  otherRepoId = (await repos.create({ name: "other-repo", masterLocale: { code: "en-us", name: "English" } })).id;
  await new ModelService(db.sql).insertType(repoId, articleType);
  docs = new DocumentService(db.sql);
  refs = new RefService(db.sql, { secret: SECRET, refTtlSeconds: 3600 });

  const add = async (uid: string, title: string, publish = true) => {
    const { id } = await docs.create(repoId, "u", { type: "article", lang: "en-us", uid, tags: [], data: h1(title) });
    ids[uid] = id;
    if (publish) await docs.publish(repoId, "u", [id]);
  };
  await add("home", "Home v1");
  historicRef = (await refs.currentMaster(repoId)).ref;
  await docs.updateDraft(repoId, "u", ids.home!, { data: h1("Home v2") });
  await docs.publish(repoId, "u", [ids.home!]);
  await add("published", "Published");
  await add("unpublished", "Never published", false);
  await add("archived", "Archived");
  await docs.unpublish(repoId, "u", [ids.archived!]);
  await add("spring", "Spring sale", false);
  const rel = await docs.createRelease(repoId, "u", "Spring");
  releaseId = rel.id;
  releaseRef = rel.ref;
  await docs.addToRelease(repoId, "u", releaseId, ids.spring!);
});
afterAll(async () => db.drop());

async function titles(scope: RefScope): Promise<string[]> {
  const { rows } = await search(db.sql, repoId, scope, { filters: parseQueries([]), page: 1, pageSize: 100, lang: "*" });
  return rows.map((r) => titleOf(r.data)).sort();
}

describe("resolveRef: master refs", () => {
  it("resolves the current master ref", async () => {
    const m = await refs.currentMaster(repoId);
    expect(await refs.resolveRef(repoId, m.ref)).toEqual({ kind: "master", seq: m.seq });
  });

  it("resolves a historic ref within TTL to the old content", async () => {
    const scope = await refs.resolveRef(repoId, historicRef);
    expect(scope.kind).toBe("historic");
    expect(await titles(scope)).toEqual(["Home v1"]);
  });

  it("rejects a historic ref past TTL with RefExpiredError carrying master", async () => {
    const short = new RefService(db.sql, { secret: SECRET, refTtlSeconds: 60 });
    // Backdate every publication after the historic one: it stopped being master 2 hours ago.
    const [h] = await db.sql`select seq from publications where ref = ${historicRef}`;
    await db.sql`update publications set created_at = now() - interval '2 hours' where repo_id = ${repoId} and seq > ${h!.seq}`;
    try {
      const master = (await refs.currentMaster(repoId)).ref;
      const err = await short.resolveRef(repoId, historicRef).catch((e) => e);
      expect(err).toBeInstanceOf(RefExpiredError);
      expect(err.master).toBe(master);
      // The default TTL (1h) is also exceeded by 2h.
      await expect(refs.resolveRef(repoId, historicRef)).rejects.toBeInstanceOf(RefExpiredError);
    } finally {
      await db.sql`update publications set created_at = now() where repo_id = ${repoId} and seq > ${h!.seq}`;
    }
  });

  it("rejects an unknown ref with RefNotFoundError carrying master", async () => {
    const master = (await refs.currentMaster(repoId)).ref;
    const err = await refs.resolveRef(repoId, "nope-nope-nope12").catch((e) => e);
    expect(err).toBeInstanceOf(RefNotFoundError);
    expect(err.master).toBe(master);
  });

  it("does not resolve another repository's master ref", async () => {
    const other = (await refs.currentMaster(otherRepoId)).ref;
    await expect(refs.resolveRef(repoId, other)).rejects.toBeInstanceOf(RefNotFoundError);
  });
});

describe("resolveRef: release refs", () => {
  it("resolves a release ref; release overlay sees staged content and master does not", async () => {
    const scope = await refs.resolveRef(repoId, releaseRef);
    expect(scope).toMatchObject({ kind: "release", releaseId });
    expect(await titles(scope)).toEqual(["Home v2", "Published", "Spring sale"]);
    const master = await refs.resolveRef(repoId, (await refs.currentMaster(repoId)).ref);
    expect(await titles(master)).toEqual(["Home v2", "Published"]);
  });

  it("release overlay replaces the live version of a staged document", async () => {
    const r = await docs.createRelease(repoId, "u", "Home redesign");
    await docs.updateDraft(repoId, "u", ids.home!, { data: h1("Home v3") });
    await docs.addToRelease(repoId, "u", r.id, ids.home!);
    try {
      expect(await titles(await refs.resolveRef(repoId, r.ref))).toEqual(["Home v3", "Published"]);
      expect(await titles(await refs.resolveRef(repoId, (await refs.currentMaster(repoId)).ref))).toEqual(["Home v2", "Published"]);
    } finally {
      await docs.updateDraft(repoId, "u", ids.home!, { data: h1("Home v2") });
    }
  });

  it("a deleted release's ref is not found", async () => {
    const r = await docs.createRelease(repoId, "u", "Gone");
    await docs.deleteRelease(repoId, "u", r.id);
    await expect(refs.resolveRef(repoId, r.ref)).rejects.toBeInstanceOf(RefNotFoundError);
  });
});

describe("resolveRef: preview tokens", () => {
  it("a drafts preview token sees unpublished drafts but not archived documents", async () => {
    const token = refs.createPreviewToken(repoId, "drafts", ids.unpublished);
    expect(token).toMatch(/^pv\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const scope = await refs.resolveRef(repoId, token);
    expect(scope).toMatchObject({ kind: "preview", overlay: "drafts" });
    expect(await titles(scope)).toEqual(["Home v2", "Never published", "Published", "Spring sale"]);
  });

  it("a release preview token sees the release content", async () => {
    const scope = await refs.resolveRef(repoId, refs.createPreviewToken(repoId, { releaseId }));
    expect(scope).toMatchObject({ kind: "preview", overlay: { releaseId } });
    expect(await titles(scope)).toEqual(["Home v2", "Published", "Spring sale"]);
  });

  it("a release preview token ends (PreviewExpiredError) once its release is no longer open", async () => {
    const r = await docs.createRelease(repoId, "u", "Short-lived");
    const token = refs.createPreviewToken(repoId, { releaseId: r.id });
    await docs.deleteRelease(repoId, "u", r.id);
    await expect(refs.resolveRef(repoId, token)).rejects.toBeInstanceOf(PreviewExpiredError);
  });

  it("an expired token throws PreviewExpiredError", async () => {
    const token = refs.createPreviewToken(repoId, "drafts", undefined, -10);
    await expect(refs.resolveRef(repoId, token)).rejects.toBeInstanceOf(PreviewExpiredError);
  });

  it("a tampered token is not found", async () => {
    const token = refs.createPreviewToken(repoId, "drafts");
    const [pv, payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ r: repoId, o: "drafts", exp: 9999999999 })).toString("base64url");
    await expect(refs.resolveRef(repoId, `${pv}.${forged}.${mac}`)).rejects.toBeInstanceOf(RefNotFoundError);
    const flipped = mac!.slice(0, -1) + (mac!.endsWith("A") ? "B" : "A");
    await expect(refs.resolveRef(repoId, `${pv}.${payload}.${flipped}`)).rejects.toBeInstanceOf(RefNotFoundError);
    const otherKey = new RefService(db.sql, { secret: "another-secret", refTtlSeconds: 3600 });
    await expect(otherKey.resolveRef(repoId, token)).rejects.toBeInstanceOf(RefNotFoundError);
    await expect(refs.resolveRef(repoId, "pv.garbage")).rejects.toBeInstanceOf(RefNotFoundError);
  });

  it("a token for another repository is not found", async () => {
    const token = refs.createPreviewToken(otherRepoId, "drafts");
    await expect(refs.resolveRef(repoId, token)).rejects.toBeInstanceOf(RefNotFoundError);
  });
});

describe("resolveRef: toolbar JSON cookie", () => {
  const HOST = "blog.cms.test";

  it("accepts toolbar JSON cookie as ref", async () => {
    const token = refs.createPreviewToken(repoId, "drafts");
    // As the query parser hands it over after decoding `ref=%7B%22blog.cms.test%22%3A%7B%22preview%22%3A%22<token>%22%7D%7D`.
    const decoded = `{"${HOST}":{"preview":"${token}"}}`;
    expect(await refs.resolveRef(repoId, decoded, { host: HOST })).toMatchObject({ kind: "preview", overlay: "drafts" });
    // The cookie value as written by the toolbar (`"` kept as %22, `,` as %2C) and sent verbatim as ref.
    const toolbar = `{%22_tracker%22:%22abcd1234%22%2C%22${HOST}%22:{%22preview%22:%22${token}%22}}`;
    expect(await refs.resolveRef(repoId, toolbar, { host: HOST })).toMatchObject({ kind: "preview", overlay: "drafts" });
    // Fully percent-encoded.
    expect(await refs.resolveRef(repoId, encodeURIComponent(decoded), { host: HOST })).toMatchObject({ kind: "preview" });
  });

  it("selects the entry for the request host, ignoring other hosts", async () => {
    const mine = refs.createPreviewToken(repoId, "drafts");
    const theirs = refs.createPreviewToken(otherRepoId, "drafts");
    const blob = `{"other.cms.test":{"preview":"${theirs}"},"${HOST}":{"preview":"${mine}"}}`;
    expect(await refs.resolveRef(repoId, blob, { host: HOST })).toMatchObject({ kind: "preview" });
    expect(await refs.resolveRef(repoId, blob, { host: `${HOST.toUpperCase()}:443` })).toMatchObject({ kind: "preview" });
  });

  it("falls back to the only preview entry when no key matches the host", async () => {
    const token = refs.createPreviewToken(repoId, "drafts");
    const blob = `{"_tracker":"x","repo.prismic.io":{"preview":"${token}"}}`;
    expect(await refs.resolveRef(repoId, blob, { host: HOST })).toMatchObject({ kind: "preview" });
    expect(await refs.resolveRef(repoId, blob)).toMatchObject({ kind: "preview" });
  });

  it("is not found when several entries exist and none matches the host", async () => {
    const t = refs.createPreviewToken(repoId, "drafts");
    const blob = `{"a.test":{"preview":"${t}"},"b.test":{"preview":"${t}"}}`;
    await expect(refs.resolveRef(repoId, blob, { host: HOST })).rejects.toBeInstanceOf(RefNotFoundError);
    await expect(refs.resolveRef(repoId, "{not json", { host: HOST })).rejects.toBeInstanceOf(RefNotFoundError);
  });

  it("a cookie entry holding a plain release ref resolves to that release", async () => {
    const blob = `{"${HOST}":{"preview":"${releaseRef}"}}`;
    expect(await refs.resolveRef(repoId, blob, { host: HOST })).toMatchObject({ kind: "release", releaseId });
  });

  it("an expired token inside the cookie throws PreviewExpiredError", async () => {
    const token = refs.createPreviewToken(repoId, "drafts", undefined, -1);
    await expect(refs.resolveRef(repoId, `{"${HOST}":{"preview":"${token}"}}`, { host: HOST })).rejects.toBeInstanceOf(
      PreviewExpiredError,
    );
  });
});

describe("config: SMALTIC_SECRET (R17)", () => {
  const prod = (secret?: string) => ({ NODE_ENV: "production", ...(secret !== undefined ? { SMALTIC_SECRET: secret } : {}) });

  it("production + missing or empty secret throws", () => {
    expect(() => loadConfig(prod())).toThrow(/SMALTIC_SECRET must be set in production/);
    expect(() => loadConfig(prod(""))).toThrow(/SMALTIC_SECRET must be set in production/);
  });
  it("production + dev default secret throws", () => {
    expect(() => loadConfig(prod(DEV_SECRET))).toThrow(/development default/);
  });
  it("production + short secret throws", () => {
    expect(() => loadConfig(prod("x".repeat(31)))).toThrow(/at least 32 characters/);
  });
  it("production + 32+ char secret is accepted without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const secret = "s".repeat(32);
      expect(loadConfig(prod(secret)).secret).toBe(secret);
      expect(loadConfig(prod("s".repeat(64))).secret).toBe("s".repeat(64));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it("outside production a missing secret falls back to the dev default with a single warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadConfig({}).secret).toBe(DEV_SECRET);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/SMALTIC_SECRET/);
      warn.mockClear();
      expect(loadConfig({ NODE_ENV: "development", SMALTIC_SECRET: "custom" }).secret).toBe("custom");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it("RefService requires a non-empty secret", () => {
    expect(() => new RefService(db.sql, { secret: "" })).toThrow(/secret/);
  });
});

describe("config", () => {
  it("reads SMALTIC_REF_TTL_SECONDS with a 3600 default", () => {
    expect(loadConfig({}).refTtlSeconds).toBe(3600);
    expect(loadConfig({ SMALTIC_REF_TTL_SECONDS: "120" }).refTtlSeconds).toBe(120);
    expect(loadConfig({ SMALTIC_REF_TTL_SECONDS: "junk" }).refTtlSeconds).toBe(3600);
  });
});

describe("preview API", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let auth: { authorization: string; repository: string };
  let docId: string;
  let relId: string;

  beforeAll(async () => {
    srv = await startServer({ config: { secret: SECRET } });
    const repos = new RepositoryService(srv.sql);
    const repo = await repos.create({ name: "prev-repo", masterLocale: { code: "en-us", name: "English" } });
    await new ModelService(srv.sql).insertType(repo.id, articleType);
    const { token } = await repos.createToken(repo.id, "write", "w");
    auth = { authorization: `Bearer ${token}`, repository: "prev-repo" };
    const d = new DocumentService(srv.sql);
    docId = (await d.create(repo.id, "u", { type: "article", lang: "en-us", uid: "draft", tags: [], data: h1("Draft") })).id;
    relId = (await d.createRelease(repo.id, "u", "Spring")).id;
  });
  afterAll(async () => srv.close());

  const inject = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = auth) =>
    srv.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it("requires a write token", async () => {
    expect((await inject("GET", "/previews/configs", undefined, { repository: "prev-repo" })).statusCode).toBe(401);
    expect((await inject("GET", `/previews/session?documentId=${docId}`, undefined, { repository: "prev-repo" })).statusCode).toBe(401);
    expect((await inject("GET", "/previews/configs", undefined, { ...auth, repository: "missing-repo" })).statusCode).toBe(403);
  });

  it("CRUDs preview configs", async () => {
    const bad = await inject("POST", "/previews/configs", { name: "", website_url: "ftp://x", resolver_path: "/p" });
    expect(bad.statusCode).toBe(400);
    const created = await inject("POST", "/previews/configs", {
      name: "Development", website_url: "http://localhost:3000/", resolver_path: "/api/preview",
    });
    expect(created.statusCode).toBe(201);
    const cfg = created.json();
    expect(cfg).toMatchObject({ name: "Development", website_url: "http://localhost:3000/", resolver_path: "/api/preview" });
    expect((await inject("POST", "/previews/configs", { name: "Development", website_url: "http://x.test", resolver_path: "/" })).statusCode).toBe(409);
    const upd = await inject("PUT", `/previews/configs/${cfg.id}`, { name: "Dev", website_url: "http://localhost:3000", resolver_path: "/api/preview" });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().name).toBe("Dev");
    const list = await inject("GET", "/previews/configs");
    expect(list.json()).toEqual([expect.objectContaining({ id: cfg.id, name: "Dev" })]);
    const tmp = (await inject("POST", "/previews/configs", { name: "Tmp", website_url: "https://tmp.test", resolver_path: "/p" })).json();
    expect((await inject("DELETE", `/previews/configs/${tmp.id}`)).statusCode).toBe(204);
    expect((await inject("DELETE", `/previews/configs/${tmp.id}`)).statusCode).toBe(404);
  });

  it("starts a preview session with a token and previewUrl", async () => {
    const res = await inject("GET", `/previews/session?documentId=${docId}`);
    expect(res.statusCode).toBe(200);
    const { token, previewUrl } = res.json();
    expect(token).toMatch(/^pv\./);
    expect(previewUrl).toBe(`http://localhost:3000/api/preview?token=${encodeURIComponent(token)}&documentId=${encodeURIComponent(docId)}`);
    const refs2 = new RefService(srv.sql, { secret: SECRET, refTtlSeconds: 3600 });
    const repo = await new RepositoryService(srv.sql).getByName("prev-repo");
    expect(await refs2.resolveRef(repo!.id, token)).toMatchObject({ kind: "preview", overlay: "drafts" });

    const rel = (await inject("GET", `/previews/session?documentId=${docId}&release=${relId}`)).json();
    expect(await refs2.resolveRef(repo!.id, rel.token)).toMatchObject({ kind: "preview", overlay: { releaseId: relId } });
  });

  it("rejects unknown documents and releases", async () => {
    expect((await inject("GET", "/previews/session?documentId=nope")).statusCode).toBe(404);
    expect((await inject("GET", `/previews/session?documentId=${docId}&release=nope`)).statusCode).toBe(404);
  });
});
