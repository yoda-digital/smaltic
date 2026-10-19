import type { FastifyInstance } from "fastify";
import { RefService } from "../domain/refs.js";
import { RepositoryService } from "../domain/repositories.js";

/**
 * Content API. MINIMAL for now: only `GET /api/v2` with the master ref and languages (master locale
 * first, C§0.10), which the WriteClient reads during `migrate()`. Task 10 completes this route
 * (releases, types, tags, forms with absolute actions, access tokens, caching headers) and adds
 * `/api/v2/documents/search` and `/api/tags`.
 */
export async function contentApi(app: FastifyInstance): Promise<void> {
  const repos = new RepositoryService(app.sql);
  const refs = new RefService(app.sql, { secret: app.config.secret, refTtlSeconds: app.config.refTtlSeconds });

  app.get("/api/v2", { preHandler: app.requireRepo("content") }, async (req) => {
    const [master, locales] = await Promise.all([refs.currentMaster(req.repo.id), repos.listLocales(req.repo.id)]);
    return {
      refs: [{ id: "master", ref: master.ref, label: "Master", isMasterRef: true }],
      languages: locales.map((l) => ({ id: l.code, name: l.name, is_master: l.isMaster })),
      types: {},
      tags: [],
      forms: {},
      bookmarks: {},
      experiments: { draft: [], running: [] },
      license: "All Rights Reserved",
      version: "smaltic",
    };
  });
}
