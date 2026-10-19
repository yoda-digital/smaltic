/**
 * Read side of the content pipeline: stored data -> Content API `data` (R2§2.20, C§2, live shapes win).
 * Content is filtered through the current model: keys not in the model are dropped and values whose
 * stored shape doesn't match the field type render as that type's empty value. Never throws on old data.
 */
import type { CustomType, Field, SharedSlice } from '../schema/customType.js';
import {
  BLOCK_TYPES, DATE_RE, dataFields, HEX_RE, isObj, isStr, sliceShape, subFields, TEXT_BLOCKS, TS_RE, variationOf,
  type AnyField, type Fields, type RenderCtx, type StoredData,
} from './shared.js';

const IMAGE_KEYS = ['dimensions', 'alt', 'copyright', 'url', 'id', 'edit'] as const;
const MEDIA_KEYS = ['kind', 'id', 'url', 'name', 'size', 'height', 'width'] as const;

class Renderer {
  constructor(private shared: Map<string, SharedSlice>, private rctx: RenderCtx) {}

  fields(fields: Fields, src: unknown, path: string): Record<string, unknown> {
    const o = isObj(src) ? src : {};
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(fields)) {
      if (f.type === 'UID' || f.type === 'Separator') continue;
      out[k] = this.field(f, o[k], path ? `${path}.${k}` : k);
    }
    return out;
  }

  field(f: AnyField, v: unknown, path: string): unknown {
    const cfg = f.config ?? {};
    switch (f.type) {
      case 'Boolean':
        return typeof v === 'boolean' ? v : (cfg.default_value ?? false);
      case 'Color':
        return isStr(v) && HEX_RE.test(v) ? v : null;
      case 'Date':
        return isStr(v) && DATE_RE.test(v) ? v : null;
      case 'Timestamp':
        return isStr(v) && TS_RE.test(v) ? v : null;
      case 'Number':
      case 'Range':
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      case 'Text':
      case 'Select':
        return isStr(v) && v !== '' ? v : null;
      case 'StructuredText':
        return this.richText(v, path);
      case 'Image':
        return this.image(cfg, v);
      case 'Link':
        if (cfg.repeat) return Array.isArray(v) ? v.map((l) => this.link(f, l, path, true)) : [];
        return this.link(f, v, path, true);
      case 'Embed':
        return isObj(v) && isStr(v.embed_url) ? { ...v } : {};
      case 'GeoPoint':
        return isObj(v) && typeof v.latitude === 'number' && typeof v.longitude === 'number'
          ? { latitude: v.latitude, longitude: v.longitude }
          : {};
      case 'IntegrationFields':
        // Only a catalog blob renders; a bare item id needs the catalog service (not implemented yet).
        return isObj(v) ? v : null;
      case 'Table':
        return this.table(v, path);
      case 'Group':
        return Array.isArray(v) ? v.map((item) => this.fields(subFields(f), item, path)) : [];
      case 'Slices':
      case 'Choice':
        return this.slices(f, v, path);
      default:
        return null;
    }
  }

  // ---- rich text ----

  richText(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) return [];
    const out: unknown[] = [];
    for (const b of v) {
      const r = this.block(b, path);
      if (r) out.push(r);
    }
    return out;
  }

  private block(b: unknown, path: string): Record<string, unknown> | null {
    if (!isObj(b) || !isStr(b.type) || !BLOCK_TYPES.has(b.type)) return null;
    if (TEXT_BLOCKS.has(b.type)) {
      if (!isStr(b.text)) return null;
      const out: Record<string, unknown> = { type: b.type, text: b.text, spans: this.spans(b.spans, path) };
      if (isStr(b.direction)) out.direction = b.direction;
      return out;
    }
    if (b.type === 'image') {
      if (!isStr(b.url) && !isStr(b.id)) return null;
      const out: Record<string, unknown> = { type: 'image' };
      for (const k of ['url', 'alt', 'copyright', 'dimensions', 'id', 'edit']) if (b[k] !== undefined) out[k] = b[k];
      this.assetUrl(out, true);
      if (isObj(b.linkTo)) {
        const l = this.link(undefined, b.linkTo, path, false);
        if (l.link_type !== 'Any') out.linkTo = l;
      }
      return out;
    }
    return isObj(b.oembed) && isStr(b.oembed.embed_url) ? { type: 'embed', oembed: { ...b.oembed } } : null;
  }

  private spans(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) return [];
    const out: unknown[] = [];
    for (const s of v) {
      if (!isObj(s) || !isStr(s.type) || typeof s.start !== 'number' || typeof s.end !== 'number') continue;
      const span: Record<string, unknown> = { start: s.start, end: s.end, type: s.type };
      if (s.type === 'hyperlink') {
        const data = this.link(undefined, s.data, path, false);
        if (data.link_type === 'Any') continue;
        span.data = data;
      } else if (s.data !== undefined) span.data = s.data;
      out.push(span);
    }
    return out;
  }

  // ---- image ----

  private image(cfg: Record<string, any>, v: unknown): Record<string, unknown> {
    if (!isObj(v) || (!isStr(v.id) && !isStr(v.url))) return {};
    const main = this.assetUrl(pick(v, IMAGE_KEYS), true);
    const out: Record<string, unknown> = { ...main };
    // "The Prismic Rest API will always return thumbnail values if the base size is filled" (C§2.2).
    for (const t of (cfg.thumbnails ?? []) as Array<{ name: string; width?: number | null; height?: number | null }>) {
      if (isObj(v[t.name]) && (isStr(v[t.name].id) || isStr(v[t.name].url))) out[t.name] = this.assetUrl(pick(v[t.name], IMAGE_KEYS), true);
      else {
        const thumb: Record<string, unknown> = { ...main };
        if (typeof t.width === 'number' && typeof t.height === 'number') thumb.dimensions = { width: t.width, height: t.height };
        out[t.name] = thumb;
      }
    }
    return out;
  }

  /** Rewrites `o.url` (a fresh object owned by the renderer) to the asset's canonical URL (R12). */
  private assetUrl(o: Record<string, unknown>, keepQuery: boolean): Record<string, unknown> {
    if (!this.rctx.resolveAssetUrl || !isStr(o.id)) return o;
    const base = this.rctx.resolveAssetUrl(o.id);
    if (base === null) return o;
    const stored = isStr(o.url) ? o.url : '';
    const q = stored.indexOf('?');
    o.url = keepQuery && q >= 0 ? base + stored.slice(q) : base;
    return o;
  }

  // ---- links ----

  /** `field` undefined = link inside rich text (no `key`, any link type). */
  link(field: AnyField | undefined, v: unknown, path: string, withKey: boolean): Record<string, unknown> {
    const select = field?.config?.select as string | null | undefined;
    const src = isObj(v) ? v : {};
    const key = withKey && isStr(src.key) ? { key: src.key } : {};
    const extras = (out: Record<string, unknown>) => {
      if (isStr(src.text)) out.text = src.text;
      if (isStr(src.variant)) out.variant = src.variant;
      return out;
    };
    const lt = src.link_type;
    const filled =
      (lt === 'Document' && isStr(src.id) && (!select || select === 'document')) ||
      (lt === 'Media' && isStr(src.id) && (!select || select === 'media')) ||
      (lt === 'Web' && isStr(src.url) && (!select || select === 'web'));
    if (!filled) {
      const emptyType = select === 'document' ? 'Document' : select === 'media' ? 'Media' : 'Any';
      return extras({ link_type: emptyType, ...key });
    }
    if (lt === 'Document') {
      const stub = this.rctx.resolveLink(src.id, path, field as Field | undefined);
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(stub)) if (k !== 'link_type' && k !== 'isBroken' && k !== 'key') out[k] = x;
      out.link_type = 'Document';
      Object.assign(out, key);
      out.isBroken = stub.isBroken === true;
      return extras(out);
    }
    if (lt === 'Media') {
      const out: Record<string, unknown> = { link_type: 'Media', ...key };
      for (const k of MEDIA_KEYS) if (src[k] !== undefined) out[k] = src[k];
      this.assetUrl(out, false);
      return extras(out);
    }
    const out: Record<string, unknown> = { link_type: 'Web', ...key, url: src.url };
    if (isStr(src.target)) out.target = src.target;
    return extras(out);
  }

  // ---- table, slices ----

  private table(v: unknown, path: string) {
    if (!isObj(v) || !isObj(v.body) || !Array.isArray(v.body.rows)) return null;
    const section = (s: Record<string, any>) => ({
      rows: (Array.isArray(s.rows) ? s.rows : []).filter(isObj).map((r: Record<string, any>) => ({
        key: r.key,
        cells: (Array.isArray(r.cells) ? r.cells : []).filter(isObj).map((c: Record<string, any>) => ({
          key: c.key,
          type: c.type === 'header' ? 'header' : 'data',
          content: this.richText(c.content, path),
        })),
      })),
    });
    const out: Record<string, unknown> = {};
    if (isObj(v.head)) out.head = section(v.head);
    out.body = section(v.body);
    return out;
  }

  private slices(zone: AnyField, v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) return [];
    const out: unknown[] = [];
    for (const s of v) {
      if (!isObj(s) || !isStr(s.slice_type) || !isStr(s.id)) continue;
      const shape = sliceShape(zone, s.slice_type, this.shared);
      if (!shape) continue;
      const items = Array.isArray(s.items) ? s.items : [];
      if (shape.kind === 'shared') {
        const variation = variationOf(shape.model, s.variation);
        if (!variation) continue;
        const base = `${path}.${s.slice_type}.${s.variation}`;
        out.push({
          variation: s.variation,
          version: isStr(s.version) ? s.version : 'initial',
          items: items.map((it) => this.fields(variation.items, it, `${base}.items`)),
          primary: this.fields(variation.primary, s.primary, `${base}.primary`),
          id: s.id,
          slice_type: s.slice_type,
          slice_label: null,
        });
      } else {
        const base = `${path}.${s.slice_type}`;
        out.push({
          slice_type: s.slice_type,
          slice_label: isStr(s.slice_label) ? s.slice_label : null,
          id: s.id,
          primary: this.fields(shape.primary, s.primary, `${base}.primary`),
          items: items.map((it) => this.fields(shape.items, it, `${base}.items`)),
        });
      }
    }
    return out;
  }
}

function pick(src: Record<string, any>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/** Renders stored data as Content API `data` for the current model. */
export function renderDocumentData(
  model: CustomType,
  sharedSlices: Map<string, SharedSlice>,
  stored: StoredData,
  rctx: RenderCtx,
): Record<string, unknown> {
  const r = new Renderer(sharedSlices, rctx);
  const src = isObj(stored) ? stored : {};
  const out: Record<string, unknown> = {};
  for (const [k, f] of dataFields(model)) out[k] = r.field(f, src[k], k);
  return out;
}

/** Every Document link id in stored data (field links and rich-text links), for batch loading before render. */
export function collectDocumentLinkIds(stored: unknown): string[] {
  const ids = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isObj(v)) return;
    if (v.link_type === 'Document' && isStr(v.id)) ids.add(v.id);
    for (const x of Object.values(v)) walk(x);
  };
  walk(stored);
  return [...ids];
}
