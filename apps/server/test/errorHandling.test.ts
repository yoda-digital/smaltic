import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/index.js";
import { DocumentService } from "../src/domain/documents.js";
import { ModelService } from "../src/domain/models.js";
import { RefService } from "../src/domain/refs.js";
import { RepositoryService } from "../src/domain/repositories.js";
import { createTestDb } from "./helpers.js";

const pageType = {
  id: "page",
  label: "Page",
  repeatable: true,
  status: true,
  json: { Main: { uid: { type: "UID", config: { label: "UID" } } } },
};

const PG_TEXT = /byte sequence|UTF8|0x00|22021|postgres/i;

let app: FastifyInstance;
let drop: () => Promise<void>;
let masterRef: string;
const logLines: any[] = [];

beforeAll(async () => {
  const db = await createTestDb();
  await migrate(db.sql);
  const config = loadConfig({ ...process.env, DATABASE_URL: db.url });
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n")) if (line.trim()) logLines.push(JSON.parse(line));
      cb();
    },
  });
  app = await buildApp({ config, sql: db.sql, logger: { level: "info", stream } });
  app.get("/__boom", async () => {
    throw new Error("secret internal detail: relation \"x\" does not exist");
  });
  app.get("/__bad", async () => {
    throw Object.assign(new Error("bad thing"), { statusCode: 400 });
  });
  app.get("/__pg22021", async () => {
    throw Object.assign(new Error("invalid byte sequence for encoding \"UTF8\": 0x00"), { code: "22021" });
  });
  const repos = new RepositoryService(db.sql);
  const repo = await repos.create({ name: "blog", masterLocale: { code: "en-us", name: "English" }, visibility: "public" });
  await new ModelService(db.sql).insertType(repo.id, pageType);
  const docs = new DocumentService(db.sql);
  const { id } = await docs.create(repo.id, "u", { type: "page", lang: "en-us", uid: "home", tags: [], data: {} });
  await docs.publish(repo.id, "u", [id]);
  masterRef = (await new RefService(db.sql, { secret: config.secret }).currentMaster(repo.id)).ref;
  await app.ready();
  drop = async () => {
    await app.close();
    await db.drop();
  };
});
afterAll(async () => drop());

const get = async (url: string) => {
  const r = await app.inject({ method: "GET", url });
  return { status: r.statusCode, text: r.body, body: r.json() as any };
};
const search = (params: Record<string, string>) =>
  get(`/r/blog/api/v2/documents/search?${new URLSearchParams(params).toString()}`);

describe("NUL / invalid UTF-8 in Content API params", () => {
  it("ref with NUL -> 404 refNotFound with the master ref", async () => {
    const r = await search({ ref: "abc\u0000def" });
    expect(r.status).toBe(404);
    expect(r.body.type).toBe("api_notfound_error");
    expect(r.body.message.endsWith(`Master ref is: ${masterRef}`)).toBe(true);
    expect(r.text).not.toMatch(PG_TEXT);
  });
  it("ref with an invalid UTF-8 escape (left undecoded by the query parser) -> 404 refNotFound, not 500", async () => {
    const r = await get(`/r/blog/api/v2/documents/search?ref=%ED%A0%80abc`);
    expect(r.status).toBe(404);
    expect(r.body.type).toBe("api_notfound_error");
  });
  it("lang with NUL -> 400 api_validation_error", async () => {
    const r = await search({ ref: masterRef, lang: "en\u0000us" });
    expect(r.status).toBe(400);
    expect(r.body.type).toBe("api_validation_error");
    expect(typeof r.body.message).toBe("string");
    expect(r.text).not.toMatch(PG_TEXT);
  });
  it("after with NUL -> 400 api_validation_error", async () => {
    const r = await search({ ref: masterRef, after: "x\u0000y" });
    expect(r.status).toBe(400);
    expect(r.body.type).toBe("api_validation_error");
    expect(r.text).not.toMatch(PG_TEXT);
  });
  it("q with NUL inside a string literal -> 400 api_parsing_error", async () => {
    const r = await search({ ref: masterRef, q: '[[fulltext(document, "a\u0000b")]]' });
    expect(r.status).toBe(400);
    expect(r.body.type).toBe("api_parsing_error");
    expect(r.body.pos).toMatchObject({ location: "query" });
    expect(r.text).not.toMatch(PG_TEXT);
  });
  it("valid requests still work", async () => {
    const r = await search({ ref: masterRef, lang: "en-us" });
    expect(r.status).toBe(200);
    expect(r.body.total_results_size).toBe(1);
  });
});

describe("root error handler", () => {
  it("a 500 returns a generic body and is logged with the request id", async () => {
    logLines.length = 0;
    const r = await app.inject({ method: "GET", url: "/__boom" });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ type: "api_internal_error", message: "Internal error" });
    expect(r.body).not.toMatch(/secret internal detail/);
    const entry = logLines.find((l) => l.level >= 50);
    expect(entry).toBeDefined();
    expect(entry.reqId).toBeDefined();
    expect(JSON.stringify(entry)).toMatch(/secret internal detail/);
  });
  it("PG 22021 maps to 400 without PG text", async () => {
    const r = await get("/__pg22021");
    expect(r.status).toBe(400);
    expect(r.body.type).toBe("api_validation_error");
    expect(r.text).not.toMatch(PG_TEXT);
  });
  it("4xx from Fastify keep their default bodies", async () => {
    const r = await get("/no-such-route");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ statusCode: 404, error: "Not Found" });
    const b = await get("/__bad");
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ statusCode: 400, error: "Bad Request", message: "bad thing" });
  });
});

describe("request logging redacts secrets (R22)", () => {
  it("masks ref, access_token and token query values but keeps the path and other params", async () => {
    logLines.length = 0;
    const q = '[[at(document.type, "page")]]';
    const url = `/r/blog/api/v2/documents/search?ref=pv.secret.sig&ACCESS_TOKEN=rf_access_x&Token=tk_secret_y&q=${encodeURIComponent(q)}&pageSize=2`;
    await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Token hdr_secret_z", cookie: "io.prismic.preview=cookie_secret_w" },
    });
    const text = logLines.map((l) => JSON.stringify(l)).join("\n");
    expect(text).toMatch(/incoming request/);
    for (const secret of ["pv.secret.sig", "rf_access_x", "tk_secret_y", "hdr_secret_z", "cookie_secret_w"]) {
      expect(text).not.toContain(secret);
    }
    const reqLine = logLines.find((l) => l.req?.url);
    expect(reqLine.req.url).toContain("/api/v2/documents/search?");
    expect(reqLine.req.url).toContain("ref=[redacted]");
    expect(reqLine.req.url).toContain("ACCESS_TOKEN=[redacted]");
    expect(reqLine.req.url).toContain(`q=${encodeURIComponent(q)}`);
    expect(reqLine.req.url).toContain("pageSize=2");
    expect(reqLine.req.method).toBe("GET");
  });
});
