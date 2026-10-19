import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Sql } from "./db/index.js";

export interface AppDeps {
  config: Config;
  sql: Sql;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.config.trustProxy });
  app.decorate("config", deps.config);
  app.decorate("sql", deps.sql);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    sql: Sql;
  }
}
