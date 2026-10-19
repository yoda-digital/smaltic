/**
 * Fulltext extraction. Weight A: headings, title fields (`single` rich text or `useAsTitle`), UID and key text.
 * Weight B: the rest of the rich text (incl. table cells) and select values. Image alt text is excluded.
 */
import type { CustomType, SharedSlice } from '../schema/customType.js';
import {
  dataFields, HEADINGS, isObj, isStr, sliceShape, subFields, TEXT_BLOCKS, variationOf,
  type AnyField, type Fields, type StoredData,
} from './shared.js';

export interface SearchTextOpts {
  sharedSlices?: Map<string, SharedSlice>;
  uid?: string | null;
}

export function extractSearchText(model: CustomType, stored: StoredData, opts: SearchTextOpts = {}): { weightA: string; weightB: string } {
  const a: string[] = [];
  const b: string[] = [];
  const shared = opts.sharedSlices ?? new Map<string, SharedSlice>();
  if (opts.uid) a.push(opts.uid);

  const rich = (v: unknown, isTitle: boolean) => {
    if (!Array.isArray(v)) return;
    for (const blk of v) {
      if (!isObj(blk) || !TEXT_BLOCKS.has(blk.type) || !isStr(blk.text) || blk.text === '') continue;
      (isTitle || HEADINGS.has(blk.type) ? a : b).push(blk.text);
    }
  };
  const fields = (fs: Fields, src: unknown) => {
    const o = isObj(src) ? src : {};
    for (const [k, f] of Object.entries(fs)) field(f, o[k]);
  };
  const field = (f: AnyField, v: unknown): void => {
    const cfg = f.config ?? {};
    switch (f.type) {
      case 'Text':
        if (isStr(v) && v !== '') a.push(v);
        return;
      case 'Select':
        if (isStr(v) && v !== '') b.push(v);
        return;
      case 'StructuredText':
        return rich(v, isStr(cfg.single) || cfg.useAsTitle === true);
      case 'Table':
        if (!isObj(v)) return;
        for (const sec of [v.head, v.body]) {
          if (!isObj(sec) || !Array.isArray(sec.rows)) continue;
          for (const r of sec.rows) for (const c of isObj(r) && Array.isArray(r.cells) ? r.cells : []) if (isObj(c)) rich(c.content, false);
        }
        return;
      case 'Group':
        if (Array.isArray(v)) for (const item of v) fields(subFields(f), item);
        return;
      case 'Slices':
      case 'Choice':
        if (!Array.isArray(v)) return;
        for (const s of v) {
          if (!isObj(s) || !isStr(s.slice_type)) continue;
          const shape = sliceShape(f, s.slice_type, shared);
          if (!shape) continue;
          const zones = shape.kind === 'shared' ? variationOf(shape.model, s.variation) : shape;
          if (!zones) continue;
          fields(zones.primary, s.primary);
          if (Array.isArray(s.items)) for (const it of s.items) fields(zones.items, it);
        }
        return;
      default:
        return; // images (alt excluded), links, embeds, numbers, dates...
    }
  };

  for (const [k, f] of dataFields(model)) field(f, isObj(stored) ? stored[k] : undefined);
  return { weightA: a.join('\n'), weightB: b.join('\n') };
}
