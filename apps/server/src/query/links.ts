// Link resolution for the Content API (R1§4.7, §4.8, §6): route resolver (`routes`, `brokenRoute`), linked-document
// stubs, linked `data` from fetchLinks / graphQuery / model-level field selection, deprecated `fetch`, and canonical
// asset URLs (R12).
//
// Rendering is synchronous (`renderDocumentData` + `RenderCtx`), so linked documents and assets are loaded in
// batches before the final render: each pass renders the whole page and records the document / asset ids it could
// not resolve yet; they are loaded with one query each (same ref scope) and the page is rendered again. The number
// of passes is bounded by the nesting depth (links -> selected linked data -> 2nd level -> route resolvers), so a
// page costs at most a handful of statements whatever its size, never one per link.
import {
  flattenFields, isObj, isStr, renderDocumentData, sliceShape, subFields, variationOf,
  type AnyField, type BrokenStub, type CustomType, type Field, type LinkedDocStub, type RenderCtx,
  type SharedSlice, type StoredData,
} from "@smaltic/model";
import type { Sql } from "../db/index.js";
import { assetPath } from "../domain/assets.js";
import { ModelService } from "../domain/models.js";
import type { VersionRow } from "./compile.js";
import {
  LinkParamError, linkTargetSelection, mergeSelections, modelSelection, parseFetch, parseFetchLinks, parseGraphQuery,
  project, type Selection,
} from "./graphQuery.js";
import { visibleVersionsSql, type RefScope } from "./visible.js";

export { LinkParamError };

// ---- routes -------------------------------------------------------------------------------------------------

/** A route resolver rule (R1§6). */
export interface Route {
  type: string;
  path: string;
  /** keyword -> content relationship field id of the routed doc; `a.b` follows two relationships. */
  resolvers?: Record<string, string>;
  uid?: string;
  lang?: string;
}

/** Parses and validates the `routes` query parameter (JSON array). Throws `LinkParamError`. */
export function parseRoutes(raw: string): Route[] {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new LinkParamError("routes: invalid JSON");
  }
  if (!Array.isArray(v)) throw new LinkParamError("routes: expected an array");
  return v.map((r, i) => {
    if (!isObj(r) || !isStr(r.type) || !isStr(r.path)) throw new LinkParamError(`routes[${i}]: 'type' and 'path' must be strings`);
    const out: Route = { type: r.type, path: r.path };
    if (r.resolvers !== undefined) {
      if (!isObj(r.resolvers) || !Object.values(r.resolvers).every(isStr)) {
        throw new LinkParamError(`routes[${i}]: 'resolvers' must map keywords to field ids`);
      }
      out.resolvers = r.resolvers as Record<string, string>;
    }
    for (const k of ["uid", "lang"] as const) {
      if (r[k] === undefined) continue;
      if (!isStr(r[k])) throw new LinkParamError(`routes[${i}]: '${k}' must be a string`);
      out[k] = r[k];
    }
    return out;
  });
}

/** What the route resolver needs of a document; `data` is the stored data (links reduced to `{link_type, id}`). */
export interface RoutableDoc {
  id: string;
  type: string;
  uid: string | null;
  lang: string;
  data: StoredData;
}

/** The document linked from `doc` through its content relationship field `field`, or null (empty/broken). */
export type ResolveParent = (doc: RoutableDoc, field: string) => RoutableDoc | null;

const KEYWORD_RE = /:([A-Za-z_][A-Za-z0-9_]*)(\?)?/g;
const MAX_RESOLVER_DEPTH = 2;

/**
 * URL of `doc` per R1§6: the first route (in array order) whose `type` matches and whose `uid` / `lang` scopes
 * match, and whose required keywords all have a value, wins. `null` when none matches.
 * Keywords: `:uid`, `:lang`, `:lang?` (omitted for `masterLang`), `:<resolver>` / `:<resolver>?` = UID of the
 * document reached through the resolver's field path (max 2 levels). Empty optional segments collapse.
 */
export function resolveUrl(doc: RoutableDoc, routes: Route[], resolveParent: ResolveParent, masterLang?: string): string | null {
  for (const r of routes) {
    if (r.type !== doc.type) continue;
    if (r.uid !== undefined && r.uid !== doc.uid) continue;
    if (r.lang !== undefined && r.lang !== doc.lang) continue;
    const url = renderPath(r, doc, resolveParent, masterLang);
    if (url !== null) return url;
  }
  return null;
}

function renderPath(r: Route, doc: RoutableDoc, resolveParent: ResolveParent, masterLang?: string): string | null {
  const value = (name: string, optional: boolean): string | null => {
    if (r.resolvers && Object.prototype.hasOwnProperty.call(r.resolvers, name)) {
      const steps = r.resolvers[name]!.split(".");
      if (steps.length > MAX_RESOLVER_DEPTH) return null;
      let cur: RoutableDoc | null = doc;
      for (const s of steps) {
        cur = resolveParent(cur, s);
        if (!cur) return null;
      }
      return cur.uid;
    }
    if (name === "uid") return doc.uid;
    if (name === "lang") return optional && masterLang !== undefined && doc.lang === masterLang ? null : doc.lang;
    return null;
  };
  const segments: string[] = [];
  for (const seg of r.path.split("/")) {
    if (seg === "") continue;
    let ok = true;
    const out = seg.replace(KEYWORD_RE, (_m, name: string, opt?: string) => {
      const v = value(name, opt === "?");
      if (v === null || v === "") {
        if (opt !== "?") ok = false;
        return "";
      }
      return v;
    });
    if (!ok) return null;
    if (out !== "") segments.push(out);
  }
  const trailing = r.path.length > 1 && r.path.endsWith("/") && segments.length > 0 ? "/" : "";
  return `/${segments.join("/")}${trailing}`;
}

// ---- shapes -------------------------------------------------------------------------------------------------

/** Content API timestamp `YYYY-MM-DDTHH:mm:ss+0000`. */
export function apiDate(d: Date | null): string | null {
  return d ? `${d.toISOString().slice(0, 19)}+0000` : null;
}

/**
 * Document slug: the slugified text of the first non-empty text block of the first rich text field (model order),
 * `-` when there is none. Live: `"Integrating ... Next.js blog"` -> `integrating-...-next.js-blog` [INFERENCE].
 */
export function slugOf(model: CustomType | undefined, data: StoredData): string {
  if (model && isObj(data)) {
    for (const [k, f] of flattenFields(model)) {
      if (f.type !== "StructuredText") continue;
      const blocks = data[k];
      if (!Array.isArray(blocks)) continue;
      const first = blocks.find((b) => isObj(b) && isStr(b.text) && b.text.trim() !== "") as { text: string } | undefined;
      if (!first) continue;
      const slug = first.text.toLowerCase()
        .replace(/[^\p{L}\p{N}\s._-]/gu, "")
        .trim()
        .replace(/[\s_]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      if (slug) return slug;
    }
  }
  return "-";
}

// ---- page rendering -----------------------------------------------------------------------------------------

export interface RenderModels {
  types: Map<string, CustomType>;
  slices: Map<string, SharedSlice>;
}

/** All custom types and shared slices of a repository (2 statements; load once per request). */
export async function loadModels(sql: Sql, repoId: string): Promise<RenderModels> {
  const svc = new ModelService(sql);
  const [types, slices] = await Promise.all([svc.listTypes(repoId), svc.listSlices(repoId)]);
  return {
    types: new Map(types.map((t) => [t.id, t as unknown as CustomType])),
    slices: new Map(slices.map((s) => [s.id, s as unknown as SharedSlice])),
  };
}

export interface RenderEnv {
  sql: Sql;
  repoId: string;
  /** Ref scope of the query: linked documents are loaded in the same scope. */
  scope: RefScope;
  /** Master locale code (for `:lang?`). */
  masterLang: string;
  models: RenderModels;
  /**
   * Canonical origin for asset URLs (R12), e.g. `canonicalOrigin(req)`. With `repoName`, image and media URLs are
   * rebuilt as `<assetOrigin>/assets/<repoName>/<id>_<filename>`; without, stored URLs are kept.
   */
  assetOrigin?: string;
  repoName?: string;
}

export interface LinkOptions {
  /** Parsed `routes` param (see `parseRoutes`). Without routes every `url` is null. */
  routes?: Route[];
  brokenRoute?: string;
  fetchLinks?: string;
  graphQuery?: string;
  /** Deprecated `fetch` param. */
  fetch?: string;
}

/** What Task 10 needs per result: the document `url` and its rendered `data`. */
export interface RenderedDocument {
  url: string | null;
  data: Record<string, unknown>;
}

export interface PageRenderer {
  /** Render context for a document of the page (depth 0, with the page's graphQuery selection). */
  ctxFor(row: VersionRow): RenderCtx;
  /** Renders one document of the page (its links must have been loaded by `buildRenderCtx`). */
  render(row: VersionRow): RenderedDocument;
}

interface LoadedDoc extends RoutableDoc {
  tags: string[];
  firstPublicationDate: Date | null;
  lastPublicationDate: Date | null;
}

/** Linked data is rendered for documents up to this depth (top-level doc = 0): 2 nested levels (R1§4.8). */
const MAX_DATA_DEPTH = 2;
/** Safety bound on loading passes; the nesting rules need at most ~5. */
const MAX_PASSES = 8;

const fromRow = (r: VersionRow): LoadedDoc => ({
  id: r.id, type: r.type, uid: r.uid, lang: r.lang, data: r.data, tags: r.tags,
  firstPublicationDate: r.firstPublicationDate, lastPublicationDate: r.lastPublicationDate,
});

class Page implements PageRenderer {
  readonly docs = new Map<string, LoadedDoc | null>();
  readonly assets = new Map<string, string | null>();
  missingDocs = new Set<string>();
  missingAssets = new Set<string>();
  private urls = new Map<string, string | null>();
  private routes: Route[];
  private fetchLinks: Map<string, Selection> | null;
  private graphQuery: Selection | null;
  private fetch: Map<string, Selection> | null;

  constructor(private env: RenderEnv, private opts: LinkOptions) {
    this.routes = opts.routes ?? [];
    this.fetchLinks = opts.fetchLinks?.trim() ? parseFetchLinks(opts.fetchLinks) : null;
    this.graphQuery = opts.graphQuery?.trim() ? parseGraphQuery(opts.graphQuery) : null;
    this.fetch = opts.fetch?.trim() ? parseFetch(opts.fetch) : null;
  }

  beginPass(): void {
    this.missingDocs = new Set();
    this.missingAssets = new Set();
    this.urls = new Map();
  }

  ctxFor(row: VersionRow): RenderCtx {
    return this.ctx(this.docs.get(row.id) ?? fromRow(row), 0, this.graphQuery?.fields.get(row.type) ?? null);
  }

  render(row: VersionRow): RenderedDocument {
    const doc = this.docs.get(row.id) ?? fromRow(row);
    const url = this.urlOf(doc);
    const model = this.env.models.types.get(row.type);
    if (!model) return { url, data: {} };
    const gq = this.graphQuery?.fields.get(row.type) ?? null;
    let data = renderDocumentData(model, this.env.models.slices, row.data, this.ctx(doc, 0, gq));
    if (gq) data = project(data, gq, row.type);
    const fetched = this.fetch?.get(row.type);
    if (fetched) data = project(data, fetched, row.type);
    return { url, data };
  }

  /** Context for rendering `doc` at `depth`; `sel` is the selection of its data (drives nested link data). */
  private ctx(doc: LoadedDoc, depth: number, sel: Selection | null): RenderCtx {
    const ctx: RenderCtx = { resolveLink: (id, path, field) => this.stub(doc, depth, sel, id, path, field) };
    if (this.env.assetOrigin !== undefined && this.env.repoName !== undefined) ctx.resolveAssetUrl = (id) => this.assetUrl(id);
    return ctx;
  }

  private broken(id: string): BrokenStub {
    const out: Record<string, unknown> = { id, type: "broken" };
    if (this.opts.brokenRoute !== undefined) out.url = this.opts.brokenRoute;
    return { ...out, link_type: "Document", isBroken: true } as BrokenStub;
  }

  private stub(from: LoadedDoc, depth: number, sel: Selection | null, id: string, path: string, field?: Field): LinkedDocStub | BrokenStub {
    const target = this.docs.get(id);
    if (target === undefined) {
      this.missingDocs.add(id);
      return this.broken(id);
    }
    if (target === null) return this.broken(id);
    const model = this.env.models.types.get(target.type);
    const out: Record<string, unknown> = {
      id: target.id,
      type: target.type,
      tags: target.tags,
      lang: target.lang,
      slug: slugOf(model, target.data),
      first_publication_date: apiDate(target.firstPublicationDate),
      last_publication_date: apiDate(target.lastPublicationDate),
    };
    if (target.uid !== null) out.uid = target.uid;
    const url = this.urlOf(target);
    if (url !== null) out.url = url;

    if (depth < MAX_DATA_DEPTH && model) {
      const sels: Selection[] = [];
      if (sel) {
        const link = this.walkToLink(sel, path, this.env.models.types.get(from.type));
        const s = link && linkTargetSelection(link, target.type);
        if (s) sels.push(s);
      }
      // A graphQuery naming the page type is the whole selection: fetchLinks / model selection don't add to it.
      if (depth === 0 && !sel) {
        const fl = this.fetchLinks?.get(target.type);
        if (fl) sels.push(fl);
        const ms = modelSelection((field as AnyField | undefined)?.config?.customtypes, target.type);
        if (ms) sels.push(ms);
      }
      if (sels.length > 0) {
        const merged = sels.reduce(mergeSelections);
        const full = renderDocumentData(model, this.env.models.slices, target.data, this.ctx(target, depth + 1, merged));
        out.data = project(full, merged, target.type);
      }
    }
    return out as LinkedDocStub;
  }

  /**
   * Follows a link's model path (see `RenderCtx.resolveLink`) through `sel`; returns the selection on the link
   * field, or null when the path leaves the selection or doesn't end on a link.
   */
  private walkToLink(sel: Selection, path: string, model: CustomType | undefined): Selection | null {
    if (!model) return null;
    const segs = path.split(".");
    let fields = Object.fromEntries(flattenFields(model)) as Record<string, AnyField>;
    let cur = sel;
    let i = 0;
    while (i < segs.length) {
      const f = Object.prototype.hasOwnProperty.call(fields, segs[i]!) ? fields[segs[i]!] : undefined;
      const next = cur.fields.get(segs[i]!);
      if (!f || !next) return null;
      cur = next;
      if (f.type === "Link") return i === segs.length - 1 ? cur : null;
      if (f.type === "Group") {
        fields = subFields(f);
        i += 1;
      } else if (f.type === "Slices" || f.type === "Choice") {
        const sliceType = segs[i + 1];
        const shape = sliceType ? sliceShape(f, sliceType, this.env.models.slices) : null;
        const branch = sliceType ? cur.on.get(sliceType) : undefined;
        if (!shape || !branch) return null;
        let part: string | undefined;
        if (shape.kind === "shared") {
          const v = variationOf(shape.model, segs[i + 2]);
          part = segs[i + 3];
          if (!v || (part !== "primary" && part !== "items")) return null;
          fields = v[part];
          i += 4;
        } else {
          part = segs[i + 2];
          if (part !== "primary" && part !== "items") return null;
          fields = shape[part];
          i += 3;
        }
        const partSel = branch.fields.get(part);
        if (!partSel) return null;
        cur = partSel;
      } else return null;
    }
    return null;
  }

  urlOf(doc: LoadedDoc): string | null {
    if (this.routes.length === 0) return null;
    if (this.urls.has(doc.id)) return this.urls.get(doc.id)!;
    const url = resolveUrl(doc, this.routes, (d, f) => this.parentOf(d, f), this.env.masterLang);
    this.urls.set(doc.id, url);
    return url;
  }

  private parentOf(doc: RoutableDoc, field: string): RoutableDoc | null {
    const v = isObj(doc.data) ? doc.data[field] : undefined;
    if (!isObj(v) || v.link_type !== "Document" || !isStr(v.id)) return null;
    const t = this.docs.get(v.id);
    if (t === undefined) {
      this.missingDocs.add(v.id);
      return null;
    }
    return t;
  }

  private assetUrl(id: string): string | null {
    if (!this.assets.has(id)) {
      this.missingAssets.add(id);
      return null;
    }
    return this.assets.get(id)!;
  }

  /** One statement: the visible version (same ref scope) of every requested document. Absent = broken. */
  async loadDocs(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { sql, repoId, scope } = this.env;
    const rows = await sql`
      select d.id, d.type, d.lang, d.first_publication_date, d.last_publication_date, ver.uid, ver.tags, ver.data
      from (${visibleVersionsSql(sql, repoId, scope)}) x
      join documents d on d.id = x.document_id
      join document_versions ver on ver.id = x.version_id
      where d.repo_id = ${repoId}::text and x.document_id = any(${ids}::text[])`;
    for (const id of ids) this.docs.set(id, null);
    for (const r of rows) {
      this.docs.set(r.id, {
        id: r.id, type: r.type, uid: r.uid, lang: r.lang, data: r.data, tags: r.tags,
        firstPublicationDate: r.first_publication_date, lastPublicationDate: r.last_publication_date,
      });
    }
  }

  /** One statement: canonical URLs of the requested assets of this repository. Absent = keep stored URL. */
  async loadAssets(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { sql, repoId, assetOrigin, repoName } = this.env;
    const rows = await sql`select id, filename from assets where repo_id = ${repoId}::text and id = any(${ids}::text[])`;
    for (const id of ids) this.assets.set(id, null);
    for (const r of rows) this.assets.set(r.id, assetOrigin + assetPath({ repoName: repoName!, id: r.id, filename: r.filename }));
  }
}

/**
 * Loads everything the page's documents link to (batched, same ref scope) and returns a renderer for them.
 * Throws `LinkParamError` on malformed `fetchLinks` / `graphQuery` / `fetch` before touching the database.
 */
export async function buildRenderCtx(env: RenderEnv, rows: VersionRow[], opts: LinkOptions): Promise<PageRenderer> {
  const page = new Page(env, opts);
  for (const r of rows) page.docs.set(r.id, fromRow(r));
  for (let pass = 0; ; pass++) {
    page.beginPass();
    for (const r of rows) page.render(r);
    const docIds = [...page.missingDocs];
    const assetIds = [...page.missingAssets];
    if (docIds.length === 0 && assetIds.length === 0) break;
    if (pass >= MAX_PASSES) {
      for (const id of docIds) page.docs.set(id, null);
      for (const id of assetIds) page.assets.set(id, null);
      break;
    }
    await Promise.all([page.loadDocs(docIds), page.loadAssets(assetIds)]);
  }
  page.beginPass();
  return page;
}

/**
 * Content API entry point (Task 10): renders a page of search results into `{url, data}` per row, in order.
 * `data` is the Content API `data` (links resolved, selections applied); `url` is the route-resolved URL or null.
 */
export async function renderDocuments(env: RenderEnv, rows: VersionRow[], opts: LinkOptions): Promise<RenderedDocument[]> {
  const page = await buildRenderCtx(env, rows, opts);
  return rows.map((r) => page.render(r));
}
