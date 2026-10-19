import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createTestDb } from "./helpers.js";

const run = promisify(execFile);
const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(serverDir, "node_modules", ".bin", "tsx");

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(tsx, ["--conditions=development", "src/cli.ts", ...args], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: db.url },
    });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("smaltic CLI", () => {
  it("create-repo --visibility private, add-locale, create-token --scope master+releases", async () => {
    expect((await cli("create-repo", "cli-repo", "--locale", "en-us", "--visibility", "private")).code).toBe(0);
    expect((await cli("add-locale", "cli-repo", "fr-fr", "--name", "French")).code).toBe(0);
    const tok = await cli("create-token", "cli-repo", "--kind", "access", "--scope", "master+releases");
    expect(tok.code).toBe(0);
    const token = tok.stdout.trim();
    expect(token).toMatch(/^rf_access_/);

    const [repo] = await db.sql`select id, api_visibility from repositories where name = 'cli-repo'`;
    expect(repo!.api_visibility).toBe("private");
    const locales = await db.sql`select code, name, is_master from locales where repo_id = ${repo!.id} order by position`;
    expect(locales.map((l) => [l.code, l.name, l.is_master])).toEqual([["en-us", "en-us", true], ["fr-fr", "French", false]]);
    const hash = createHash("sha256").update(token).digest("hex");
    const [t] = await db.sql`select kind, scope from api_tokens where token_hash = ${hash}`;
    expect(t).toMatchObject({ kind: "access", scope: "master+releases" });
  }, 30_000);

  it("rejects an unknown visibility and scope", async () => {
    expect((await cli("create-repo", "cli-bad", "--visibility", "secret")).code).toBe(1);
    expect((await cli("create-token", "cli-repo", "--kind", "access", "--scope", "everything")).code).toBe(1);
  }, 30_000);
});
