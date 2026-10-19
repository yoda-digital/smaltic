import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDb, migrate, type Sql } from "../src/db/index.js";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://prismic:prismic@localhost:5433/prismic";

export async function createTestDb(): Promise<{ sql: Sql; url: string; drop(): Promise<void> }> {
  const name = `smaltic_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const sql = createDb(url);
  return {
    sql,
    url,
    async drop() {
      await sql.end();
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      try {
        await a`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name}`;
        await a.unsafe(`drop database if exists ${name}`);
      } finally {
        await a.end();
      }
    },
  };
}

export async function startServer(
  opts: { env?: NodeJS.ProcessEnv; config?: Partial<Config> } = {},
): Promise<{ app: FastifyInstance; baseUrl: string; sql: Sql; close(): Promise<void> }> {
  const db = await createTestDb();
  await migrate(db.sql);
  const config = { ...loadConfig({ ...process.env, ...opts.env, DATABASE_URL: db.url }), ...opts.config };
  const app = await buildApp({ config, sql: db.sql });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    sql: db.sql,
    async close() {
      await app.close();
      await db.drop();
    },
  };
}
