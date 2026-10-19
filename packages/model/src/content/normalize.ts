/**
 * Write side of the content pipeline: Migration API input (or a Content API document posted back)
 * -> stored data. Validation errors use the Migration API format `[{property, value, error}]` (R1§8).
 */
import { newKey, sliceId } from '../ids.js';
import type { NormEnv } from './fields/env.js';
import { normalizeImage } from './fields/image.js';
import { normalizeLink, normalizeRepeatLink } from './fields/link.js';

export { BROKEN_LINK_ID } from './fields/link.js';
import type { CustomType, SharedSlice } from '../schema/customType.js';
import {
  allowedBlocks, BLOCK_TYPES, DATE_RE, dataFields, HEX_RE, isObj, isStr, sliceShape, subFields, TEXT_BLOCKS, TS_RE,
  UUID_RE, variationOf,
  type AnyField, type FieldError, type Fields, type NormalizeCtx, type StoredData,
} from './shared.js';

const TABLE_CELL_BLOCKS = ['paragraph'];
const SPAN_TYPES = new Set(['strong', 'em', 'hyperlink', 'label']);

/** UID rules (R2§2.8): non-empty, lowercase, no whitespace, no ASCII punctuation except `-` and `_`. Unicode letters allowed. */
export function validateUid(uid: unknown): FieldError | null {
  const bad = (error: string): FieldError => ({ property: 'uid', value: uid, error });
  if (!isStr(uid) || uid.length === 0) return bad('The UID must be a non-empty string');
  if (/\s/u.test(uid)) return bad('The UID cannot contain spaces');
  if (uid !== uid.toLowerCase()) return bad('The UID must be lowercase');
  if (/[!-,./:-@[-^`{-~]/.test(uid)) return bad('The UID cannot contain special characters except "-" and "_"');
  return null;
}

class Normalizer implements NormEnv {
  readonly errors: FieldError[] = [];
  constructor(private shared: Map<string, SharedSlice>, readonly ctx: NormalizeCtx) {}

  err(property: string, value: unknown, error: string) {
    this.errors.push({ property, value, error });
  }

  async fields(fields: Fields, input: unknown, path: string): Promise<Record<string, unknown>> {
    const src = isObj(input) ? input : {};
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(fields)) {
      if (f.type === 'UID' || f.type === 'Separator') continue;
      out[k] = await this.field(f, src[k], `${path}.${k}`);
    }
    return out;
  }

  async field(f: AnyField, v: unknown, path: string): Promise<unknown> {
    const cfg = f.config ?? {};
    const empty = v === null || v === undefined;
    switch (f.type) {
      case 'Boolean':
        if (typeof v === 'boolean') return v;
        if (!empty) this.err(path, v, 'The value must be a boolean');
        return cfg.default_value ?? false;
      case 'Color':
        return this.pattern(v, path, HEX_RE, 'The value must be a hexadecimal color value');
      case 'Date':
        return this.pattern(v, path, DATE_RE, 'The value must be a date in the format YYYY-MM-DD', validDate);
      case 'Timestamp':
        return this.timestamp(v, path);
      case 'Number':
      case 'Range':
        return this.number(cfg, v, path);
      case 'Text':
        if (empty || v === '') return null;
        if (isStr(v)) return v;
        this.err(path, v, 'The value must be a string');
        return null;
      case 'Select':
        return this.select(cfg, v, path);
      case 'StructuredText':
        return this.richText(cfg, v, path);
      case 'Image':
        return normalizeImage(this, cfg, v, path, false);
      case 'Link':
        if (cfg.repeat) return normalizeRepeatLink(this, cfg, v, path);
        return normalizeLink(this, cfg, v, path, 'filled');
      case 'Embed':
        return this.embed(v, path);
      case 'GeoPoint':
        return this.geo(v, path);
      case 'IntegrationFields':
        // Catalog blob (round-tripped Content API value) or a catalog item id (Migration API).
        if (empty) return null;
        if (isObj(v) || isStr(v) || typeof v === 'number') return v;
        this.err(path, v, 'The value must be a catalog item id');
        return null;
      case 'Table':
        return this.table(v, path);
      case 'Group':
        return this.group(f, v, path);
      case 'Slices':
      case 'Choice':
        return this.slices(f, v, path);
      default:
        return null;
    }
  }

  private pattern(v: unknown, path: string, re: RegExp, msg: string, extra: (s: string) => boolean = () => true) {
    if (v === null || v === undefined || v === '') return null;
    if (isStr(v) && re.test(v) && extra(v)) return v;
    this.err(path, v, msg);
    return null;
  }

  private timestamp(v: unknown, path: string) {
    if (v === null || v === undefined || v === '') return null;
    if (isStr(v) && TS_RE.test(v) && validDate(v.slice(0, 10))) return v;
    // Accept other ISO 8601 forms with an explicit zone and convert them to the API format.
    if (isStr(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))) {
      return new Date(v).toISOString().slice(0, 19) + '+0000';
    }
    this.err(path, v, 'The value must be a timestamp in the format YYYY-MM-DDTHH:MM:SS+0000');
    return null;
  }

  private number(cfg: Record<string, any>, v: unknown, path: string) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.err(path, v, 'The value must be a number');
      return null;
    }
    if (typeof cfg.min === 'number' && v < cfg.min) this.err(path, v, `The value must be greater than or equal to ${cfg.min}`);
    else if (typeof cfg.max === 'number' && v > cfg.max) this.err(path, v, `The value must be lower than or equal to ${cfg.max}`);
    return v;
  }

  private select(cfg: Record<string, any>, v: unknown, path: string) {
    if (v === null || v === undefined || v === '') return cfg.default_value ?? null;
    const s = typeof v === 'number' || typeof v === 'boolean' ? String(v) : v;
    const options = cfg.options as string[] | undefined;
    if (isStr(s) && (!options || options.includes(s))) return s;
    this.err(path, v, options ? `The value must be one of the options: ${options.join(', ')}` : 'The value must be a string');
    return cfg.default_value ?? null;
  }

  // ---- rich text ----

  async richText(cfg: Record<string, any>, v: unknown, path: string, allowed = allowedBlocks(cfg)): Promise<unknown[]> {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) {
      this.err(path, v, 'The value must be an array of blocks');
      return [];
    }
    if (isStr(cfg.single) && v.length > 1) this.err(path, v, 'The field accepts a single block');
    const out: unknown[] = [];
    for (const [i, b] of v.entries()) {
      const p = `${path}.${i}`;
      if (!isObj(b) || !isStr(b.type) || !BLOCK_TYPES.has(b.type)) {
        this.err(isObj(b) ? `${p}.type` : p, isObj(b) ? b.type : b, `Invalid block type. Supported block types are: ${(allowed ?? [...BLOCK_TYPES]).join(', ')}`);
        continue;
      }
      if (allowed && !allowed.includes(b.type)) {
        this.err(`${p}.type`, b.type, `Invalid block type. Supported block types are: ${allowed.join(', ')}`);
        continue;
      }
      const block = await this.block(b, p);
      if (block) out.push(block);
    }
    return out;
  }

  private async block(b: Record<string, any>, p: string): Promise<Record<string, unknown> | null> {
    if (TEXT_BLOCKS.has(b.type)) {
      if (!isStr(b.text)) {
        this.err(`${p}.text`, b.text, 'The text must be a string');
        return null;
      }
      const out: Record<string, unknown> = { type: b.type, text: b.text, spans: this.spans(b.spans, `${p}.spans`) };
      if (isStr(b.direction)) out.direction = b.direction;
      return out;
    }
    if (b.type === 'image') {
      const img = normalizeImage(this, {}, b, p, true);
      if (!isStr(img.id) && !isStr(img.url)) {
        this.err(p, b, 'The image block must reference an image');
        return null;
      }
      const { dimensions, alt, copyright, url, id, edit } = img;
      const out: Record<string, unknown> = { type: 'image', url, alt, copyright, dimensions, id, edit };
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
      if (isObj(b.linkTo)) {
        const l = normalizeLink(this, {}, b.linkTo, `${p}.linkTo`, 'never');
        if (l.link_type !== 'Any') out.linkTo = l;
      }
      return out;
    }
    // embed
    const oembed = await this.embed(b.oembed, `${p}.oembed`);
    if (!isStr(oembed.embed_url)) {
      this.err(`${p}.oembed.embed_url`, b.oembed, 'The embed block must have an embed_url');
      return null;
    }
    return { type: 'embed', oembed };
  }

  private spans(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) return [];
    const out: unknown[] = [];
    for (const [i, s] of v.entries()) {
      const p = `${path}.${i}`;
      if (!isObj(s) || !SPAN_TYPES.has(s.type)) {
        this.err(`${p}.type`, isObj(s) ? s.type : s, 'Invalid span type. Supported span types are: strong, em, hyperlink, label');
        continue;
      }
      // Offsets are not checked against text.length: whether they count UTF-16 units or code points is unconfirmed (R2 Q).
      if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end < s.start) {
        this.err(p, s, 'The span start and end must be offsets within the text');
        continue;
      }
      const span: Record<string, unknown> = { start: s.start, end: s.end, type: s.type };
      if (s.type === 'hyperlink') {
        const data = normalizeLink(this, {}, s.data, `${p}.data`, 'never');
        if (data.link_type === 'Any') continue; // a hyperlink to nothing is dropped
        span.data = data;
      } else if (s.type === 'label') {
        if (!isObj(s.data) || !isStr(s.data.label)) {
          this.err(`${p}.data.label`, s.data, 'The label must be a string');
          continue;
        }
        span.data = { label: s.data.label };
      }
      out.push(span);
    }
    return out;
  }

  // ---- embed, geopoint, table ----

  private async embed(v: unknown, path: string): Promise<Record<string, unknown>> {
    if (!isObj(v) || v.embed_url === undefined || v.embed_url === null || v.embed_url === '') return {};
    if (!isStr(v.embed_url)) {
      this.err(`${path}.embed_url`, v.embed_url, 'The embed_url must be a string');
      return {};
    }
    const resolved = await this.ctx.resolveEmbed(v.embed_url);
    const { embed_url: _, ...rest } = resolved ?? v;
    return { embed_url: v.embed_url, ...rest };
  }

  private geo(v: unknown, path: string) {
    if (!isObj(v) || (v.latitude === undefined && v.longitude === undefined)) return {};
    const coord = (x: unknown, name: string, lim: number) => {
      const n = typeof x === 'number' ? x : isStr(x) && x.trim() !== '' ? Number(x) : NaN;
      if (!Number.isFinite(n) || n < -lim || n > lim) {
        this.err(`${path}.${name}`, x, `The ${name} must be a number between -${lim} and ${lim}`);
        return null;
      }
      return n;
    };
    const latitude = coord(v.latitude, 'latitude', 90);
    const longitude = coord(v.longitude, 'longitude', 180);
    return latitude === null || longitude === null ? {} : { latitude, longitude };
  }

  private async table(v: unknown, path: string) {
    if (v === null || v === undefined) return null;
    if (!isObj(v) || !isObj(v.body) || !Array.isArray(v.body.rows)) {
      this.err(path, v, 'The table must have a body with rows');
      return null;
    }
    const section = async (s: Record<string, any>, p: string, defaultType: 'header' | 'data') => {
      const rows: unknown[] = [];
      for (const [ri, r] of (Array.isArray(s.rows) ? s.rows : []).entries()) {
        const cells: unknown[] = [];
        for (const [ci, c] of (isObj(r) && Array.isArray(r.cells) ? r.cells : []).entries()) {
          const cp = `${p}.rows.${ri}.cells.${ci}`;
          const type = isObj(c) && (c.type === 'header' || c.type === 'data') ? c.type : defaultType;
          const content = await this.richText({}, isObj(c) ? c.content : null, `${cp}.content`, TABLE_CELL_BLOCKS);
          cells.push({ key: isObj(c) && isStr(c.key) && UUID_RE.test(c.key) ? c.key : newKey(), type, content });
        }
        rows.push({ key: isObj(r) && isStr(r.key) && UUID_RE.test(r.key) ? r.key : newKey(), cells });
      }
      return { rows };
    };
    const out: Record<string, unknown> = {};
    if (isObj(v.head)) out.head = await section(v.head, `${path}.head`, 'header');
    out.body = await section(v.body, `${path}.body`, 'data');
    return out;
  }

  // ---- group, slices ----

  private async group(f: AnyField, v: unknown, path: string) {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) {
      this.err(path, v, 'The value must be an array');
      return [];
    }
    const out: unknown[] = [];
    for (const [i, item] of v.entries()) {
      if (!isObj(item)) {
        this.err(`${path}.${i}`, item, 'The group item must be an object');
        continue;
      }
      out.push(await this.fields(subFields(f), item, `${path}.${i}`));
    }
    return out;
  }

  private async slices(zone: AnyField, v: unknown, path: string) {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) {
      this.err(path, v, 'The value must be an array of slices');
      return [];
    }
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const [i, s] of v.entries()) {
      const p = `${path}.${i}`;
      if (!isObj(s)) {
        this.err(p, s, 'The slice must be an object');
        continue;
      }
      if (!isStr(s.slice_type) || s.slice_type === '') {
        this.err(`${p}.slice_type`, s.slice_type, 'The slice_type is required');
        continue;
      }
      const shape = sliceShape(zone, s.slice_type, this.shared);
      if (!shape) {
        this.err(`${p}.slice_type`, s.slice_type, `Unknown slice type "${s.slice_type}"`);
        continue;
      }
      const id = this.sliceIdOf(s, p, seen);
      if (id === null) continue;
      const items = Array.isArray(s.items) ? s.items : [];
      if (shape.kind === 'shared') {
        const variation = variationOf(shape.model, s.variation);
        if (!variation) {
          this.err(`${p}.variation`, s.variation, isStr(s.variation) ? `Unknown variation "${s.variation}" for slice "${s.slice_type}"` : 'The variation is required');
          continue;
        }
        out.push({
          variation: s.variation,
          version: isStr(s.version) && s.version !== '' ? s.version : 'initial',
          items: await this.items(variation.items, items, `${p}.items`),
          primary: await this.fields(variation.primary, s.primary, `${p}.primary`),
          id,
          slice_type: s.slice_type,
          slice_label: null,
        });
      } else {
        out.push({
          slice_type: s.slice_type,
          slice_label: isStr(s.slice_label) ? s.slice_label : null,
          id,
          primary: await this.fields(shape.primary, s.primary, `${p}.primary`),
          items: await this.items(shape.items, items, `${p}.items`),
        });
      }
    }
    return out;
  }

  private sliceIdOf(s: Record<string, any>, p: string, seen: Set<string>): string | null {
    let id: string;
    if (s.id === undefined || s.id === null) id = sliceId(s.slice_type);
    else {
      const [prefix, uuid, ...rest] = isStr(s.id) ? s.id.split('$') : [];
      if (prefix !== s.slice_type || !uuid || rest.length || !UUID_RE.test(uuid)) {
        this.err(`${p}.id`, s.id, `The slice id must be "${s.slice_type}$" followed by a uuid v4`);
        return null;
      }
      id = s.id;
    }
    if (seen.has(id)) {
      this.err(`${p}.id`, id, 'The slice id must be unique within the document');
      return null;
    }
    seen.add(id);
    return id;
  }

  private async items(fields: Fields, items: unknown[], path: string) {
    const out: unknown[] = [];
    for (const [i, it] of items.entries()) out.push(await this.fields(fields, it, `${path}.${i}`));
    return out;
  }
}

function validDate(s: string): boolean {
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s.slice(0, 10);
}

/**
 * Normalizes document `data` against its model. Unknown keys are ignored (as the Migration API does);
 * every model field is stored with its canonical value, defaults applied. Async because embeds may
 * resolve oEmbed over the network.
 */
export async function normalizeDocumentData(
  model: CustomType,
  sharedSlices: Map<string, SharedSlice>,
  input: Record<string, unknown>,
  ctx: NormalizeCtx,
): Promise<{ data: StoredData; errors: FieldError[] }> {
  const n = new Normalizer(sharedSlices, ctx);
  const src = isObj(input) ? input : {};
  const data: StoredData = {};
  for (const [k, f] of dataFields(model)) data[k] = await n.field(f, src[k], `data.${k}`);
  return { data, errors: n.errors };
}
