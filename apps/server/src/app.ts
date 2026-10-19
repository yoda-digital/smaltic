import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { Config } from "./config.js";
import type { Sql } from "./db/index.js";
import { AssetService } from "./domain/assets.js";
import { DocumentService } from "./domain/documents.js";
import { apiError, ensureRetryAfter } from "./http/errors.js";
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
  /** Overrides the logger built from `config.logLevel` (tests pass `false` or a custom stream). */
  logger?: FastifyServerOptions["logger"];
}

/** Postgres `character_not_in_repertoire` / invalid byte sequence (e.g. a NUL byte in a text parameter). */
const PG_INVALID_TEXT = "22021";

/**
 * Root error handler. 5xx are logged with the request id and answered with a generic body, so database or internal
 * messages never reach the client. A Postgres 22021 is the client's fault (bad bytes in input) and becomes a 400.
 * Every other 4xx is rethrown to Fastify's default handler, keeping its body unchanged. Route-level handlers
 * (Custom Types, Migration, Asset APIs) still take precedence for their own routes.
 */
function rootErrorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if ((err as { code?: unknown }).code === PG_INVALID_TEXT) {
    req.log.warn({ err }, "invalid byte sequence in request input");
    return apiError(reply, 400, { type: "api_validation_error", message: "Invalid characters in request parameters" });
  }
  const status = typeof err.statusCode === "number" ? err.statusCode : 500;
  if (status < 500) throw err;
  req.log.error({ err }, "request failed"); // the request logger already carries reqId
  return apiError(reply, status, { type: "api_internal_error", message: "Internal error" });
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: deps.config.trustProxy,
    rewriteUrl,
    logger: deps.logger ?? { level: deps.config.logLevel },
  });
  app.setErrorHandler(rootErrorHandler);
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
