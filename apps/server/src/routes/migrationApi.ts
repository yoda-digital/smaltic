import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AlternateLangConflict,
  DocumentNotFound,
  DocumentService,
  ReleaseNotOpen,
  UidConflict,
  ValidationFailed,
} from "../domain/documents.js";
import { ModelService, NotFound as ModelNotFound } from "../domain/models.js";
import { RepositoryService } from "../domain/repositories.js";
import { migrationApiError } from "../http/errors.js";
import { canonicalOrigin, resolveRepoName } from "../http/repoContext.js";

/** Migration API error item; `value` only when one was sent (R1§8 examples). */
type EnvelopeError = { property: string; value?: unknown; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function fieldError(property: string, value: unknown, error: string): EnvelopeError {
  return value === undefined ? { property, error } : { property, value, error };
}

interface PostBody {
  title: string;
  type: string;
  lang: string;
  uid?: string | null;
  tags?: string[];
  alternate_language_id?: string;
  data: Record<string, unknown>;
}

/** Validates the POST envelope (not `data`, which DocumentService normalizes against the model). */
function checkPost(body: unknown): { body: PostBody; errors: EnvelopeError[] } {
  const b = isObj(body) ? body : {};
  const errors: EnvelopeError[] = [];
  const str = (k: string) => {
    if (typeof b[k] !== "string" || b[k] === "") errors.push(fieldError(k, b[k], "The value must be a string"));
  };
  str("title");
  str("type");
  str("lang");
  if (b.uid !== undefined && b.uid !== null && typeof b.uid !== "string") errors.push(fieldError("uid", b.uid, "The value must be a string"));
  if (b.tags !== undefined && !isStrArray(b.tags)) errors.push(fieldError("tags", b.tags, "The value must be an array of strings"));
  if (b.alternate_language_id !== undefined && typeof b.alternate_language_id !== "string") {
    errors.push(fieldError("alternate_language_id", b.alternate_language_id, "The value must be a string"));
  }
  if (b.data !== undefined && !isObj(b.data)) errors.push(fieldError("data", b.data, "The value must be an object"));
  return { body: { ...(b as unknown as PostBody), data: isObj(b.data) ? b.data : {} }, errors };
}

function checkPut(body: unknown): { body: Partial<PostBody>; errors: EnvelopeError[] } {
  const b = isObj(body) ? body : {};
  const errors: EnvelopeError[] = [];
  if (b.title !== undefined && typeof b.title !== "string") errors.push(fieldError("title", b.title, "The value must be a string"));
  if (b.uid !== undefined && b.uid !== null && typeof b.uid !== "string") errors.push(fieldError("uid", b.uid, "The value must be a string"));
  if (b.tags !== undefined && !isStrArray(b.tags)) errors.push(fieldError("tags", b.tags, "The value must be an array of strings"));
  if (!isObj(b.data)) errors.push(fieldError("data", b.data, "The value must be an object"));
  return { body: b as Partial<PostBody>, errors };
}

const invalid = (reply: FastifyReply, errors: EnvelopeError[]) =>
  migrationApiError(reply, 400, "Invalid document", errors);

/**
 * Migration API (C§5.2, R1§8): documents are created and updated as drafts staged in the repository's
 * single open migration release; publishing that release makes them live.
 */
export async function migrationApi(app: FastifyInstance, opts: { documents: DocumentService }): Promise<void> {
  const docs = opts.documents;
  const repos = new RepositoryService(app.sql);
  const models = new ModelService(app.sql);

  app.register(
    async (api) => {
      api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
        const name = resolveRepoName(req);
        const repo = name ? await repos.getByName(name) : null;
        if (!repo) return migrationApiError(reply, 403, "Repository not found");
        req.repo = repo;
        const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
        const ok = m ? await repos.verifyToken(repo.id, "write", m[1]!.trim()) : null;
        if (!ok) return migrationApiError(reply, 401, "Invalid or missing write token");
      });

      api.setErrorHandler((err, req, reply) => {
        if (err instanceof ValidationFailed) return invalid(reply, err.errors);
        if (err instanceof AlternateLangConflict) {
          return invalid(reply, [fieldError("alternate_language_id", undefined, err.message)]);
        }
        if (err instanceof UidConflict) return invalid(reply, [fieldError("uid", err.uid, err.message)]);
        if (err instanceof ReleaseNotOpen) return migrationApiError(reply, 400, err.message); // concurrent publish
        const status = (err as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500) return migrationApiError(reply, 400, (err as Error).message);
        req.log.error(err);
        return migrationApiError(reply, 500, "Internal error");
      });

      // R12: content stores canonical asset URLs (no /r/ prefix, configured or validated origin).
      const urlFor = (req: FastifyRequest) => (path: string) => canonicalOrigin(req) + path;

      api.post("/documents", async (req, reply) => {
        const { body, errors } = checkPost(req.body);
        if (typeof body.type === "string" && body.type !== "") {
          try {
            await models.getType(req.repo.id, body.type);
          } catch (e) {
            if (!(e instanceof ModelNotFound)) throw e;
            errors.push(fieldError("type", body.type, `Unknown custom type "${body.type}"`));
          }
        }
        if (errors.length) return invalid(reply, errors);
        let id: string;
        try {
          ({ id } = await docs.create(
            req.repo.id,
            null,
            {
              type: body.type,
              lang: body.lang,
              uid: body.uid ?? null,
              tags: body.tags ?? [],
              title: body.title,
              data: body.data,
              alternateOf: body.alternate_language_id,
            },
            { urlFor: urlFor(req), stageInMigrationRelease: true },
          ));
        } catch (e) {
          if (e instanceof DocumentNotFound) {
            return invalid(reply, [fieldError("alternate_language_id", body.alternate_language_id, "The document does not exist")]);
          }
          throw e;
        }
        const out: Record<string, unknown> = { id, title: body.title, type: body.type, lang: body.lang };
        if (body.uid) out.uid = body.uid;
        return reply.code(201).send(out);
      });

      const put = async (req: FastifyRequest, reply: FastifyReply) => {
        const id = (req.params as { id: string }).id;
        const { body, errors } = checkPut(req.body);
        if (errors.length) return invalid(reply, errors);
        try {
          await docs.updateDraft(
            req.repo.id,
            null,
            id,
            // Omitting `tags` on PUT clears them (R1§8); omitted uid/title carry over.
            { uid: body.uid ?? undefined, title: body.title, tags: body.tags ?? [], data: body.data! },
            { urlFor: urlFor(req), stageInMigrationRelease: true },
          );
        } catch (e) {
          if (e instanceof DocumentNotFound) return migrationApiError(reply, 404, `Document ${id} not found`);
          throw e;
        }
        return reply.code(200).send({ id });
      };
      api.put("/documents/:id", put);
      api.put("/documents/:id/", put);

      api.post("/migration-release/publish", async (req, reply) => {
        const release = await docs.findMigrationRelease(req.repo.id);
        if (!release) return reply.code(202).send({ totalItems: 0 });
        // Published synchronously; the live API answers 202 and processes asynchronously.
        await docs.publishRelease(req.repo.id, null, release.id);
        // Counted after publishing: a published release's items no longer change.
        const [row] = await app.sql`select count(*)::int as n from release_items where release_id = ${release.id}`;
        return reply.code(202).send({ totalItems: row!.n as number });
      });
    },
    { prefix: "/migration-api" },
  );
}
