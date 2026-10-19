import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Sql } from "../db/index.js";
import { PreviewExpiredError, RefExpiredError, RefNotFoundError, RefService } from "../domain/refs.js";
import { RepositoryService, type Repo } from "../domain/repositories.js";
import {
  apiError, invalidToken, missingRef, parsingError, previewExpired, refExpired, refNotFound,
} from "../http/errors.js";
import { canonicalOrigin, publicUrl, requestOrigin } from "../http/repoContext.js";
import { MAX_PAGE_SIZE, search, type VersionRow } from "../query/compile.js";
import { QueryParseError, parseQueries } from "../query/filterParser.js";
import { apiDate, LinkParamError, loadModels, parseRoutes, renderDocuments, slugOf } from "../query/links.js";
import { visibleVersionsSql, type RefScope } from "../query/visible.js";

/** Build identifier reported as `version` by `/api/v2` and the search envelope. */
const VERSION = "smaltic";
const LICENSE = "All Rights Reserved";
const DEFAULT_PAGE_SIZE = 20;

const NO_STORE_API = "max-age=0, no-store";
const IMMUTABLE = "public, max-age=31536000, immutable";

/** `forms.everything.fields`, exactly as the live capture (`evidence/api-root.prismic-main.json`), key order included. */
const EVERYTHING_FIELDS = {
  ref: { type: "String", multiple: false },
  q: { type: "String", multiple: true },
  lang: { type: "String", multiple: false },
  page: { type: "Integer", multiple: false, default: "1" },
  pageSize: { type: "Integer", multiple: false, default: "20" },
  after: { type: "String", multiple: false },
  fetch: { type: "String", multiple: false },
  fetchLinks: { type: "String", multiple: false },
  graphQuery: { multiple: false, type: "String" },
  orderings: { type: "String", multiple: false },
  referer: { type: "String", multiple: false },
  routes: { type: "String", multiple: false },
  access_token: { type: "String", multiple: false },
  integrationFieldsRef: { type: "String", multiple: false },
};

/** Search params carried over into `next_page` / `prev_page`, in emission order (`routes` is dropped, as live). */
const ECHOED = ["fetch", "fetchLinks", "graphQuery", "lang", "after", "access_token"] as const;

type Query = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const many = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function intParam(raw: string | undefined, dflt: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/** Access token from `access_token` or `Authorization: Token <t>` / `Bearer <t>`. */
function tokenOf(req: FastifyRequest): string | undefined {
  const q = one((req.query as Query).access_token);
  if (q) return q;
  const m = /^(?:Token|Bearer)\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  return m ? m[1]!.trim() : undefined;
}

interface Access {
  ok: boolean;
  /** Whether release refs may be listed / queried. */
  releases: boolean;
}

/**
 * Visibility rules (R1§1): `public` serves master without a token, releases need a `master+releases` token;
 * `private` needs a token for everything (releases: `master+releases`); `open` serves everything without one.
 * A token that is given but invalid is always rejected.
 */
async function checkAccess(repos: RepositoryService, req: FastifyRequest, repo: Repo): Promise<Access> {
  const raw = tokenOf(req);
  const token = raw ? await repos.verifyToken(repo.id, "access", raw) : null;
  if (raw && !token) return { ok: false, releases: false };
  const releaseScope = token?.scope === "master+releases";
  switch (repo.visibility) {
    case "open":
      return { ok: true, releases: true };
    case "private":
      return { ok: token !== null, releases: releaseScope };
    default:
      return { ok: true, releases: releaseScope };
  }
}

/** Fixed one-second window per repository (only when `SMALTIC_RATE_LIMIT` is set). */
function rateLimiter(limit: number): preHandlerAsyncHookHandler {
  const windows = new Map<string, { window: number; count: number }>();
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const now = Math.floor(Date.now() / 1000);
    let w = windows.get(req.repo.id);
    if (!w || w.window !== now) {
      if (windows.size > 10_000) windows.clear();
      w = { window: now, count: 0 };
      windows.set(req.repo.id, w);
    }
    w.count++;
    reply.header("x-ratelimit-limit", String(limit));
    reply.header("x-ratelimit-remaining", String(Math.max(0, limit - w.count)));
    reply.header("x-ratelimit-reset", String(now + 1));
    if (w.count > limit) {
      reply.header("retry-after", "1");
      return apiError(reply, 429, { type: "api_rate_limit_error", message: "Too many requests" });
    }
  };
}

/** `cache-control` of a search response by ref kind: ref-keyed content is immutable, previews never cached. */
const searchCacheControl = (scope: RefScope) => (scope.kind === "preview" ? "no-store" : IMMUTABLE);

interface AltLang {
  id: string;
  uid?: string;
  type: string;
  lang: string;
}

/** Other-locale versions visible in the same scope, per translation group (one statement). */
async function alternateLanguages(sql: Sql, repoId: string, scope: RefScope, rows: VersionRow[]): Promise<Map<string, AltLang[]>> {
  const out = new Map<string, AltLang[]>();
  const groups = [...new Set(rows.map((r) => r.groupId))];
  if (groups.length === 0) return out;
  const alts = await sql`select d.id, ver.uid, d.type, d.lang, d.group_id
    from (${visibleVersionsSql(sql, repoId, scope)}) x
    join documents d on d.id = x.document_id
    join document_versions ver on ver.id = x.version_id
    where d.repo_id = ${repoId}::text and d.group_id = any(${groups}::text[])
    order by d.lang, d.id`;
  for (const a of alts) {
    const list = out.get(a.group_id) ?? [];
    list.push({ id: a.id, ...(a.uid !== null ? { uid: a.uid } : {}), type: a.type, lang: a.lang });
    out.set(a.group_id, list);
  }
  return out;
}

/** Creation time of versions, for documents that were never published (preview / release scopes). */
async function versionDates(sql: Sql, rows: VersionRow[]): Promise<Map<string, Date>> {
  const ids = rows.filter((r) => !r.firstPublicationDate || !r.lastPublicationDate).map((r) => r.versionId);
  if (ids.length === 0) return new Map();
  const found = await sql`select id::text as id, created_at from document_versions where id = any(${ids}::bigint[])`;
  return new Map(found.map((r) => [r.id as string, r.created_at as Date]));
}

/**
 * Content API (R1§2-4, C§1): `GET /api/v2` (repository), `GET /api/v2/documents/search`, `GET /api/tags`.
 * Every response carries `access-control-allow-origin: *` and `x-prismic-version: 6`.
 */
export async function contentApi(app: FastifyInstance): Promise<void> {
  const repos = new RepositoryService(app.sql);
  const refs = new RefService(app.sql, { secret: app.config.secret, refTtlSeconds: app.config.refTtlSeconds });
  const sql = app.sql;

  app.register(async (api) => {
    api.addHook("onSend", async (_req, reply, payload) => {
      reply.header("access-control-allow-origin", "*");
      reply.header("x-prismic-version", "6");
      if (reply.statusCode !== 204 && payload !== undefined && payload !== null && payload !== "") {
        reply.header("content-type", "application/json");
      }
      if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
      return payload;
    });

    const preHandler: preHandlerAsyncHookHandler[] = [app.requireRepo("content")];
    if (app.config.rateLimit) preHandler.push(rateLimiter(app.config.rateLimit));

    // CORS preflight: the Content API is read-only and public by design (tokens travel in the query string).
    for (const path of ["/api/v2", "/api/v2/documents/search", "/api/tags"]) {
      api.options(path, async (req, reply) => {
        reply.header("access-control-allow-methods", "GET, OPTIONS");
        reply.header("access-control-allow-headers", String(req.headers["access-control-request-headers"] ?? "Authorization, Content-Type"));
        reply.header("access-control-max-age", "86400");
        return reply.code(204).send();
      });
    }

    api.get("/api/v2", { preHandler }, async (req, reply) => {
      const repo = req.repo;
      const access = await checkAccess(repos, req, repo);
      if (!access.ok) return invalidToken(reply);
      const [master, locales, models, releases] = await Promise.all([
        refs.currentMaster(repo.id),
        repos.listLocales(repo.id),
        loadModels(sql, repo.id),
        access.releases
          ? sql`select id, label, ref, scheduled_at from releases
              where repo_id = ${repo.id} and status = 'open' and not migration order by created_at, id`
          : Promise.resolve([]),
      ]);
      const types: Record<string, string> = {};
      for (const [id, t] of models.types) types[id] = typeof t.label === "string" && t.label ? t.label : id;
      reply.header("cache-control", NO_STORE_API);
      return {
        refs: [
          { id: "master", ref: master.ref, label: "Master", isMasterRef: true },
          ...releases.map((r) => ({
            id: r.id as string,
            ref: r.ref as string,
            label: r.label as string,
            isMasterRef: false,
            ...(r.scheduled_at ? { scheduledAt: (r.scheduled_at as Date).getTime() } : {}),
          })),
        ],
        bookmarks: {},
        experiments: { draft: [], running: [] },
        types,
        languages: locales.map((l) => ({ id: l.code, name: l.name, is_master: l.isMaster })),
        forms: {
          everything: {
            method: "GET",
            enctype: "application/x-www-form-urlencoded",
            action: publicUrl(req, "/api/v2/documents/search"),
            fields: EVERYTHING_FIELDS,
          },
          tags: {
            method: "GET",
            enctype: "application/x-www-form-urlencoded",
            action: publicUrl(req, "/api/tags"),
            fields: { access_token: { type: "String", multiple: false } },
          },
        },
        oauth_initiate: publicUrl(req, "/studio/auth"),
        oauth_token: publicUrl(req, "/studio/auth/token"),
        integrationFieldsRef: null,
        tags: [],
        license: LICENSE,
        version: VERSION,
      };
    });

    api.get("/api/v2/documents/search", { preHandler }, async (req, reply) => {
      const repo = req.repo;
      const query = req.query as Query;

      // Precedence (R1§4.10): missing ref -> bad/expired ref -> token -> query parse.
      const ref = one(query.ref)?.trim();
      if (!ref) return missingRef(reply);
      let scope: RefScope;
      try {
        scope = await refs.resolveRef(repo.id, ref, { host: new URL(requestOrigin(req)).host });
      } catch (e) {
        if (e instanceof RefNotFoundError) return refNotFound(reply, e.master);
        if (e instanceof RefExpiredError) return refExpired(reply, e.master);
        if (e instanceof PreviewExpiredError) return previewExpired(reply);
        throw e;
      }
      const access = await checkAccess(repos, req, repo);
      const releaseRef = scope.kind === "release";
      if (!access.ok || (releaseRef && !access.releases)) return invalidToken(reply);

      const page = Math.max(1, intParam(one(query.page), 1));
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, intParam(one(query.pageSize), DEFAULT_PAGE_SIZE)));
      const qs = many(query.q);
      const orderings = one(query.orderings);
      const after = one(query.after);

      try {
        const routesRaw = one(query.routes);
        const routeList = routesRaw ? parseRoutes(routesRaw) : undefined;
        const [locales, models] = await Promise.all([repos.listLocales(repo.id), loadModels(sql, repo.id)]);
        const masterLang = locales[0]?.code ?? "en-us";
        const lang = one(query.lang) || masterLang;

        const filters = parseQueries(qs);
        const { total, rows } = await search(sql, repo.id, scope, { filters, orderings, page, pageSize, after, lang });
        const [rendered, alts, created] = await Promise.all([
          renderDocuments(
            { sql, repoId: repo.id, scope, masterLang, models, assetOrigin: canonicalOrigin(req), repoName: repo.name },
            rows,
            {
              routes: routeList,
              brokenRoute: one(query.brokenRoute),
              fetchLinks: many(query.fetchLinks).join(",") || undefined,
              graphQuery: one(query.graphQuery),
              fetch: many(query.fetch).join(",") || undefined,
            },
          ),
          alternateLanguages(sql, repo.id, scope, rows),
          versionDates(sql, rows),
        ]);

        const searchUrl = publicUrl(req, "/api/v2/documents/search");
        const pageUrl = (n: number) => {
          const p = new URLSearchParams();
          p.append("ref", ref);
          for (const q of qs) p.append("q", q);
          if (orderings !== undefined) p.append("orderings", orderings);
          p.append("page", String(n));
          p.append("pageSize", String(pageSize));
          for (const k of ECHOED) {
            const v = one(query[k]);
            if (v !== undefined) p.append(k, v);
          }
          return `${searchUrl}?${p.toString()}`;
        };
        const totalPages = Math.ceil(total / pageSize);

        const results = rows.map((r, i) => {
          const fallback = created.get(r.versionId) ?? null;
          const href = new URLSearchParams({ ref, q: `[[:d = at(document.id, "${r.id}") ]]` });
          return {
            id: r.id,
            uid: r.uid,
            url: rendered[i]!.url,
            type: r.type,
            href: `${searchUrl}?${href.toString()}`,
            tags: r.tags,
            first_publication_date: apiDate(r.firstPublicationDate ?? fallback),
            last_publication_date: apiDate(r.lastPublicationDate ?? fallback),
            slugs: [slugOf(models.types.get(r.type), r.data)],
            linked_documents: [],
            lang: r.lang,
            alternate_languages: (alts.get(r.groupId) ?? []).filter((a) => a.id !== r.id),
            data: rendered[i]!.data,
          };
        });

        reply.header("cache-control", searchCacheControl(scope));
        return {
          page,
          results_per_page: pageSize,
          results_size: results.length,
          total_results_size: total,
          total_pages: totalPages,
          next_page: page < totalPages ? pageUrl(page + 1) : null,
          prev_page: page > 1 ? pageUrl(page - 1) : null,
          results,
          version: VERSION,
          license: LICENSE,
        };
      } catch (e) {
        if (e instanceof QueryParseError) return parsingError(reply, e.message, e.pos);
        if (e instanceof LinkParamError) return apiError(reply, 400, { type: "api_parsing_error", message: e.message });
        throw e;
      }
    });

    api.get("/api/tags", { preHandler }, async (req, reply) => {
      const repo = req.repo;
      const access = await checkAccess(repos, req, repo);
      if (!access.ok) return invalidToken(reply);
      const master = await refs.currentMaster(repo.id);
      const rows = await sql`select distinct (t.tag collate "C") as tag
        from (${visibleVersionsSql(sql, repo.id, { kind: "master", seq: master.seq })}) x
        join document_versions v on v.id = x.version_id
        cross join lateral unnest(v.tags) as t(tag)
        order by tag`;
      reply.header("cache-control", NO_STORE_API);
      return rows.map((r) => r.tag as string);
    });
  });
}
