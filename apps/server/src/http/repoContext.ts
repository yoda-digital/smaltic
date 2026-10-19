import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "../config.js";
import { REPO_NAME_RE, RepositoryService, type Repo } from "../domain/repositories.js";
import { repositoryNotFound, writeRepositoryNotFound } from "./errors.js";

const PREFIX_RE = /^\/r\/([^/?#]+)(?=[/?#]|$)/;
const PREFIX_KEY = "smalticPrefixRepo";

/** Fastify `rewriteUrl`: strips `/r/<repo>` and remembers it on the raw request. */
export function rewriteUrl(req: { url?: string }): string {
  const url = req.url ?? "/";
  const m = PREFIX_RE.exec(url);
  if (!m) return url;
  let name: string;
  try {
    name = decodeURIComponent(m[1]!);
  } catch {
    return url; // malformed escape: not a repo prefix
  }
  if (!REPO_NAME_RE.test(name)) return url;
  (req as any)[PREFIX_KEY] = name;
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

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

function hostAllowed(host: string, cfg: Config): boolean {
  if (!HOST_RE.test(host)) return false;
  const bare = host.split(":")[0]!.toLowerCase();
  const allowed: string[] = [];
  let base: string | undefined;
  if (cfg.publicUrl) {
    try {
      allowed.push(new URL(cfg.publicUrl).hostname.toLowerCase());
    } catch {
      /* ignore bad publicUrl */
    }
  }
  if (cfg.baseDomain) base = cfg.baseDomain.toLowerCase();
  if (allowed.length === 0 && !base) return true; // dev: nothing configured
  return allowed.includes(bare) || (base !== undefined && (bare === base || bare.endsWith(`.${base}`)));
}

/** Builds an absolute URL for `path` (starting with `/`), honouring validated proxy headers and the /r/<repo> prefix. */
export function publicUrl(req: FastifyRequest, path: string): string {
  const cfg = req.server.config;
  const sockProto = (req.raw.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  const hostHeader = req.headers.host;

  const configured = (() => {
    if (!cfg.publicUrl) return undefined;
    try {
      return new URL(cfg.publicUrl).origin;
    } catch {
      return undefined;
    }
  })();

  let origin: string | undefined;
  const fwdHost = cfg.trustProxy ? firstHeader(req.headers["x-forwarded-host"]) : undefined;
  const fwdProto = cfg.trustProxy ? firstHeader(req.headers["x-forwarded-proto"])?.toLowerCase() : undefined;
  if (fwdHost !== undefined || fwdProto !== undefined) {
    const host = fwdHost ?? hostHeader;
    const protoOk = fwdProto === undefined || fwdProto === "http" || fwdProto === "https";
    if (host && protoOk && hostAllowed(host, cfg)) origin = `${fwdProto ?? sockProto}://${host}`;
  } else if (hostHeader && hostAllowed(hostHeader, cfg)) {
    origin = `${sockProto}://${hostHeader}`;
  }
  if (!origin) {
    origin = configured ?? (hostHeader && HOST_RE.test(hostHeader) ? `${sockProto}://${hostHeader}` : "http://localhost");
  }

  const used = prefixRepo(req);
  const name = used ? resolveRepoName(req) ?? used : undefined;
  return `${origin}${name ? `/r/${encodeURIComponent(name)}` : ""}${path.startsWith("/") ? path : `/${path}`}`;
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
