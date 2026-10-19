import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { InvalidRepositoryName, RepositoryService, UserService } from "../src/domain/repositories.js";
import { createTestDb } from "./helpers.js";

let db: Awaited<ReturnType<typeof createTestDb>>;
let svc: RepositoryService;
beforeAll(async () => {
  db = await createTestDb();
  await migrate(db.sql);
  svc = new RepositoryService(db.sql);
});
afterAll(async () => db.drop());

describe("repositories", () => {
  it("validates names", async () => {
    for (const name of ["blog", "my-site1"]) {
      expect((await svc.create({ name, masterLocale: { code: "en-us", name: "English" } })).name).toBe(name);
    }
    for (const name of ["ab", "-bad", "bad-"]) {
      await expect(svc.create({ name, masterLocale: { code: "en-us", name: "E" } })).rejects.toBeInstanceOf(InvalidRepositoryName);
    }
    expect(await svc.getByName("nope")).toBeNull();
  });

  it("lists master locale first even when added last", async () => {
    const r = await svc.create({ name: "locs", masterLocale: { code: "fr-fr", name: "French" } });
    await svc.addLocale(r.id, { code: "en-us", name: "English" });
    await svc.addLocale(r.id, { code: "de-de", name: "German" });
    const l = await svc.listLocales(r.id);
    expect(l.map((x) => x.code)).toEqual(["fr-fr", "en-us", "de-de"]);
    expect(l[0]!.isMaster).toBe(true);
  });

  it("verifies, revokes and separates token kinds", async () => {
    const r = await svc.create({ name: "tokens", masterLocale: { code: "en-us", name: "English" } });
    const w = await svc.createToken(r.id, "write", "w");
    expect(w.token).toMatch(/^rf_write_[A-Za-z0-9]{32}$/);
    expect(await svc.verifyToken(r.id, "write", w.token)).toMatchObject({ id: w.id, kind: "write", scope: "master" });
    expect(await svc.verifyToken(r.id, "access", w.token)).toBeNull();
    const [stored] = await db.sql`select token_hash from api_tokens where id = ${w.id}`;
    expect(stored!.token_hash).not.toContain(w.token);
    await svc.revokeToken(w.id);
    expect(await svc.verifyToken(r.id, "write", w.token)).toBeNull();
  });

  it("hashes user passwords with argon2id", async () => {
    await new UserService(db.sql).create({ email: "A@x.io", password: "pw" });
    const [u] = await db.sql`select email, password_hash from users`;
    expect(u!.email).toBe("a@x.io");
    expect(u!.password_hash).toMatch(/^\$argon2id\$/);
  });
});
