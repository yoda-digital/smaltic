import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe("health", () => {
  it("GET /health returns ok", async () => {
    const res = await fetch(`${s.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("migrate is idempotent", async () => {
    await migrate(s.sql);
    await migrate(s.sql);
    const rows = await s.sql`select name from _migrations order by name`;
    expect(rows.map((r) => r.name)).toEqual(["001_init.sql", "002_tenancy.sql", "003_models.sql", "004_documents.sql", "005_assets.sql", "006_search.sql"]);
  });
});
