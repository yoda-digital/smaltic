import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  Conflict,
  HasExistingDocuments,
  InvalidModel,
  ModelService,
  NotFound,
  type BulkChange,
  type CountDocumentsOfType,
} from "../domain/models.js";
import { RepositoryService } from "../domain/repositories.js";
import { apiError } from "../http/errors.js";

const text = (reply: FastifyReply, status: number, body: string) =>
  reply.code(status).type("text/plain; charset=utf-8").send(body);

export interface CustomTypesApiOpts {
  countDocumentsOfType?: CountDocumentsOfType;
}

export async function customTypesApi(app: FastifyInstance, opts: CustomTypesApiOpts = {}): Promise<void> {
  const models = new ModelService(app.sql, opts.countDocumentsOfType);
  const repos = new RepositoryService(app.sql);
  const requireRepo = app.requireRepo("write");

  app.register(
    async (api) => {
      api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
        const r = await requireRepo.call(api, req, reply);
        if (reply.sent) return reply;
        void r;
        const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
        const ok = m ? await repos.verifyToken(req.repo.id, "write", m[1]!.trim()) : null;
        if (!ok) return text(reply, 401, "Invalid or missing write token");
      });

      // Official client sends Content-Type: application/json even on bodiless GET/DELETE.
      api.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        const str = String(body);
        if (str.trim() === "") return done(null, undefined);
        try {
          done(null, JSON.parse(str));
        } catch {
          const e = new Error("Invalid JSON body") as Error & { statusCode: number };
          e.statusCode = 400;
          done(e, undefined);
        }
      });

      api.setErrorHandler((err, _req, reply) => {
        if (err instanceof InvalidModel) return text(reply, 400, err.message);
        if (err instanceof Conflict) return reply.code(409).send();
        if (err instanceof NotFound) return reply.code(404).send();
        if (err instanceof HasExistingDocuments)
          return apiError(reply, 403, { message: err.message, hasExistingDocuments: true });
        const status = (err as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500) return text(reply, 400, (err as Error).message);
        api.log.error(err);
        return text(reply, 500, "Internal error");
      });

      const wrapUpdate = async (fn: () => Promise<void>, reply: FastifyReply) => {
        try {
          await fn();
        } catch (e) {
          if (e instanceof NotFound) return reply.code(422).send();
          throw e;
        }
        return reply.code(204).send();
      };

      for (const [base, k] of [
        ["customtypes", "Type"],
        ["slices", "Slice"],
      ] as const) {
        const m = models as any;
        api.get(`/${base}`, async (req) => m[`list${k}s`](req.repo.id));
        api.get(`/${base}/:id`, async (req, reply) => {
          try {
            return await m[`get${k}`](req.repo.id, (req.params as { id: string }).id);
          } catch (e) {
            if (e instanceof NotFound) return reply.code(404).send();
            throw e;
          }
        });
        api.post(`/${base}/insert`, async (req, reply) => {
          await m[`insert${k}`](req.repo.id, req.body);
          return reply.code(201).send();
        });
        api.post(`/${base}/update`, (req, reply) => wrapUpdate(() => m[`update${k}`](req.repo.id, req.body), reply));
        api.delete(`/${base}/:id`, async (req, reply) => {
          await m[`remove${k}`](req.repo.id, (req.params as { id: string }).id);
          return reply.code(204).send();
        });
      }

      api.post("/bulk-update", async (req, reply) => {
        const body = req.body as { changes?: unknown } | null;
        if (!body || !Array.isArray(body.changes)) return text(reply, 400, "Body must be { changes: [...] }");
        try {
          await models.bulkUpdate(req.repo.id, body.changes as BulkChange[]);
        } catch (e) {
          if (e instanceof NotFound) return text(reply, 400, e.message);
          throw e;
        }
        return reply.code(204).send();
      });
    },
    { prefix: "/customtypes-api" },
  );
}
