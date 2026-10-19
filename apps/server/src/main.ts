import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, migrate } from "./db/index.js";

/**
 * Server entrypoint: loads the config, applies pending migrations, then serves on `PORT`
 * (default 8080) and `HOST` (default 0.0.0.0). SIGTERM / SIGINT close the server and the pool.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST || "0.0.0.0";
  const sql = createDb(config.databaseUrl);
  try {
    await migrate(sql);
  } catch (e) {
    await sql.end({ timeout: 5 });
    throw e;
  }
  const app = await buildApp({ config, sql });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[smaltic] ${signal} received, shutting down`);
    try {
      await app.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    } catch (e) {
      console.error("[smaltic] shutdown failed:", e);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  const address = await app.listen({ port, host });
  console.log(`[smaltic] listening on ${address}`);
}

main().catch((e) => {
  console.error(`[smaltic] failed to start: ${(e as Error).message}`);
  process.exit(1);
});
