import * as ct from "@prismicio/custom-types-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelService, HasExistingDocuments } from "../src/domain/models.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { startServer } from "./helpers.js";

let s: Awaited<ReturnType<typeof startServer>>;
let repoId: string;
let client: ReturnType<typeof ct.createClient>;
let noToken: ReturnType<typeof ct.createClient>;
let tokenValue: string;

const pageType = {
  id: "page",
  label: "Page",
  repeatable: true,
  status: true,
  format: "page",
  json: {
    Main: {
      uid: { type: "UID", config: { label: "UID", placeholder: "" } },
      title: { type: "StructuredText", config: { label: "Title", single: "heading1" } },
    },
  },
};
const slice = {
  id: "image_gallery",
  type: "SharedSlice",
  name: "ImageGallery",
  description: "ImageGallery",
  variations: [
    {
      id: "default",
      name: "Default",
      docURL: "...",
      version: "sktwi1xtmkfgx8626",
      description: "Text",
      primary: { text: { type: "StructuredText", config: { label: "Text", placeholder: "Text", allowTargetBlank: false, multi: "paragraph" } } },
      items: {},
      imageUrl: "https://example.com/preview.png",
    },
  ],
};

beforeAll(async () => {
  s = await startServer();
  const svc = new RepositoryService(s.sql);
  const repo = await svc.create({ name: "blog", masterLocale: { code: "en-us", name: "English" } });
  repoId = (repo as any).id ?? (repo as any).repo?.id;
  const created = await svc.createToken(repoId, "write", "t");
  const tok = typeof created === "string" ? created : (created as any).token;
  tokenValue = tok;
  const endpoint = `${s.baseUrl}/customtypes-api`;
  client = ct.createClient({ endpoint, repositoryName: "blog", token: tok, fetch });
  noToken = ct.createClient({ endpoint, repositoryName: "blog", fetch });
}, 30000);
afterAll(async () => s.close());

describe("Custom Types API", () => {
  it("inserts and reads back a type and a slice deep-equal", async () => {
    await client.insertCustomType(pageType as any);
    await client.insertSharedSlice(slice as any);
    expect(await client.getCustomTypeByID("page")).toEqual(pageType);
    expect(await client.getSharedSliceByID("image_gallery")).toEqual(slice);
    expect(await client.getAllCustomTypes()).toEqual([pageType]);
    expect(await client.getAllSharedSlices()).toEqual([slice]);
  });
  it("updates a type", async () => {
    const next = { ...pageType, label: "Pages" };
    await client.updateCustomType(next as any);
    expect((await client.getCustomTypeByID("page")).label).toBe("Pages");
    await client.updateCustomType(pageType as any);
  });
  it("conflicts on duplicate insert", async () => {
    await expect(client.insertCustomType(pageType as any)).rejects.toBeInstanceOf(ct.ConflictError);
    await expect(client.insertSharedSlice(slice as any)).rejects.toBeInstanceOf(ct.ConflictError);
  });
  it("not found on update of a missing type", async () => {
    await expect(client.updateCustomType({ ...pageType, id: "ghost" } as any)).rejects.toBeInstanceOf(ct.NotFoundError);
    await expect(client.getCustomTypeByID("ghost")).rejects.toBeInstanceOf(ct.NotFoundError);
  });
  it("rejects invalid models", async () => {
    await expect(client.insertCustomType({ id: "bad", json: 5 } as any)).rejects.toBeInstanceOf(ct.InvalidPayloadError);
  });
  it("rejects missing token with 401", async () => {
    await expect(noToken.getAllCustomTypes()).rejects.toBeInstanceOf(ct.UnauthorizedError);
  });
  it("bulkUpdate applies insert and delete", async () => {
    await client.insertCustomType({ ...pageType, id: "tmp" } as any);
    await client.bulkUpdate([
        { type: "CUSTOM_TYPE_INSERT", id: "article", payload: { ...pageType, id: "article" } },
        { type: "CUSTOM_TYPE_DELETE", id: "tmp", payload: { id: "tmp" } },
    ] as any);
    expect((await client.getAllCustomTypes()).map((t: { id: string }) => t.id).sort()).toEqual(["article", "page"]);
  });
  it("records history", async () => {
    const rows = await s.sql`select op from model_history where repo_id = ${repoId} and id = 'tmp' order by seq`;
    expect(rows.map((r) => r.op)).toEqual(["insert", "delete"]);
  });
  it("removes a slice and a type", async () => {
    await client.removeSharedSlice("image_gallery");
    await client.removeCustomType("article");
    expect(await client.getAllSharedSlices()).toEqual([]);
  });
});

describe("ModelService.removeType", () => {
  it("throws HasExistingDocuments when documents exist", async () => {
    const svc = new ModelService(s.sql, async () => 1);
    await expect(svc.removeType(repoId, "page")).rejects.toBeInstanceOf(HasExistingDocuments);
    expect(await svc.getType(repoId, "page")).toBeTruthy();
  });
  it("route replies 403 JSON with hasExistingDocuments", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp({ config: s.app.config, sql: s.sql, countDocumentsOfType: async () => 2 });
    const tok = tokenValue;
    const r = await app.inject({
      method: "DELETE",
      url: "/customtypes-api/customtypes/page",
      headers: { repository: "blog", authorization: `Bearer ${tok}` },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ hasExistingDocuments: true });
    await app.close();
  });
});

describe("bulk-update atomicity and auth branches", () => {
  const call = (path: string, headers: Record<string, string>, body?: unknown) =>
    fetch(`${s.baseUrl}/customtypes-api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const auth = () => ({ repository: "blog", authorization: `Bearer ${tokenValue}` });

  it("rolls back a bulk-update when a later change fails", async () => {
    const r = await call("/bulk-update", auth(), {
      changes: [
        { type: "CUSTOM_TYPE_INSERT", id: "atomic_a", payload: { ...pageType, id: "atomic_a" } },
        { type: "CUSTOM_TYPE_UPDATE", id: "missing_x", payload: { ...pageType, id: "missing_x" } },
      ],
    });
    expect(r.status).toBe(400);
    expect((await call("/customtypes/atomic_a", auth())).status).toBe(404);
    const rows = await s.sql`select 1 from model_history where repo_id = ${repoId} and id = 'atomic_a'`;
    expect(rows.length).toBe(0);
  });

  it("rejects an access (read) token on a write route with 401", async () => {
    const t = await new RepositoryService(s.sql).createToken(repoId, "access", "ro");
    const r = await call("/customtypes", { repository: "blog", authorization: `Bearer ${t.token}` });
    expect(r.status).toBe(401);
  });

  it("rejects another repository's write token with 401", async () => {
    const svc = new RepositoryService(s.sql);
    const other = await svc.create({ name: "other-repo", masterLocale: { code: "en-us", name: "English" } });
    const t = await svc.createToken((other as any).id ?? (other as any).repo?.id, "write", "o");
    const r = await call("/customtypes", { repository: "blog", authorization: `Bearer ${t.token}` });
    expect(r.status).toBe(401);
  });

  it("unknown repository header gives 403 JSON", async () => {
    const r = await call("/customtypes", { repository: "nope-repo", authorization: `Bearer ${tokenValue}` });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ message: "Repository not found" });
  });
});
