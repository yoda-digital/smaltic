import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { migrate } from "../src/db/index.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { publicUrl } from "../src/http/repoContext.js";
import { createTestDb } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

async function make(over: Partial<Config>) {
  const db = await createTestDb();
  await migrate(db.sql);
  const config = { ...loadConfig({ ...process.env, DATABASE_URL: db.url }), ...over };
  const app = await buildApp({ config, sql: db.sql });
  const repos = new RepositoryService(db.sql);
  for (const name of ["blog", "other"]) await repos.create({ name, masterLocale: { code: "en-us", name: "E" } });
  app.get("/u", async (req) => ({ url: publicUrl(req, "/api/tags") }));
  app.get("/r", { preHandler: app.requireRepo("content") }, async (req) => ({ url: publicUrl(req, "/api/tags"), repo: req.repo.name }));
  cleanups.push(async () => {
    await app.close();
    await db.drop();
  });
  await app.ready();
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: "GET", url, headers });
    return { status: r.statusCode, body: r.json() as any };
  };
  return { get };
}

describe("publicUrl hardening", () => {
  it("falls back to publicUrl when forwarded host is not allowlisted", async () => {
    const s = await make({ publicUrl: "https://cms.example.com", baseDomain: undefined, trustProxy: true });
    const r = await s.get("/u", { "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" });
    expect(r.body.url).toBe("https://cms.example.com/api/tags");
  });
  it("rejects CRLF/slash in forwarded host", async () => {
    const s = await make({ publicUrl: "https://cms.example.com", trustProxy: true });
    for (const h of ["cms.example.com/evil", "cms.example.com\r\nX: y", "a b"]) {
      const r = await s.get("/u", { "x-forwarded-host": h }).catch(() => null);
      if (r) expect(r.body.url).toBe("https://cms.example.com/api/tags");
    }
  });
  it("rejects non-http proto", async () => {
    const s = await make({ publicUrl: "https://cms.example.com", trustProxy: true });
    const r = await s.get("/u", { "x-forwarded-host": "cms.example.com", "x-forwarded-proto": "javascript" });
    expect(r.body.url).toBe("https://cms.example.com/api/tags");
  });
  it("ignores X-Forwarded-* when trustProxy=false", async () => {
    const s = await make({ publicUrl: "https://cms.example.com", trustProxy: false });
    const r = await s.get("/u", { host: "cms.example.com", "x-forwarded-host": "cms.example.com:99", "x-forwarded-proto": "https" });
    expect(r.body.url).toBe("http://cms.example.com/api/tags");
  });
  it("honours allowlisted subdomain of baseDomain", async () => {
    const s = await make({ baseDomain: "cms.example.com", publicUrl: undefined, trustProxy: true });
    const r = await s.get("/u", { "x-forwarded-host": "blog.cms.example.com", "x-forwarded-proto": "https" });
    expect(r.body.url).toBe("https://blog.cms.example.com/api/tags");
    const bad = await s.get("/u", { "x-forwarded-host": "evil.test", host: "localhost" });
    expect(bad.body.url).toBe("http://localhost/api/tags");
  });
  it("malformed escape in prefix does not 500", async () => {
    const s = await make({});
    expect([400, 404]).toContain((await s.get("/r/%E0%A4%A/api/tags")).status);
  });
  it("encoded-slash prefix is not a repo prefix", async () => {
    const s = await make({});
    const r = await s.get("/r/a%2F..%2Fb/u");
    expect(r.status).toBe(404);
  });
  it("header-selected repo names the emitted prefix", async () => {
    const s = await make({});
    const r = await s.get("/r/blog/r", { repository: "other" });
    expect(r.body).toMatchObject({ repo: "other" });
    expect(r.body.url).toMatch(/\/r\/other\/api\/tags$/);
  });
});

describe("publicUrl: port and scheme pinning (final review)", () => {
  it("reviewer spoof: proto downgrade + foreign port on the public host -> configured origin", async () => {
    const s = await make({ publicUrl: "https://cms.example.com", baseDomain: undefined, trustProxy: true });
    const r = await s.get("/u", { "x-forwarded-proto": "http", "x-forwarded-host": "cms.example.com:6666" });
    expect(r.body.url).toBe("https://cms.example.com/api/tags");
  });
  it("wrong port on the allowed host falls back", async () => {
    const s = await make({ publicUrl: "https://cms.example.com", baseDomain: undefined, trustProxy: true });
    const r = await s.get("/u", { "x-forwarded-proto": "https", "x-forwarded-host": "cms.example.com:8443" });
    expect(r.body.url).toBe("https://cms.example.com/api/tags");
    const h = await s.get("/u", { host: "cms.example.com:6666" });
    expect(h.body.url).toBe("https://cms.example.com/api/tags");
  });
  it("explicit default port and matching port are accepted", async () => {
    const s = await make({ publicUrl: "https://cms.example.com:8443", baseDomain: undefined, trustProxy: true });
    const r = await s.get("/u", { "x-forwarded-proto": "https", "x-forwarded-host": "cms.example.com:8443" });
    expect(r.body.url).toBe("https://cms.example.com:8443/api/tags");
    const bad = await s.get("/u", { "x-forwarded-proto": "https", "x-forwarded-host": "cms.example.com" });
    expect(bad.body.url).toBe("https://cms.example.com:8443/api/tags");
  });
  it("proto downgrade alone is ignored", async () => {
    const s = await make({ publicUrl: "https://cms.example.com", baseDomain: undefined, trustProxy: true });
    const r = await s.get("/u", { "x-forwarded-proto": "http", "x-forwarded-host": "cms.example.com" });
    expect(r.body.url).toBe("https://cms.example.com/api/tags");
    const p = await s.get("/u", { host: "cms.example.com", "x-forwarded-proto": "http" });
    expect(p.body.url).toBe("https://cms.example.com/api/tags");
  });
  it("baseDomain subdomains must use the public URL's scheme and port", async () => {
    const s = await make({ publicUrl: "https://cms.example.com", baseDomain: "cms.example.com", trustProxy: true });
    const ok = await s.get("/u", { "x-forwarded-proto": "https", "x-forwarded-host": "blog.cms.example.com" });
    expect(ok.body.url).toBe("https://blog.cms.example.com/api/tags");
    const downgraded = await s.get("/u", { "x-forwarded-proto": "http", "x-forwarded-host": "blog.cms.example.com" });
    expect(downgraded.body.url).toBe("https://cms.example.com/api/tags");
    const ported = await s.get("/u", { "x-forwarded-proto": "https", "x-forwarded-host": "blog.cms.example.com:6666" });
    expect(ported.body.url).toBe("https://cms.example.com/api/tags");
  });
  it("baseDomain without publicUrl accepts http and https subdomains", async () => {
    const s = await make({ publicUrl: undefined, baseDomain: "cms.example.com", trustProxy: true });
    const r = await s.get("/u", { "x-forwarded-proto": "http", "x-forwarded-host": "blog.cms.example.com" });
    expect(r.body.url).toBe("http://blog.cms.example.com/api/tags");
  });
});

describe("loadConfig: SMALTIC_PUBLIC_URL validation", () => {
  const base = { DATABASE_URL: "postgres://x/y", SMALTIC_SECRET: "s".repeat(40) };
  it("throws on an invalid SMALTIC_PUBLIC_URL", () => {
    expect(() => loadConfig({ ...base, SMALTIC_PUBLIC_URL: "not a url" })).toThrow(/SMALTIC_PUBLIC_URL/);
    expect(() => loadConfig({ ...base, SMALTIC_PUBLIC_URL: "ftp://cms.example.com" })).toThrow(/SMALTIC_PUBLIC_URL/);
  });
  it("accepts an http(s) SMALTIC_PUBLIC_URL", () => {
    expect(loadConfig({ ...base, SMALTIC_PUBLIC_URL: "https://cms.example.com" }).publicUrl).toBe("https://cms.example.com");
  });
  it("warns once in production when neither SMALTIC_PUBLIC_URL nor SMALTIC_BASE_DOMAIN is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadConfig({ ...base, NODE_ENV: "production" });
      loadConfig({ ...base, NODE_ENV: "production" });
      const calls = warn.mock.calls.filter((c) => /SMALTIC_PUBLIC_URL/.test(String(c[0])));
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
