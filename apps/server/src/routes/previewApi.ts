import { newId } from "@smaltic/model";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RefService } from "../domain/refs.js";
import { RepositoryService } from "../domain/repositories.js";
import { apiError } from "../http/errors.js";
import { resolveRepoName } from "../http/repoContext.js";

const PREVIEW_TTL_SECONDS = 1800;

interface PreviewConfig {
  id: string;
  name: string;
  website_url: string;
  resolver_path: string;
}

const err = (reply: FastifyReply, status: number, message: string) => apiError(reply, status, { message });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Validates a full preview config body (POST and PUT). Returns an error message or the config. */
function checkConfig(body: unknown): string | Omit<PreviewConfig, "id"> {
  const b = isObj(body) ? body : {};
  if (typeof b.name !== "string" || b.name.trim() === "" || b.name.length > 100) return "name must be a non-empty string";
  if (!isHttpUrl(b.website_url)) return "website_url must be an http(s) URL";
  if (typeof b.resolver_path !== "string" || !b.resolver_path.startsWith("/")) return "resolver_path must start with /";
  return { name: b.name.trim(), website_url: b.website_url, resolver_path: b.resolver_path };
}

/** `website_url` + `resolver_path` + `?token=<token>&documentId=<id>` (each value URL-encoded). */
export function buildPreviewUrl(cfg: Pick<PreviewConfig, "website_url" | "resolver_path">, token: string, documentId?: string): string {
  const base = cfg.website_url.replace(/\/+$/, "") + cfg.resolver_path;
  const qs = `token=${encodeURIComponent(token)}${documentId ? `&documentId=${encodeURIComponent(documentId)}` : ""}`;
  return `${base}${base.includes("?") ? "&" : "?"}${qs}`;
}

const toConfig = (r: Record<string, any>): PreviewConfig => ({
  id: r.id,
  name: r.name,
  website_url: r.website_url,
  resolver_path: r.resolver_path,
});

/**
 * Preview API: preview configs CRUD and preview sessions. Requires a repository write token for now
 * (Plan 4 swaps in Studio session auth).
 *
 * - `GET/POST /previews/configs`, `PUT/DELETE /previews/configs/:id`
 * - `GET /previews/session?documentId=&release=&config=` -> `{ token, previewUrl }`; `previewUrl` is
 *   built from the config named/identified by `config`, else the oldest one, else null.
 */
export async function previewApi(app: FastifyInstance): Promise<void> {
  const repos = new RepositoryService(app.sql);
  const refs = new RefService(app.sql, { secret: app.config.secret, refTtlSeconds: app.config.refTtlSeconds });
  const sql = app.sql;

  app.register(async (api) => {
    api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const name = resolveRepoName(req);
      const repo = name ? await repos.getByName(name) : null;
      if (!repo) return err(reply, 403, "Repository not found");
      req.repo = repo;
      const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
      const ok = m ? await repos.verifyToken(repo.id, "write", m[1]!.trim()) : null;
      if (!ok) return err(reply, 401, "Invalid or missing write token");
    });

    api.get("/previews/configs", async (req) => {
      const rows = await sql`select * from preview_configs where repo_id = ${req.repo.id} order by created_at, id`;
      return rows.map(toConfig);
    });

    api.post("/previews/configs", async (req, reply) => {
      const c = checkConfig(req.body);
      if (typeof c === "string") return err(reply, 400, c);
      const [row] = await sql`insert into preview_configs (id, repo_id, name, website_url, resolver_path)
        values (${newId()}, ${req.repo.id}, ${c.name}, ${c.website_url}, ${c.resolver_path})
        on conflict (repo_id, name) do nothing returning *`;
      if (!row) return err(reply, 409, `A preview config named "${c.name}" already exists`);
      return reply.code(201).send(toConfig(row));
    });

    api.put<{ Params: { id: string } }>("/previews/configs/:id", async (req, reply) => {
      const c = checkConfig(req.body);
      if (typeof c === "string") return err(reply, 400, c);
      try {
        const [row] = await sql`update preview_configs set name = ${c.name}, website_url = ${c.website_url},
            resolver_path = ${c.resolver_path}
          where id = ${req.params.id} and repo_id = ${req.repo.id} returning *`;
        if (!row) return err(reply, 404, "Preview config not found");
        return toConfig(row);
      } catch (e: any) {
        if (e?.code === "23505") return err(reply, 409, `A preview config named "${c.name}" already exists`);
        throw e;
      }
    });

    api.delete<{ Params: { id: string } }>("/previews/configs/:id", async (req, reply) => {
      const rows = await sql`delete from preview_configs where id = ${req.params.id} and repo_id = ${req.repo.id} returning id`;
      if (!rows.length) return err(reply, 404, "Preview config not found");
      return reply.code(204).send();
    });

    api.get<{ Querystring: { documentId?: string; release?: string; config?: string } }>(
      "/previews/session",
      async (req, reply) => {
        const { documentId, release, config } = req.query;
        const repoId = req.repo.id;
        if (documentId) {
          const [d] = await sql`select 1 from documents where id = ${documentId} and repo_id = ${repoId} and deleted_at is null`;
          if (!d) return err(reply, 404, "Document not found");
        }
        if (release) {
          const [r] = await sql`select 1 from releases where id = ${release} and repo_id = ${repoId} and status = 'open'`;
          if (!r) return err(reply, 404, "Release not found");
        }
        const token = refs.createPreviewToken(repoId, release ? { releaseId: release } : "drafts", documentId || undefined, PREVIEW_TTL_SECONDS);

        const [cfg] = config
          ? await sql`select * from preview_configs where repo_id = ${repoId} and (id = ${config} or name = ${config})
              order by (id = ${config}) desc limit 1`
          : await sql`select * from preview_configs where repo_id = ${repoId} order by created_at, id limit 1`;
        if (config && !cfg) return err(reply, 404, "Preview config not found");
        return { token, previewUrl: cfg ? buildPreviewUrl(toConfig(cfg), token, documentId || undefined) : null };
      },
    );
  });
}
