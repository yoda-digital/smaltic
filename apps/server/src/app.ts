import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Sql } from "./db/index.js";
import { repoContext, rewriteUrl } from "./http/repoContext.js";

export interface AppDeps {
  config: Config;
  sql: Sql;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.config.trustProxy, rewriteUrl });
  app.decorate("config", deps.config);
  app.decorate("sql", deps.sql);

  await repoContext(app);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    sql: Sql;
  }
}
