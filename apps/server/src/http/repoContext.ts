import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { RepositoryService, type Repo } from "../domain/repositories.js";
import { repositoryNotFound, writeRepositoryNotFound } from "./errors.js";

const PREFIX_RE = /^\/r\/([^/?#]+)(?=[/?#]|$)/;
const PREFIX_KEY = "smalticPrefixRepo";

/** Fastify `rewriteUrl`: strips `/r/<repo>` and remembers it on the raw request. */
export function rewriteUrl(req: { url?: string }): string {
  const url = req.url ?? "/";
  const m = PREFIX_RE.exec(url);
  if (!m) return url;
  (req as any)[PREFIX_KEY] = decodeURIComponent(m[1]!);
  const rest = url.slice(m[0].length);
  return rest.startsWith("/") ? rest : rest.startsWith("?") ? `/${rest}` : "/" + rest;
}

const prefixRepo = (req: FastifyRequest): string | undefined => (req.raw as any)[PREFIX_KEY];

function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(",")[0]?.trim() || undefined;
}

function hostOf(req: FastifyRequest): string | undefined {
  const cfg = req.server.config;
  const fwd = cfg.trustProxy ? firstHeader(req.headers["x-forwarded-host"]) : undefined;
  return fwd ?? req.headers.host;
}

export function resolveRepoName(req: FastifyRequest): string | undefined {
  const header = firstHeader(req.headers["repository"]);
  if (header) return header;
  const base = req.server.config.baseDomain?.toLowerCase();
  if (base) {
    const host = hostOf(req)?.split(":")[0]?.toLowerCase();
    if (host && host.endsWith(`.${base}`)) {
      const label = host.slice(0, -(base.length + 1));
      if (label && !label.includes(".")) return label;
    }
  }
  return prefixRepo(req);
}

/** Builds an absolute URL for `path` (starting with `/`), honouring proxy headers and the /r/<repo> prefix. */
export function publicUrl(req: FastifyRequest, path: string): string {
  const cfg = req.server.config;
  const trust = cfg.trustProxy;
  const fwdProto = trust ? firstHeader(req.headers["x-forwarded-proto"]) : undefined;
  const fwdHost = hostOf(req);
  let origin: string;
  if (fwdHost) {
    origin = `${fwdProto ?? (cfg.publicUrl ? new URL(cfg.publicUrl).protocol.slice(0, -1) : req.protocol)}://${fwdHost}`;
  } else if (cfg.publicUrl) {
    origin = cfg.publicUrl.replace(/\/+$/, "");
  } else {
    origin = `${req.protocol}://${req.headers.host ?? "localhost"}`;
  }
  const prefix = prefixRepo(req);
  return `${origin}${prefix ? `/r/${prefix}` : ""}${path.startsWith("/") ? path : `/${path}`}`;
}

export type RepoKind = "content" | "write";

/** Opt-in preHandler factory: resolves req.repo or replies 404 (content) / 403 (write). */
export function requireRepo(app: FastifyInstance, kind: RepoKind): preHandlerAsyncHookHandler {
  const svc = new RepositoryService(app.sql);
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const name = resolveRepoName(req);
    const repo = name ? await svc.getByName(name) : null;
    if (!repo) {
      if (kind === "write") writeRepositoryNotFound(reply);
      else repositoryNotFound(reply);
      return reply;
    }
    req.repo = repo;
  };
}

/** Plugin (non-encapsulated): decorates `req.repo` and `app.requireRepo`. Does not block any route by itself. */
export async function repoContext(app: FastifyInstance): Promise<void> {
  app.decorateRequest("repo", undefined as unknown as Repo);
  app.decorate("requireRepo", (kind: RepoKind) => requireRepo(app, kind));
}
(repoContext as any)[Symbol.for("skip-override")] = true;

declare module "fastify" {
  interface FastifyRequest {
    repo: Repo;
  }
  interface FastifyInstance {
    requireRepo(kind: RepoKind): preHandlerAsyncHookHandler;
  }
}
