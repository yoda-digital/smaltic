import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AssetNotFound, AssetService, InvalidAsset, assetJson, tagJson, type AssetPatch } from "../domain/assets.js";
import { RepositoryService } from "../domain/repositories.js";
import { assetApiError } from "../http/errors.js";
import { resolveRepoName } from "../http/repoContext.js";

/** Upload limit for one original. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{16}$/;

/**
 * Asset API (C§5.3, R1§9): upload (multipart), metadata patch, tags. Plus `GET /assets/:repo/:file`,
 * which serves originals (imgix query params are ignored until image transforms land in Plan 2).
 */
export async function assetApi(app: FastifyInstance, opts: { assets: AssetService }): Promise<void> {
  const assets = opts.assets;
  const repos = new RepositoryService(app.sql);

  app.register(
    async (api) => {
      await api.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

      api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
        const name = resolveRepoName(req);
        const repo = name ? await repos.getByName(name) : null;
        if (!repo) return assetApiError(reply, 403, "Repository not found");
        req.repo = repo;
        const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
        const ok = m ? await repos.verifyToken(repo.id, "write", m[1]!.trim()) : null;
        if (!ok) return assetApiError(reply, 401, "Invalid or missing write token");
      });

      api.setErrorHandler((err, req, reply) => {
        if (err instanceof InvalidAsset) return assetApiError(reply, 400, err.message);
        if (err instanceof AssetNotFound) return assetApiError(reply, 404, err.message);
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 413) return assetApiError(reply, 413, (err as Error).message);
        if (status && status >= 400 && status < 500) return assetApiError(reply, 400, (err as Error).message);
        req.log.error(err);
        return assetApiError(reply, 500, "Internal error");
      });

      api.post("/assets", async (req, reply) => {
        if (!req.isMultipart()) return assetApiError(reply, 400, "Expected multipart/form-data");
        let file: { filename: string; mime: string; bytes: Buffer } | undefined;
        const fields: Record<string, string> = {};
        for await (const part of req.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "file" || file) {
              await part.toBuffer();
              continue;
            }
            file = { filename: part.filename, mime: part.mimetype, bytes: await part.toBuffer() };
          } else if (["notes", "credits", "alt"].includes(part.fieldname) && typeof part.value === "string") {
            fields[part.fieldname] = part.value;
          }
        }
        if (!file) return assetApiError(reply, 400, "Missing file");
        const asset = await assets.create(req.repo.id, file, { notes: fields.notes, credits: fields.credits, alt: fields.alt });
        return reply.code(200).send(assetJson(asset, assets.publicAssetUrl(req, asset)));
      });

      api.patch("/assets/:id", async (req, reply) => {
        const body = (req.body ?? {}) as AssetPatch;
        if (typeof body !== "object" || Array.isArray(body)) return assetApiError(reply, 400, "Expected a JSON object");
        const { notes, credits, alt, filename, tags } = body;
        const asset = await assets.update(req.repo.id, (req.params as { id: string }).id, { notes, credits, alt, filename, tags });
        return reply.code(200).send(assetJson(asset, assets.publicAssetUrl(req, asset)));
      });

      api.get("/tags", async (req) => ({ items: (await assets.listTags(req.repo.id)).map(tagJson) }));

      api.post("/tags", async (req, reply) => {
        const name = (req.body as { name?: unknown } | null)?.name;
        const tag = await assets.createTag(req.repo.id, name as string);
        return reply.code(201).send(tagJson(tag));
      });
    },
    { prefix: "/asset-api" },
  );

  // Originals. The id is the first 16 chars; the filename part is informative only, so renamed assets
  // keep their old URLs working. The filesystem path comes from the DB, never from the URL.
  app.get("/assets/:repo/:file", async (req, reply) => {
    const { repo, file } = req.params as { repo: string; file: string };
    const id = file.slice(0, 16);
    const asset = ID_RE.test(id) && file[16] === "_" ? await assets.getByRepoName(repo, id) : null;
    const path = asset ? assets.blobPath(asset) : null;
    const st = path ? await stat(path).catch(() => null) : null;
    if (!asset || !path || !st?.isFile()) return assetApiError(reply, 404, "Asset not found");
    reply
      .header("content-type", asset.mime)
      .header("content-length", String(st.size))
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("last-modified", asset.createdAt.toUTCString());
    // Uploaded SVG (or HTML disguised as a document) must not run script in our origin.
    if (asset.mime === "image/svg+xml" || asset.kind === "document") {
      reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    return reply.send(createReadStream(path));
  });
}
