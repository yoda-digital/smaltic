import { createHmac, timingSafeEqual } from "node:crypto";
import { newId } from "@smaltic/model";
import type { Sql } from "../db/index.js";
import type { RefScope } from "../query/visible.js";

export interface MasterRef {
  ref: string;
  /** bigint as decimal string (postgres bigint). */
  seq: string;
}

/** Namespace for per-repo advisory locks (two-key form, separate from the migrator's single-key lock). */
const REPO_LOCK_NS = 7272;

/** Serializes publications for one repository until the surrounding transaction ends. */
export async function lockRepo(t: Sql, repoId: string): Promise<void> {
  await t`select pg_advisory_xact_lock(${REPO_LOCK_NS}::int, hashtext(${repoId}))`;
}

export type PublicationKind = "init" | "publish" | "unpublish" | "release";

/** Inserts a publication (new master ref). Caller must hold `lockRepo` so seq order equals commit order. */
export async function insertPublication(t: Sql, repoId: string, kind: PublicationKind): Promise<MasterRef & { createdAt: Date }> {
  const [row] = await t`insert into publications (repo_id, ref, kind) values (${repoId}, ${newId()}, ${kind})
    returning seq, ref, created_at`;
  return { ref: row!.ref, seq: String(row!.seq), createdAt: row!.created_at };
}

/** Unknown ref (also: malformed, tampered or foreign preview token). Maps to `refNotFound(reply, master)`. */
export class RefNotFoundError extends Error {
  constructor(public master: string) {
    super("Ref not found");
  }
}
/** Superseded master ref older than the TTL. Maps to `refExpired(reply, master)`. */
export class RefExpiredError extends Error {
  constructor(public master: string) {
    super("Ref is expired");
  }
}
/** Valid preview token past its `exp`, or whose release is no longer open. Maps to `previewExpired(reply)`. */
export class PreviewExpiredError extends Error {
  constructor() {
    super("The preview token has expired");
  }
}

export type PreviewOverlay = "drafts" | { releaseId: string };

export interface RefServiceOpts {
  /** HMAC key for preview tokens (`config.secret`). Required by `createPreviewToken` / preview resolution. */
  secret?: string;
  /** Lifetime of a superseded master ref (`config.refTtlSeconds`). Default 3600. */
  refTtlSeconds?: number;
}

export interface ResolveRefOpts {
  /** Public host of the request (`host[:port]`), used to pick the toolbar cookie entry. */
  host?: string;
}

/** Preview token payload: repo id, overlay (`"drafts"` or a release id), optional document id, expiry (epoch s). */
interface PreviewPayload {
  r: string;
  o: string;
  d?: string;
  exp: number;
}

const PREVIEW_PREFIX = "pv.";
const DEFAULT_PREVIEW_TTL = 1800;

export class RefService {
  private secret?: string;
  private refTtlSeconds: number;

  constructor(private sql: Sql, opts: RefServiceOpts = {}) {
    this.secret = opts.secret;
    this.refTtlSeconds = opts.refTtlSeconds ?? 3600;
  }

  mintRef(): string {
    return newId();
  }

  /** Latest publication of the repo; the first call mints an initial master ref. */
  async currentMaster(repoId: string): Promise<MasterRef> {
    const found = await this.latest(this.sql, repoId);
    if (found) return found;
    return (await this.sql.begin(async (tx) => {
      const t = tx as unknown as Sql;
      await lockRepo(t, repoId);
      const again = await this.latest(t, repoId);
      if (again) return again;
      const { ref, seq } = await insertPublication(t, repoId, "init");
      return { ref, seq };
    })) as MasterRef;
  }

  /**
   * Resolves the `ref` query parameter of a Content API request into what it sees. Accepts a master
   * ref (current or historic), an open release's ref, a preview token (`pv.<payload>.<mac>`) or the
   * toolbar's `io.prismic.preview` JSON cookie blob (raw, `%22`/`%2C`-encoded or fully encoded).
   * Throws RefNotFoundError / RefExpiredError (with the current master ref) or PreviewExpiredError.
   */
  async resolveRef(repoId: string, raw: string, opts: ResolveRefOpts = {}): Promise<RefScope> {
    const ref = raw.trim();
    const blob = parseCookieBlob(ref);
    if (blob !== undefined) {
      const inner = blob === null ? null : pickCookieEntry(blob, opts.host);
      if (!inner || inner.startsWith("{")) throw await this.notFound(repoId);
      return this.resolvePlain(repoId, inner);
    }
    return this.resolvePlain(repoId, ref);
  }

  /** A ref that is not a JSON blob: preview token, master ref or release ref. */
  private async resolvePlain(repoId: string, ref: string): Promise<RefScope> {
    if (ref.startsWith(PREVIEW_PREFIX)) return this.resolvePreview(repoId, ref);
    const master = await this.currentMaster(repoId);
    if (ref === master.ref) return { kind: "master", seq: master.seq };

    const [pub] = await this.sql`select p.seq,
        (select n.created_at from publications n where n.repo_id = p.repo_id and n.seq > p.seq order by n.seq limit 1) as superseded_at
      from publications p where p.repo_id = ${repoId} and p.ref = ${ref}`;
    if (pub) {
      const supersededAt = pub.superseded_at as Date | null;
      if (supersededAt && Date.now() - supersededAt.getTime() > this.refTtlSeconds * 1000) {
        throw new RefExpiredError(master.ref);
      }
      return { kind: "historic", seq: String(pub.seq) };
    }

    const [rel] = await this.sql`select id from releases where repo_id = ${repoId} and ref = ${ref} and status = 'open'`;
    if (rel) return { kind: "release", seq: master.seq, releaseId: rel.id };
    throw new RefNotFoundError(master.ref);
  }

  private async resolvePreview(repoId: string, token: string): Promise<RefScope> {
    const payload = this.verifyPreviewToken(token);
    if (!payload || payload.r !== repoId) throw await this.notFound(repoId);
    if (payload.exp * 1000 <= Date.now()) throw new PreviewExpiredError();
    const master = await this.currentMaster(repoId);
    if (payload.o === "drafts") return { kind: "preview", seq: master.seq, overlay: "drafts" };
    const [rel] = await this.sql`select status from releases where repo_id = ${repoId} and id = ${payload.o}`;
    if (!rel) throw new RefNotFoundError(master.ref);
    // The release was published or deleted since the session started: the preview session is over.
    if (rel.status !== "open") throw new PreviewExpiredError();
    return { kind: "preview", seq: master.seq, overlay: { releaseId: payload.o } };
  }

  /** Mints a signed preview token `pv.<base64url JSON payload>.<base64url HMAC-SHA256>`. */
  createPreviewToken(repoId: string, overlay: PreviewOverlay, documentId?: string, ttlSeconds = DEFAULT_PREVIEW_TTL): string {
    const payload: PreviewPayload = {
      r: repoId,
      o: overlay === "drafts" ? "drafts" : overlay.releaseId,
      ...(documentId ? { d: documentId } : {}),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    const body = PREVIEW_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  /** Payload of a well-formed token whose MAC verifies (constant-time), else null. Expiry is not checked. */
  private verifyPreviewToken(token: string): PreviewPayload | null {
    const m = /^(pv\.[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!m) return null;
    const expected = Buffer.from(this.mac(m[1]!), "base64url");
    const given = Buffer.from(m[2]!, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const p = JSON.parse(Buffer.from(m[1]!.slice(PREVIEW_PREFIX.length), "base64url").toString("utf8"));
      if (typeof p?.r !== "string" || typeof p?.o !== "string" || typeof p?.exp !== "number") return null;
      if (p.d !== undefined && typeof p.d !== "string") return null;
      return p as PreviewPayload;
    } catch {
      return null;
    }
  }

  private mac(data: string): string {
    if (!this.secret) throw new Error("RefService: a secret is required for preview tokens");
    return createHmac("sha256", this.secret).update(data).digest("base64url");
  }

  private async notFound(repoId: string): Promise<RefNotFoundError> {
    return new RefNotFoundError((await this.currentMaster(repoId)).ref);
  }

  private async latest(t: Sql, repoId: string): Promise<MasterRef | null> {
    const [row] = await t`select ref, seq from publications where repo_id = ${repoId} order by seq desc limit 1`;
    return row ? { ref: row.ref, seq: String(row.seq) } : null;
  }
}

const safeDecode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/**
 * The toolbar cookie blob as an object, `null` when `ref` looks like a blob (starts with `{` or
 * `%7B`) but does not parse, `undefined` when it is not a blob at all. The cookie is written with
 * `encodeURIComponent` then partially decoded (`"` stays `%22`, `,` stays `%2C`), and the client
 * may or may not have been decoded once more on the way; so try the raw value and up to two decodes.
 */
function parseCookieBlob(ref: string): Record<string, unknown> | null | undefined {
  if (!ref.startsWith("{") && !/^%7B/i.test(ref)) return undefined;
  let candidate: string | null = ref;
  for (let i = 0; i < 3 && candidate !== null; i++) {
    if (candidate.startsWith("{")) {
      try {
        const v = JSON.parse(candidate);
        if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
        return null;
      } catch {
        /* not JSON yet: decode once more */
      }
    }
    const next = safeDecode(candidate);
    candidate = next === candidate ? null : next;
  }
  return null;
}

/**
 * The `preview` string of the entry keyed by `host` (case-insensitive, with or without port);
 * otherwise of the only entry carrying a `preview` string. Null when absent or ambiguous.
 */
function pickCookieEntry(blob: Record<string, unknown>, host?: string): string | null {
  const previews = new Map<string, string>();
  for (const [k, v] of Object.entries(blob)) {
    const p = v && typeof v === "object" ? (v as Record<string, unknown>).preview : undefined;
    if (typeof p === "string" && p !== "") previews.set(k.toLowerCase(), p);
  }
  if (host) {
    const h = host.toLowerCase();
    const bare = h.replace(/:\d+$/, "");
    const hit = previews.get(h) ?? previews.get(bare);
    if (hit) return hit;
  }
  return previews.size === 1 ? [...previews.values()][0]! : null;
}
