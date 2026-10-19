import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type AssetInfo } from "@smaltic/model";
import type { FastifyRequest } from "fastify";
import sharp from "sharp";
import type { Config } from "../config.js";
import type { Sql } from "../db/index.js";
import { canonicalOrigin } from "../http/repoContext.js";

export type AssetKind = "image" | "audio" | "video" | "document";

export interface AssetTag {
  id: string;
  name: string;
  createdAt: Date;
}

export interface Asset {
  id: string;
  repoId: string;
  repoName: string;
  filename: string;
  extension: string;
  kind: AssetKind;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  credits: string | null;
  notes: string | null;
  storageKey: string;
  uploaderId: string | null;
  createdAt: Date;
  lastModified: Date;
  tags: AssetTag[];
}

export interface AssetMeta {
  notes?: string | null;
  credits?: string | null;
  alt?: string | null;
  uploaderId?: string | null;
}

export interface AssetPatch {
  notes?: string | null;
  credits?: string | null;
  alt?: string | null;
  filename?: string;
  /** Tag ids; replaces the asset's tags when present. */
  tags?: string[];
}

/** Builds an absolute URL from a path starting with `/`. */
export type UrlFor = (path: string) => string;

export class AssetNotFound extends Error {
  constructor(public id: string) {
    super(`Asset ${id} not found`);
  }
}
export class InvalidAsset extends Error {}

const META_MAX = 500; // C§5.3 validateAssetMetadata
const TAG_MIN = 3;
const TAG_MAX = 20;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", ico: "image/x-icon",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip",
};

/** Keeps the last path segment, drops control characters; never empty. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return clean === "" || clean === "." || clean === ".." ? "file" : clean;
}

export const extensionOf = (filename: string): string => {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i + 1).toLowerCase() : "";
};

export function mimeOf(given: string | undefined, filename: string): string {
  const m = given?.split(";")[0]?.trim().toLowerCase();
  if (m && m !== "application/octet-stream") return m;
  return MIME_BY_EXT[extensionOf(filename)] ?? "application/octet-stream";
}

export function kindOf(mime: string): AssetKind {
  const top = mime.split("/")[0];
  return top === "image" || top === "audio" || top === "video" ? top : "document";
}

function checkMeta(meta: Record<string, unknown>): void {
  for (const k of ["notes", "credits", "alt"] as const) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new InvalidAsset(`${k} must be a string`);
    if (v.length > META_MAX) throw new InvalidAsset(`${k} must be at most ${META_MAX} characters`);
  }
}

const tx = <T>(sql: Sql, fn: (t: Sql) => Promise<T>): Promise<T> =>
  sql.begin((t) => fn(t as unknown as Sql)) as Promise<T>;

/** Media library: originals on disk under `<dataDir>/assets/<repo>/<id>_<filename>`, metadata in Postgres. */
export class AssetService {
  constructor(private sql: Sql, private config: Pick<Config, "dataDir" | "publicUrl">) {}

  /** Absolute path of an asset's original. */
  blobPath(asset: Pick<Asset, "storageKey">): string {
    return join(this.config.dataDir, "assets", asset.storageKey);
  }

  async create(repoId: string, file: { filename: string; mime?: string; bytes: Buffer }, meta: AssetMeta = {}): Promise<Asset> {
    checkMeta(meta as Record<string, unknown>);
    const [repo] = await this.sql`select name from repositories where id = ${repoId}`;
    if (!repo) throw new InvalidAsset(`Unknown repository ${repoId}`);
    const filename = sanitizeFilename(file.filename);
    const mime = mimeOf(file.mime, filename);
    const kind = kindOf(mime);
    let width: number | null = null;
    let height: number | null = null;
    if (kind === "image") {
      try {
        const m = await sharp(file.bytes).metadata();
        if (m.width && m.height) ({ width, height } = { width: m.width, height: m.height });
      } catch {
        // Not decodable by sharp (e.g. icon formats): stored without dimensions.
      }
    }
    const id = newId();
    const storageKey = `${repo.name}/${id}_${filename}`;
    const path = this.blobPath({ storageKey });
    await mkdir(join(this.config.dataDir, "assets", repo.name), { recursive: true });
    await writeFile(path, file.bytes);
    try {
      await this.sql`insert into assets (id, repo_id, filename, extension, kind, mime, size, width, height, alt, credits, notes, storage_key, uploader_id)
        values (${id}, ${repoId}, ${filename}, ${extensionOf(filename)}, ${kind}, ${mime}, ${file.bytes.length}, ${width}, ${height},
          ${meta.alt || null}, ${meta.credits || null}, ${meta.notes || null}, ${storageKey}, ${meta.uploaderId ?? null})`;
    } catch (e) {
      await unlink(path).catch(() => {});
      throw e;
    }
    return (await this.get(repoId, id))!;
  }

  async get(repoId: string, id: string): Promise<Asset | null> {
    const [row] = await this.sql`select a.*, r.name as repo_name from assets a join repositories r on r.id = a.repo_id
      where a.id = ${id} and a.repo_id = ${repoId}`;
    if (!row) return null;
    const tags = await this.sql`select t.id, t.name, t.created_at from asset_tag_links l join asset_tags t on t.id = l.tag_id
      where l.asset_id = ${id} order by t.name`;
    return toAsset(row, tags.map(toTag));
  }

  /** Finds an asset by repository name and id (file serving). */
  async getByRepoName(repoName: string, id: string): Promise<Asset | null> {
    const [row] = await this.sql`select a.repo_id from assets a join repositories r on r.id = a.repo_id
      where a.id = ${id} and r.name = ${repoName}`;
    return row ? this.get(row.repo_id, id) : null;
  }

  async update(repoId: string, id: string, patch: AssetPatch): Promise<Asset> {
    checkMeta(patch as Record<string, unknown>);
    if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some((t) => typeof t !== "string"))) {
      throw new InvalidAsset("tags must be an array of tag ids");
    }
    if (patch.filename !== undefined && typeof patch.filename !== "string") throw new InvalidAsset("filename must be a string");
    await tx(this.sql, async (t) => {
      const [row] = await t`select * from assets where id = ${id} and repo_id = ${repoId} for update`;
      if (!row) throw new AssetNotFound(id);
      const pick = (k: "notes" | "credits" | "alt") => (patch[k] === undefined ? row[k] : patch[k] || null);
      const filename = patch.filename === undefined ? row.filename : sanitizeFilename(patch.filename);
      await t`update assets set notes = ${pick("notes")}, credits = ${pick("credits")}, alt = ${pick("alt")},
        filename = ${filename}, extension = ${extensionOf(filename)}, last_modified = now() where id = ${id}`;
      if (patch.tags !== undefined) {
        const tagIds = [...new Set(patch.tags)];
        const found = await t`select id from asset_tags where repo_id = ${repoId} and id = any(${tagIds})`;
        if (found.length !== tagIds.length) throw new InvalidAsset("Unknown tag id");
        await t`delete from asset_tag_links where asset_id = ${id}`;
        for (const tagId of tagIds) await t`insert into asset_tag_links (asset_id, tag_id) values (${id}, ${tagId})`;
      }
    });
    return (await this.get(repoId, id))!;
  }

  async listTags(repoId: string): Promise<Array<AssetTag & { count: number }>> {
    const rows = await this.sql`select t.id, t.name, t.created_at, count(l.asset_id)::int as count
      from asset_tags t left join asset_tag_links l on l.tag_id = t.id
      where t.repo_id = ${repoId} group by t.id order by t.name`;
    return rows.map((r) => ({ ...toTag(r), count: r.count as number }));
  }

  async createTag(repoId: string, name: string): Promise<AssetTag> {
    if (typeof name !== "string" || name.length < TAG_MIN || name.length > TAG_MAX) {
      throw new InvalidAsset(`Tag name must be between ${TAG_MIN} and ${TAG_MAX} characters`);
    }
    const [row] = await this.sql`insert into asset_tags (id, repo_id, name) values (${newId()}, ${repoId}, ${name})
      on conflict (repo_id, name) do update set name = excluded.name
      returning id, name, created_at`;
    return toTag(row);
  }

  /** `/assets/<repo>/<id>_<filename>`: the SDK derives the filename from the part after the last `_` (C§5.3). */
  assetPath(asset: Pick<Asset, "repoName" | "id" | "filename">): string {
    return `/assets/${encodeURIComponent(asset.repoName)}/${asset.id}_${encodeURIComponent(asset.filename)}`;
  }

  /** Canonical asset URL (R12): `<origin>/assets/<repo>/<id>_<filename>`, never with the `/r/` prefix. */
  publicAssetUrl(req: FastifyRequest, asset: Asset): string {
    return canonicalOrigin(req) + this.assetPath(asset);
  }

  /** Normalization lookup (R10). Without `urlFor`, urls use SMALTIC_PUBLIC_URL (or http://localhost). */
  async lookup(repoId: string, id: string, urlFor?: UrlFor): Promise<AssetInfo | null> {
    const a = await this.get(repoId, id);
    if (!a) return null;
    const url = (urlFor ?? this.defaultUrlFor)(this.assetPath(a));
    return { id: a.id, url, filename: a.filename, kind: a.kind, size: a.size, width: a.width, height: a.height };
  }

  private defaultUrlFor: UrlFor = (path) => {
    let origin = "http://localhost";
    try {
      if (this.config.publicUrl) origin = new URL(this.config.publicUrl).origin;
    } catch {
      /* keep default */
    }
    return origin + path;
  };
}

const ms = (d: Date) => d.getTime();

/** Asset API JSON (C§5.3): timestamps are epoch milliseconds. */
export function assetJson(asset: Asset, url: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: asset.id,
    url,
    created_at: ms(asset.createdAt),
    last_modified: ms(asset.lastModified),
    filename: asset.filename,
    extension: asset.extension,
    size: asset.size,
    kind: asset.kind,
  };
  if (asset.width !== null) out.width = asset.width;
  if (asset.height !== null) out.height = asset.height;
  if (asset.notes !== null) out.notes = asset.notes;
  if (asset.credits !== null) out.credits = asset.credits;
  if (asset.alt !== null) out.alt = asset.alt;
  out.tags = asset.tags.map(tagJson);
  if (asset.uploaderId !== null) out.uploader_id = asset.uploaderId;
  return out;
}

export function tagJson(tag: AssetTag & { count?: number }): Record<string, unknown> {
  const out: Record<string, unknown> = { id: tag.id, name: tag.name, created_at: ms(tag.createdAt), last_modified: ms(tag.createdAt) };
  if (tag.count !== undefined) out.count = tag.count;
  return out;
}

function toTag(r: any): AssetTag {
  return { id: r.id, name: r.name, createdAt: r.created_at };
}

function toAsset(r: any, tags: AssetTag[]): Asset {
  return {
    id: r.id,
    repoId: r.repo_id,
    repoName: r.repo_name,
    filename: r.filename,
    extension: r.extension,
    kind: r.kind,
    mime: r.mime,
    size: Number(r.size),
    width: r.width,
    height: r.height,
    alt: r.alt,
    credits: r.credits,
    notes: r.notes,
    storageKey: r.storage_key,
    uploaderId: r.uploader_id,
    createdAt: r.created_at,
    lastModified: r.last_modified,
    tags,
  };
}
