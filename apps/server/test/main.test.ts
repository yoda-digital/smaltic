import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "./helpers.js";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(serverDir, "node_modules", ".bin", "tsx");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

let db: Awaited<ReturnType<typeof createTestDb>>;
let dataDir: string;
beforeAll(async () => {
  db = await createTestDb();
  dataDir = await mkdtemp(join(tmpdir(), "smaltic-main-"));
});
afterAll(async () => {
  await db?.drop();
  await rm(dataDir, { recursive: true, force: true });
});

describe("src/main.ts entrypoint", () => {
  it("migrates, listens on PORT, serves /health and exits cleanly on SIGTERM", async () => {
    const port = await freePort();
    const child = spawn(tsx, ["--conditions=development", "src/main.ts"], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: db.url, PORT: String(port), HOST: "127.0.0.1", SMALTIC_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (b) => (output += b));
    child.stderr!.on("data", (b) => (output += b));
    const exited = exitOf(child);
    try {
      let body: unknown;
      for (let i = 0; i < 100 && body === undefined; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/health`);
          if (r.ok) body = await r.json();
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(body, output).toEqual({ status: "ok" });
      // Migrations ran against the configured database.
      const [m] = await db.sql`select count(*)::int as n from _migrations`;
      expect(m!.n).toBeGreaterThan(0);
    } finally {
      child.kill("SIGTERM");
    }
    const { code } = await exited;
    expect(code, output).toBe(0);
  }, 30_000);

  it("refuses to start in production without a strong SMALTIC_SECRET", async () => {
    const child = spawn(tsx, ["--conditions=development", "src/main.ts"], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: db.url, PORT: "0", NODE_ENV: "production", SMALTIC_SECRET: "short" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr!.on("data", (b) => (output += b));
    const { code } = await exitOf(child);
    expect(code).toBe(1);
    expect(output).toMatch(/SMALTIC_SECRET/);
  }, 30_000);
});
