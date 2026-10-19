/**
 * Golden wire-compatibility test: render(normalize(liveData)) must reproduce live Content API data.
 *
 * The model is not available, so it is inferred from the value shapes of the live document itself.
 * The live document is sanitized (prose replaced by same-length placeholders); all structure is intact.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  normalizeDocumentData,
  renderDocumentData,
  validateCustomType,
  validateSharedSlice,
  type CustomType,
  type LinkedDocStub,
  type RenderCtx,
  type SharedSlice,
} from '../src/index.js';

const evidence = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../docs/research/evidence/${name}`, import.meta.url)), 'utf8'));

// ---------------------------------------------------------------- model inference

type Json = unknown;
type FieldModel = { type: string; config?: Record<string, unknown> };
/** Inferred field: `unknown` when every observed value was null or an empty array. */
type Inferred =
  | { kind: 'unknown'; emptyArray: boolean }
  | { kind: 'scalar'; type: 'Text' | 'Boolean' | 'Number' }
  | { kind: 'rich' }
  | { kind: 'image'; thumbs: Set<string> }
  | { kind: 'link'; repeat: boolean; select: 'document' | 'media' | null }
  | { kind: 'embed' }
  | { kind: 'geo' }
  | { kind: 'table' }
  | { kind: 'integration' }
  | { kind: 'group'; fields: Map<string, Inferred> };

const isObj = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const IMAGE_KEYS = new Set(['dimensions', 'alt', 'copyright', 'url', 'id', 'edit']);
const isRichBlock = (v: Json) =>
  isObj(v) && typeof v.type === 'string' && (Array.isArray(v.spans) || v.type === 'image' || v.type === 'embed');

function inferOne(v: Json): Inferred {
  if (v === null) return { kind: 'unknown', emptyArray: false };
  if (typeof v === 'string') return { kind: 'scalar', type: 'Text' };
  if (typeof v === 'boolean') return { kind: 'scalar', type: 'Boolean' };
  if (typeof v === 'number') return { kind: 'scalar', type: 'Number' };
  if (Array.isArray(v)) {
    if (v.length === 0) return { kind: 'unknown', emptyArray: true };
    if (v.every(isRichBlock)) return { kind: 'rich' };
    if (v.every((x) => isObj(x) && typeof x.link_type === 'string')) {
      const merged = v.map(inferOne).reduce(merge) as Extract<Inferred, { kind: 'link' }>;
      return { ...merged, repeat: true };
    }
    const fields = new Map<string, Inferred>();
    for (const item of v) for (const [k, x] of Object.entries(item as Record<string, Json>)) fields.set(k, fields.has(k) ? merge(fields.get(k)!, inferOne(x)) : inferOne(x));
    return { kind: 'group', fields };
  }
  if (!isObj(v)) throw new Error(`cannot infer ${JSON.stringify(v)}`);
  if (typeof v.link_type === 'string') {
    const filled = 'id' in v || 'url' in v;
    const select = filled ? null : v.link_type === 'Document' ? 'document' : v.link_type === 'Media' ? 'media' : null;
    return { kind: 'link', repeat: false, select };
  }
  if ('embed_url' in v) return { kind: 'embed' };
  if ('latitude' in v) return { kind: 'geo' };
  if ('body' in v && isObj(v.body) && Array.isArray(v.body.rows)) return { kind: 'table' };
  if (Object.keys(v).length === 0 || 'dimensions' in v || 'url' in v) {
    return { kind: 'image', thumbs: new Set(Object.keys(v).filter((k) => !IMAGE_KEYS.has(k))) };
  }
  return { kind: 'integration' };
}

function merge(a: Inferred, b: Inferred): Inferred {
  if (a.kind === 'unknown') return b.kind === 'unknown' ? { kind: 'unknown', emptyArray: a.emptyArray || b.emptyArray } : b;
  if (b.kind === 'unknown') return a;
  if (a.kind !== b.kind) throw new Error(`conflicting shapes ${a.kind} / ${b.kind}`);
  if (a.kind === 'scalar' && b.kind === 'scalar' && a.type !== b.type) throw new Error(`conflicting scalars ${a.type}/${b.type}`);
  if (a.kind === 'image' && b.kind === 'image') return { kind: 'image', thumbs: new Set([...a.thumbs, ...b.thumbs]) };
  if (a.kind === 'link' && b.kind === 'link') return { kind: 'link', repeat: a.repeat || b.repeat, select: a.select ?? b.select };
  if (a.kind === 'group' && b.kind === 'group') {
    const fields = new Map(a.fields);
    for (const [k, x] of b.fields) fields.set(k, fields.has(k) ? merge(fields.get(k)!, x) : x);
    return { kind: 'group', fields };
  }
  return a;
}

function toModel(i: Inferred, depth = 0): FieldModel {
  switch (i.kind) {
    case 'unknown':
      return i.emptyArray ? { type: 'StructuredText' } : { type: 'Text' };
    case 'scalar':
      return { type: i.type };
    case 'rich':
      return { type: 'StructuredText' };
    case 'image':
      return { type: 'Image', config: { thumbnails: [...i.thumbs].map((name) => ({ name })) } };
    case 'link':
      return { type: 'Link', config: { ...(i.select ? { select: i.select } : {}), ...(i.repeat ? { repeat: true } : {}) } };
    case 'embed':
      return { type: 'Embed' };
    case 'geo':
      return { type: 'GeoPoint' };
    case 'table':
      return { type: 'Table' };
    case 'integration':
      return { type: 'IntegrationFields' };
    case 'group':
      if (depth > 1) throw new Error('group nested too deep');
      return { type: 'Group', config: { fields: fieldsModel(i.fields, depth + 1) } };
  }
}

const fieldsModel = (m: Map<string, Inferred>, depth = 0) =>
  Object.fromEntries([...m].map(([k, i]) => [k, toModel(i, depth)]));

function inferFields(objs: Array<Record<string, Json>>): Map<string, Inferred> {
  const out = new Map<string, Inferred>();
  for (const o of objs) for (const [k, v] of Object.entries(o)) out.set(k, out.has(k) ? merge(out.get(k)!, inferOne(v)) : inferOne(v));
  return out;
}

const isSliceZone = (v: Json) => Array.isArray(v) && v.length > 0 && v.every((s) => isObj(s) && typeof s.slice_type === 'string');

/** Infers a custom type plus shared slice models from one live document's `data`. */
export function inferModel(type: string, data: Record<string, Json>): { model: CustomType; slices: Map<string, SharedSlice> } {
  const slices = new Map<string, Array<Record<string, Json>>>();
  const json: Record<string, unknown> = {};
  const plain: Record<string, Json> = {};
  for (const [k, v] of Object.entries(data)) {
    if (isSliceZone(v)) {
      const choices: Record<string, unknown> = {};
      for (const s of v as Array<Record<string, Json>>) {
        choices[s.slice_type as string] = { type: 'SharedSlice' };
        slices.set(s.slice_type as string, [...(slices.get(s.slice_type as string) ?? []), s]);
      }
      json[k] = { type: 'Slices', config: { choices } };
    } else plain[k] = v;
  }
  Object.assign(json, fieldsModel(inferFields([plain])));
  const ctr = validateCustomType({ id: type, label: type, repeatable: true, json: { Main: json } });
  if (!ctr.ok) throw new Error(ctr.errors.join('\n'));

  const shared = new Map<string, SharedSlice>();
  for (const [sliceType, instances] of slices) {
    const byVariation = new Map<string, Array<Record<string, Json>>>();
    for (const s of instances) byVariation.set(s.variation as string, [...(byVariation.get(s.variation as string) ?? []), s]);
    const variations = [...byVariation].map(([id, ss]) => ({
      id,
      name: id,
      primary: fieldsModel(inferFields(ss.map((s) => s.primary as Record<string, Json>))),
      items: fieldsModel(inferFields(ss.flatMap((s) => s.items as Array<Record<string, Json>>))),
    }));
    const r = validateSharedSlice({ id: sliceType, type: 'SharedSlice', name: sliceType, variations });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    shared.set(sliceType, r.value);
  }
  return { model: ctr.value, slices: shared };
}

// ---------------------------------------------------------------- live link stubs and comparison

const FIELD_ONLY_LINK_KEYS = new Set(['key', 'text', 'variant']);

/** Collects the live linked-document stub per id (field-level extras removed). */
function liveStubs(data: Json): Map<string, LinkedDocStub> {
  const out = new Map<string, LinkedDocStub>();
  const walk = (v: Json): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isObj(v)) return;
    if (v.link_type === 'Document' && typeof v.id === 'string') {
      const stub = Object.fromEntries(Object.entries(v).filter(([k]) => !FIELD_ONLY_LINK_KEYS.has(k))) as LinkedDocStub;
      const prev = out.get(v.id);
      if (prev && JSON.stringify(prev) !== JSON.stringify(stub)) {
        // Same document seen with different projections (e.g. fetchLinks data on one link only): keep the richer one.
        if (JSON.stringify(stub).length > JSON.stringify(prev).length) out.set(v.id, stub);
      } else out.set(v.id, stub);
    }
    Object.values(v).forEach(walk);
  };
  walk(data);
  return out;
}

/** Replaces `key` values and slice id uuids so generated ids compare equal. */
function canonical(v: Json): Json {
  if (Array.isArray(v)) return v.map(canonical);
  if (!isObj(v)) return v;
  const out: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'key' && typeof x === 'string') out[k] = '<key>';
    else if (k === 'id' && typeof x === 'string' && typeof v.slice_type === 'string') out[k] = `${x.split('$')[0]}$<uuid>`;
    else out[k] = canonical(x);
  }
  return out;
}

async function roundTrip(doc: { type: string; data: Record<string, Json> }) {
  const { model, slices } = inferModel(doc.type, doc.data);
  const stubs = liveStubs(doc.data);
  const { data, errors } = await normalizeDocumentData(model, slices, structuredClone(doc.data), {
    resolveEmbed: () => null,
    assetExists: () => true,
  });
  const rctx: RenderCtx = {
    resolveLink: (id) => {
      const s = stubs.get(id);
      if (!s) throw new Error(`no live stub for ${id}`);
      return s;
    },
  };
  const rendered = JSON.parse(JSON.stringify(renderDocumentData(model, slices, data, rctx)));
  return { errors, rendered };
}

// ---------------------------------------------------------------- tests

describe('golden: live homepage', () => {
  const live = evidence('search.homepage.json').results[0];

  it('infers a model that covers both slice zones', () => {
    const { model, slices } = inferModel(live.type, live.data);
    expect(model.json.Main.primary_slices.type).toBe('Slices');
    expect(model.json.Main.secondary_slices.type).toBe('Slices');
    expect(slices.size).toBeGreaterThan(5);
  });

  it('render(normalize(liveData)) deep-equals the live data', async () => {
    const { errors, rendered } = await roundTrip(live);
    expect(errors).toEqual([]);
    expect(canonical(rendered)).toStrictEqual(canonical(live.data));
  });
});

describe('golden: every other live search capture', () => {
  const files = ['search.blog.page1.json', 'search.fetchlinks.json', 'search.fulltext.json', 'search.lang-all.json',
    'search.number-date.json', 'search.routes.json', 'search.similar.json', 'search.after.json', 'search.pagesize-101.json'];
  const docs = files.flatMap((f) => (evidence(f).results as Array<{ id: string; type: string; data: Record<string, Json> }>).map((d) => ({ f, d })));

  it.each(docs.map(({ f, d }) => [`${f} ${d.type} ${d.id}`, d] as const))('%s', async (_name, doc) => {
    const { errors, rendered } = await roundTrip(doc);
    expect(errors).toEqual([]);
    expect(canonical(rendered)).toStrictEqual(canonical(doc.data));
  });
});
