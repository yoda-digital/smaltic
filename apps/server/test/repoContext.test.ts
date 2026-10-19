import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrate, type Sql } from "../src/db/index.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { publicUrl } from "../src/http/repoContext.js";
import { createTestDb } from "./helpers.js";

let s: { baseUrl: string; sql: Sql; close(): Promise<void> };
beforeAll(async () => {
  const db = await createTestDb();
  await migrate(db.sql);
  const config = { ...loadConfig({ ...process.env, DATABASE_URL: db.url }), baseDomain: "cms.test" };
  const app = await buildApp({ config, sql: db.sql });
  await new RepositoryService(db.sql).create({ name: "blog", masterLocale: { code: "en-us", name: "English" } });
  app.get("/api/tags", { preHandler: app.requireRepo("content") }, async (req) => ({
    repo: req.repo.name,
    url: publicUrl(req, "/api/tags"),
    path: req.url,
  }));
  app.get("/wapi", { preHandler: app.requireRepo("write") }, async (req) => ({ repo: req.repo.name }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  s = {
    baseUrl: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    sql: db.sql,
    async close() {
      await app.close();
      await db.drop();
    },
  };
}, 30000);
afterAll(async () => s.close());

describe("repoContext", () => {
  it("does not block /health", async () => {
    expect((await fetch(`${s.baseUrl}/health`)).status).toBe(200);
  });
  it("resolves from header", async () => {
    const r = await fetch(`${s.baseUrl}/api/tags`, { headers: { repository: "blog" } });
    expect(await r.json()).toMatchObject({ repo: "blog", path: "/api/tags" });
  });
  it("resolves from subdomain", async () => {
    const r = await fetch(`${s.baseUrl}/api/tags`, { headers: { "x-forwarded-host": "blog.cms.test" } });
    expect(await r.json()).toMatchObject({ repo: "blog" });
  });
  it("resolves from /r/ prefix, stripped before routing, and re-adds it in publicUrl", async () => {
    const r = await fetch(`${s.baseUrl}/r/blog/api/tags?x=1`, {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "cms.example.com" },
    });
    expect(await r.json()).toEqual({ repo: "blog", url: "https://cms.example.com/r/blog/api/tags", path: "/api/tags?x=1" });
  });
  it("header wins over prefix", async () => {
    await new RepositoryService(s.sql).create({ name: "other", masterLocale: { code: "en-us", name: "E" } });
    const r = await fetch(`${s.baseUrl}/r/blog/api/tags`, { headers: { repository: "other" } });
    expect(await r.json()).toMatchObject({ repo: "other" });
  });
  it("unknown repo: content 404, write 403", async () => {
    const c = await fetch(`${s.baseUrl}/r/nope/api/tags`);
    expect(c.status).toBe(404);
    expect(await c.json()).toEqual({ type: "api_notfound_error", message: "Repository not found" });
    const w = await fetch(`${s.baseUrl}/wapi`, { headers: { repository: "nope" } });
    expect(w.status).toBe(403);
    expect(await w.json()).toEqual({ message: "Repository not found" });
    expect((await fetch(`${s.baseUrl}/api/tags`)).status).toBe(404);
  });
});
