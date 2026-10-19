import { findAsset, isObj, isStr, type AssetInfo } from '../shared.js';
import type { NormEnv } from './env.js';

const DEFAULT_EDIT = { x: 0, y: 0, zoom: 1, background: 'transparent' };

/** Image field or rich-text image block (`inBlock`): `{dimensions, alt, copyright, url, id, edit}` + configured thumbnails. */
export async function normalizeImage(env: NormEnv, cfg: Record<string, any>, v: unknown, path: string, inBlock: boolean): Promise<Record<string, unknown>> {
  if (!isObj(v) || (!inBlock && (!isStr(v.id) || v.id === '')) || (inBlock && !isStr(v.id) && !isStr(v.url))) {
    if (isObj(v) && Object.keys(v).length > 0 && !inBlock) env.err(`${path}.id`, v.id, 'The image must have an id');
    return {};
  }
  const main = await imageView(env, v, path, undefined);
  if (!main) return {};
  const out: Record<string, unknown> = main;
  for (const t of (cfg.thumbnails ?? []) as Array<{ name: string }>) {
    if (isObj(v[t.name])) {
      const view = await imageView(env, v[t.name], `${path}.${t.name}`, main);
      if (view) out[t.name] = view;
    }
  }
  return out;
}

const validDims = (d: unknown): d is { width: number; height: number } =>
  isObj(d) && typeof d.width === 'number' && typeof d.height === 'number';

/** The asset url (no query) with the query of `given`, if any: what the official client sends (C§5.2). */
function assetUrl(asset: AssetInfo, given: unknown): string {
  const query = isStr(given) ? given.split('?').slice(1).join('?') : '';
  return `${asset.url.split('?')[0]}${query ? `?${query}` : ''}`;
}

async function imageView(env: NormEnv, v: Record<string, any>, path: string, main: Record<string, unknown> | undefined) {
  const id = isStr(v.id) ? v.id : (main?.id as string | undefined);
  // htmlAsRichText emits image blocks with `id: ""` and an external url (C§5.2): no asset check then.
  let asset: AssetInfo | null = null;
  if (isStr(id) && id !== '') {
    const found = await findAsset(env.ctx, id);
    if (found === false) {
      env.err(`${path}.id`, id, `The asset ${id} does not exist`);
      return null;
    }
    if (found !== true) asset = found;
  }
  const out: Record<string, unknown> = {};
  const assetDims = asset && typeof asset.width === 'number' && typeof asset.height === 'number'
    ? { width: asset.width, height: asset.height } : undefined;
  const dims = validDims(v.dimensions) ? v.dimensions : (main?.dimensions ?? assetDims);
  if (validDims(dims)) out.dimensions = { width: dims.width, height: dims.height };
  out.alt = isStr(v.alt) ? v.alt : v.alt === undefined && main ? main.alt : null;
  out.copyright = isStr(v.copyright) ? v.copyright : v.copyright === undefined && main ? main.copyright : null;
  const url = asset ? assetUrl(asset, isStr(v.url) ? v.url : main?.url) : isStr(v.url) ? v.url : main?.url;
  if (isStr(url)) out.url = url;
  if (isStr(id)) out.id = id;
  out.edit = imageEdit(env, v.edit, `${path}.edit`);
  return out;
}

function imageEdit(env: NormEnv, v: unknown, path: string) {
  if (!isObj(v)) return { ...DEFAULT_EDIT };
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  if (v.background !== undefined && v.background !== null && !isStr(v.background)) env.err(`${path}.background`, v.background, 'The background must be a color');
  return {
    x: num(v.x, 0),
    y: num(v.y, 0),
    zoom: num(v.zoom, 1),
    background: isStr(v.background) ? v.background : 'transparent',
  };
}

