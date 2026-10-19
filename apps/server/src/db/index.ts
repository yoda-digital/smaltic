import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export type Sql = postgres.Sql;
/** A composable SQL fragment (a tagged-template query interpolated into another one). */
export type Fragment = postgres.Fragment;

export function createDb(url: string): Sql {
  return postgres(url, { onnotice: () => {} });
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Applies db/migrations/*.sql in filename order; idempotent. */
export async function migrate(sql: Sql): Promise<void> {
  await sql`create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const name of files) {
    const text = await readFile(join(migrationsDir, name), "utf8");
    await sql.begin(async (tx) => {
      // Serialize concurrent migrators.
      await tx`select pg_advisory_xact_lock(727274)`;
      const done = await tx`select 1 from _migrations where name = ${name}`;
      if (done.length > 0) return;
      await tx.unsafe(text);
      await tx`insert into _migrations (name) values (${name})`;
    });
  }
}
