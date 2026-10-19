import type { CustomType, Field, SharedSlice } from '../schema/customType.js';
import { flattenFields } from '../validate.js';

/** Document `data` as persisted: Content API shapes with Document links reduced to `{link_type, id, key?, text?, variant?}`. */
export type StoredData = Record<string, unknown>;

/** Migration API error item (R1§8). `property` is a dotted path such as `data.slices.0.primary.title`. */
export type FieldError = { property: string; value: unknown; error: string };

/** oEmbed response (arbitrary provider keys). */
export type Oembed = Record<string, unknown>;

export interface NormalizeCtx {
  /** Resolves oEmbed for a URL; `null` (or a promise of `null`) keeps the input `{embed_url, ...}`. */
  resolveEmbed(url: string): Promise<Oembed | null> | null;
  assetExists(id: string): boolean;
}

/** A linked document as the Content API embeds it (C§2.3, R1§4.7). */
export interface LinkedDocStub {
  id: string;
  type: string;
  tags: string[];
  lang: string;
  slug?: string | null;
  first_publication_date?: string | null;
  last_publication_date?: string | null;
  uid?: string | null;
  url?: string | null;
  data?: Record<string, unknown>;
  link_type: 'Document';
  isBroken: false;
  [key: string]: unknown;
}

/** A link to a missing document (C§2.3). */
export interface BrokenStub {
  id: string;
  type: string;
  link_type: 'Document';
  isBroken: true;
  [key: string]: unknown;
}

export interface RenderCtx {
  /**
   * Resolves a Document link. `path` is the model path of the link: `field`, `group.field`,
   * `zone.<slice_type>.<variation>.primary.field`, `zone.<slice_type>.<variation>.items.field`
   * (composite slices: `zone.<slice_type>.primary|items.field`). Rich-text span links use the
   * rich-text field's path. `field` is the Link model, or undefined for links inside rich text.
   */
  resolveLink(id: string, path: string, field?: Field): LinkedDocStub | BrokenStub;
}

/** Loose field view used internally; the zod types are too deep to switch over ergonomically. */
export type AnyField = { type: string; config?: Record<string, any>; [k: string]: unknown };
export type Fields = Record<string, AnyField>;

export const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';

export const HEX_RE = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0000$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TEXT_BLOCKS = new Set([
  'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
  'paragraph', 'preformatted', 'list-item', 'o-list-item',
]);
export const BLOCK_TYPES = new Set([...TEXT_BLOCKS, 'image', 'embed']);
export const HEADINGS = new Set(['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6']);

/** Block types a rich-text config accepts, in config order; null = all (no `single`/`multi`). */
export function allowedBlocks(cfg: Record<string, any> | undefined): string[] | null {
  const opts = cfg?.single ?? cfg?.multi;
  if (!isStr(opts)) return null;
  return opts.split(',').map((t) => t.trim()).filter((t) => BLOCK_TYPES.has(t));
}

/** Top-level model fields that carry a value in `data` (UID lives at document level, Separator has no value). */
export function dataFields(ct: CustomType): Array<[string, AnyField]> {
  return [...flattenFields(ct)].filter(([, f]) => f.type !== 'UID' && f.type !== 'Separator') as Array<[string, AnyField]>;
}

export type SliceShape =
  | { kind: 'shared'; model: SharedSlice }
  | { kind: 'composite'; primary: Fields; items: Fields };

/** Resolves the model of a slice choice in a zone; shared-slice refs are looked up in `sharedSlices`. */
export function sliceShape(zone: AnyField, sliceType: string, sharedSlices: Map<string, SharedSlice>): SliceShape | null {
  const choices = zone.config?.choices as Record<string, AnyField> | undefined;
  const choice = choices && Object.prototype.hasOwnProperty.call(choices, sliceType) ? choices[sliceType] : undefined;
  if (!choice) return null;
  if (choice.type === 'SharedSlice') {
    const model = Array.isArray(choice.variations) ? (choice as unknown as SharedSlice) : sharedSlices.get(sliceType);
    return model ? { kind: 'shared', model } : null;
  }
  if (choice.type === 'Slice') {
    return { kind: 'composite', primary: (choice['non-repeat'] ?? {}) as Fields, items: (choice.repeat ?? {}) as Fields };
  }
  return null; // legacy nestable slices are not supported
}

export function variationOf(model: SharedSlice, id: unknown): { primary: Fields; items: Fields } | null {
  const v = model.variations.find((x) => x.id === id);
  return v ? { primary: (v.primary ?? {}) as Fields, items: (v.items ?? {}) as Fields } : null;
}

export const subFields = (f: AnyField): Fields => (f.config?.fields ?? {}) as Fields;
