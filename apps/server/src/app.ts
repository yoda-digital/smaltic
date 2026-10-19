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

/** Query parameters whose values are credentials (access tokens, signed preview refs): never logged. */
const SECRET_PARAMS = new Set(["access_token", "ref", "token"]);

/** `url` with the values of SECRET_PARAMS (matched case-insensitively, after decoding the key) replaced by `[redacted]`. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hash = url.indexOf("#", q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  const masked = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        /* keep the raw key */
      }
      return SECRET_PARAMS.has(key.trim().toLowerCase()) && eq !== -1 ? `${rawKey}=[redacted]` : pair;
    })
    .join("&");
  return `${url.slice(0, q + 1)}${masked}${hash === -1 ? "" : url.slice(hash)}`;
}

/** Fastify's default `req` serializer, with secrets masked in the URL. */
function serializeReq(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    version: req.headers?.["accept-version"],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}

/**
 * Logger options: the configured level (or the caller's override, e.g. a test stream) plus secret hygiene — the
 * `req` serializer masks credential query params, and `redact` covers auth headers should headers ever be logged.
 */
function loggerOptions(deps: AppDeps): FastifyServerOptions["logger"] {
  const base = deps.logger ?? { level: deps.config.logLevel };
  if (typeof base !== "object" || base === null) return base;
  return {
    ...base,
    serializers: { ...(base.serializers ?? {}), req: serializeReq as never },
    redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[redacted]" },
  };
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
    logger: loggerOptions(deps),
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
