import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Sql } from "./db/index.js";
import { AssetService } from "./domain/assets.js";
import { DocumentService } from "./domain/documents.js";
import { ensureRetryAfter } from "./http/errors.js";
import { repoContext, rewriteUrl } from "./http/repoContext.js";
import { assetApi } from "./routes/assetApi.js";
import { contentApi } from "./routes/contentApi.js";
import { customTypesApi } from "./routes/customTypesApi.js";
import { migrationApi } from "./routes/migrationApi.js";
import { previewApi } from "./routes/previewApi.js";

export interface AppDeps {
  config: Config;
  sql: Sql;
  countDocumentsOfType?: (repoId: string, typeId: string) => Promise<number>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.config.trustProxy, rewriteUrl });
  app.decorate("config", deps.config);
  app.decorate("sql", deps.sql);

  await repoContext(app);
  app.addHook("onSend", ensureRetryAfter);

  const assets = new AssetService(deps.sql, deps.config);
  const documents = new DocumentService(deps.sql, {
    assets: (repoId, id, urlFor) => assets.lookup(repoId, id, urlFor),
  });

  app.get("/health", async () => ({ status: "ok" }));

  await customTypesApi(app, { countDocumentsOfType: deps.countDocumentsOfType });
  await contentApi(app);
  await migrationApi(app, { documents });
  await assetApi(app, { assets });
  await previewApi(app);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    sql: Sql;
  }
}
