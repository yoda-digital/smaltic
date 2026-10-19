import { isObj, isStr } from '../shared.js';
import type { NormEnv } from './env.js';

const DEFAULT_EDIT = { x: 0, y: 0, zoom: 1, background: 'transparent' };

/** Image field or rich-text image block (`inBlock`): `{dimensions, alt, copyright, url, id, edit}` + configured thumbnails. */
export function normalizeImage(env: NormEnv, cfg: Record<string, any>, v: unknown, path: string, inBlock: boolean): Record<string, unknown> {
  if (!isObj(v) || (!inBlock && (!isStr(v.id) || v.id === '')) || (inBlock && !isStr(v.id) && !isStr(v.url))) {
    if (isObj(v) && Object.keys(v).length > 0 && !inBlock) env.err(`${path}.id`, v.id, 'The image must have an id');
    return {};
  }
  const main = imageView(env, v, path, undefined);
  if (!main) return {};
  const out: Record<string, unknown> = main;
  for (const t of (cfg.thumbnails ?? []) as Array<{ name: string }>) {
    if (isObj(v[t.name])) {
      const view = imageView(env, v[t.name], `${path}.${t.name}`, main);
      if (view) out[t.name] = view;
    }
  }
  return out;
}

function imageView(env: NormEnv, v: Record<string, any>, path: string, main: Record<string, unknown> | undefined) {
  const id = isStr(v.id) ? v.id : (main?.id as string | undefined);
  // htmlAsRichText emits image blocks with `id: ""` and an external url (C§5.2): no asset check then.
  if (isStr(id) && id !== '' && !env.ctx.assetExists(id)) {
    env.err(`${path}.id`, id, `The asset ${id} does not exist`);
    return null;
  }
  const out: Record<string, unknown> = {};
  const dims = isObj(v.dimensions) ? v.dimensions : main?.dimensions;
  if (isObj(dims) && typeof dims.width === 'number' && typeof dims.height === 'number') out.dimensions = { width: dims.width, height: dims.height };
  out.alt = isStr(v.alt) ? v.alt : v.alt === undefined && main ? main.alt : null;
  out.copyright = isStr(v.copyright) ? v.copyright : v.copyright === undefined && main ? main.copyright : null;
  const url = isStr(v.url) ? v.url : main?.url;
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

