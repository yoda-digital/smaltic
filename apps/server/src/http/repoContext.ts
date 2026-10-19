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

const defaultPort = (proto: string): string => (proto === "https" ? "443" : "80");

interface Pinned {
  proto: "http" | "https";
  hostname: string;
  /** Effective port (the scheme's default when the URL omits it). */
  port: string;
  origin: string;
}

/** SMALTIC_PUBLIC_URL as scheme/host/port; loadConfig rejects an invalid one, so a parse failure here means "unset". */
function pinnedOrigin(cfg: Config): Pinned | undefined {
  if (!cfg.publicUrl) return undefined;
  try {
    const u = new URL(cfg.publicUrl);
    const proto = u.protocol.slice(0, -1);
    if (proto !== "http" && proto !== "https") return undefined;
    return { proto, hostname: u.hostname.toLowerCase(), port: u.port || defaultPort(proto), origin: u.origin };
  } catch {
    return undefined;
  }
}

/**
 * Whether `host` (from Host or X-Forwarded-Host) may name the emitted origin. With SMALTIC_PUBLIC_URL set, its host
 * must match host *and* port (an omitted port means the configured scheme's default), and a forwarded proto must equal
 * the configured scheme. Subdomains of SMALTIC_BASE_DOMAIN must use the configured scheme (any http(s) when no public
 * URL is set) and either no port or the public URL's port. `fwdProto` is undefined when the client sent none: the
 * socket's own scheme is then genuine and is not checked.
 */
function originAllowed(host: string, fwdProto: string | undefined, cfg: Config): boolean {
  if (!HOST_RE.test(host)) return false;
  const [rawBare, port = ""] = host.split(":") as [string, string?];
  const bare = rawBare.toLowerCase();
  const pin = pinnedOrigin(cfg);
  const base = cfg.baseDomain?.toLowerCase();
  if (!pin && !base) return true; // dev: nothing configured
  const protoOk = fwdProto === undefined || (pin ? fwdProto === pin.proto : fwdProto === "http" || fwdProto === "https");
  if (pin && bare === pin.hostname) {
    return protoOk && (port || defaultPort(pin.proto)) === pin.port;
  }
  if (base !== undefined && (bare === base || bare.endsWith(`.${base}`))) {
    return protoOk && (port === "" || (pin !== undefined && port === pin.port));
  }
  return false;
}

/** Request origin (`scheme://host[:port]`) from validated proxy/Host headers, falling back to SMALTIC_PUBLIC_URL. */
export function requestOrigin(req: FastifyRequest): string {
  const cfg = req.server.config;
  const sockProto = (req.raw.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
  const hostHeader = req.headers.host;
  const configured = pinnedOrigin(cfg)?.origin;

  let origin: string | undefined;
  const fwdHost = cfg.trustProxy ? firstHeader(req.headers["x-forwarded-host"]) : undefined;
  const fwdProto = cfg.trustProxy ? firstHeader(req.headers["x-forwarded-proto"])?.toLowerCase() : undefined;
  if (fwdHost !== undefined || fwdProto !== undefined) {
    const host = fwdHost ?? hostHeader;
    const protoOk = fwdProto === undefined || fwdProto === "http" || fwdProto === "https";
    if (host && protoOk && originAllowed(host, fwdProto, cfg)) origin = `${fwdProto ?? sockProto}://${host}`;
  } else if (hostHeader && originAllowed(hostHeader, undefined, cfg)) {
    origin = `${sockProto}://${hostHeader}`;
  }
  if (!origin) {
    origin = configured ?? (hostHeader && HOST_RE.test(hostHeader) ? `${sockProto}://${hostHeader}` : "http://localhost");
  }
  return origin;
}

/**
 * Origin for URLs persisted in content (R12): SMALTIC_PUBLIC_URL's origin when set, otherwise the
 * validated request origin. Unlike `publicUrl` it never carries the `/r/<repo>` prefix.
 */
export function canonicalOrigin(req: FastifyRequest): string {
  const configured = req.server.config.publicUrl;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* invalid: fall through to the request origin */
    }
  }
  return requestOrigin(req);
}

/** Builds an absolute URL for `path` (starting with `/`), honouring validated proxy headers and the /r/<repo> prefix. */
export function publicUrl(req: FastifyRequest, path: string): string {
  const origin = requestOrigin(req);
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
