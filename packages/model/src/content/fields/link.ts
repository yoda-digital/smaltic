import { newKey } from '../../ids.js';
import { findAsset, isObj, isStr, UUID_RE } from '../shared.js';
import type { NormEnv } from './env.js';

/** Id the official client writes for links that were broken in the source repository (C§5.2). */
export const BROKEN_LINK_ID = '_____broken_____';

export type KeyMode = 'filled' | 'always' | 'never';

export async function normalizeRepeatLink(env: NormEnv, cfg: Record<string, any>, v: unknown, path: string) {
  if (v === null || v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  const out: unknown[] = [];
  for (const [i, l] of list.entries()) if (l) out.push(await normalizeLink(env, cfg, l, `${path}.${i}`, 'always'));
  return out;
}

/**
 * Field links get a `key`: `filled` adds one only to filled links (empty single links stay `{link_type}`),
 * `always` adds one to every item of a repeatable link, `never` is for links inside rich text.
 */
export async function normalizeLink(env: NormEnv, cfg: Record<string, any>, v: unknown, path: string, keyMode: KeyMode): Promise<Record<string, unknown>> {
  const extras = (src: Record<string, any>, out: Record<string, unknown>) => {
    if (isStr(src.text)) out.text = src.text;
    if (isStr(src.variant)) out.variant = src.variant;
    return out;
  };
  const key = (src: Record<string, any>, filled: boolean) =>
    keyMode === 'always' || (keyMode === 'filled' && filled) ? { key: isStr(src.key) && UUID_RE.test(src.key) ? src.key : newKey() } : {};
  const empty = (src: Record<string, any>) => extras(src, { link_type: 'Any', ...key(src, false) });

  if (!isObj(v)) {
    if (v !== null && v !== undefined) env.err(path, v, 'The link must be an object');
    return keyMode === 'always' ? { link_type: 'Any', key: newKey() } : { link_type: 'Any' };
  }
  const lt = v.link_type ?? (isStr(v.url) ? 'Web' : 'Any');
  const select = cfg.select as string | null | undefined;
  const wrongSelect = (want: string) => {
    env.err(`${path}.link_type`, lt, `The link must be a ${want} link`);
    return empty(v);
  };
  switch (lt) {
    case 'Web': {
      if (!isStr(v.url) || v.url === '') return empty(v);
      if (select && select !== 'web') return wrongSelect(select === 'document' ? 'Document' : 'Media');
      const out: Record<string, unknown> = { link_type: 'Web', ...key(v, true), url: v.url };
      // Docs allow only "_blank", but live content carries `""` and `"_self"` too (ev/search.homepage.json,
      // ev/search.similar.json) and Content API documents must round-trip: any string is kept verbatim.
      if (v.target !== undefined && v.target !== null) {
        if (isStr(v.target)) out.target = v.target;
        else env.err(`${path}.target`, v.target, 'The target must be a string');
      }
      return extras(v, out);
    }
    case 'Document': {
      if (!isStr(v.id) || v.id === '') return empty(v);
      if (select && select !== 'document') return wrongSelect(select === 'web' ? 'Web' : 'Media');
      const out: Record<string, unknown> = { link_type: 'Document', id: v.id, ...key(v, true) };
      if (v.id === BROKEN_LINK_ID) out.isBroken = true;
      return extras(v, out);
    }
    case 'Media': {
      if (!isStr(v.id) || v.id === '') return empty(v);
      if (select && select !== 'media') return wrongSelect(select === 'web' ? 'Web' : 'Document');
      const asset = await findAsset(env.ctx, v.id);
      if (asset === false) {
        env.err(`${path}.id`, v.id, `The asset ${v.id} does not exist`);
        return empty(v);
      }
      const out: Record<string, unknown> = { link_type: 'Media', ...key(v, true) };
      if (asset === true) {
        for (const k of ['kind', 'id', 'url', 'name', 'size', 'height', 'width']) if (v[k] !== undefined) out[k] = v[k];
      } else {
        // Content API shape (C§2.3): kind is "image" or "file"; size/width/height are strings.
        Object.assign(out, { kind: asset.kind === 'image' ? 'image' : 'file', id: asset.id, url: asset.url, name: asset.filename, size: String(asset.size) });
        if (asset.kind === 'image' && typeof asset.width === 'number' && typeof asset.height === 'number') {
          Object.assign(out, { height: String(asset.height), width: String(asset.width) });
        }
      }
      return extras(v, out);
    }
    case 'Any':
      return empty(v);
    default:
      env.err(`${path}.link_type`, lt, 'The link_type must be one of: Document, Web, Media');
      return empty(v);
  }
}

