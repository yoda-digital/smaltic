import {
  validateCustomType,
  validateSharedSlice,
  type CustomType,
  type NormalizeCtx,
  type RenderCtx,
  type SharedSlice,
} from '../src/index.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function ct(json: Record<string, Record<string, unknown>>, id = 'page'): CustomType {
  const r = validateCustomType({ id, label: id, repeatable: true, status: true, json });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
}

export function slice(input: unknown): SharedSlice {
  const r = validateSharedSlice(input);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
}

export const heroSlice = slice({
  id: 'hero',
  type: 'SharedSlice',
  name: 'Hero',
  variations: [
    {
      id: 'default',
      name: 'Default',
      primary: {
        title: { type: 'StructuredText', config: { single: 'heading1' } },
        cta: { type: 'Link', config: { repeat: true } },
        cards: { type: 'Group', config: { fields: { label: { type: 'Text' }, link: { type: 'Link' } } } },
      },
      items: { caption: { type: 'Text' } },
    },
    { id: 'compact', name: 'Compact', primary: { size: { type: 'Number' } } },
  ],
});

/** A model with every field type, used by normalize and render tests. */
export const allFields = ct({
  Main: {
    uid: { type: 'UID' },
    flag: { type: 'Boolean' },
    flag_on: { type: 'Boolean', config: { default_value: true } },
    color: { type: 'Color' },
    date: { type: 'Date' },
    ts: { type: 'Timestamp' },
    num: { type: 'Number', config: { min: 0, max: 10 } },
    text: { type: 'Text' },
    size: { type: 'Select', config: { options: ['S', 'M', 'L'] } },
    size_def: { type: 'Select', config: { options: ['S', 'M', 'L'], default_value: 'M' } },
    title: { type: 'StructuredText', config: { single: 'heading1,heading2' } },
    body: { type: 'StructuredText', config: { multi: 'paragraph,strong,hyperlink,image,embed' } },
    image: { type: 'Image', config: { thumbnails: [{ name: 'mobile', width: 400, height: 300 }] } },
    link: { type: 'Link' },
    links: { type: 'Link', config: { repeat: true } },
    media: { type: 'Link', config: { select: 'media' } },
    rel: { type: 'Link', config: { select: 'document' } },
    embed: { type: 'Embed' },
    geo: { type: 'GeoPoint' },
    integ: { type: 'IntegrationFields', config: { catalog: 'repo--shop' } },
    table: { type: 'Table' },
    group: { type: 'Group', config: { fields: { label: { type: 'Text' }, on: { type: 'Boolean' } } } },
    sep: { type: 'Separator' },
    slices: { type: 'Slices', config: { choices: { hero: { type: 'SharedSlice' } } } },
  },
});

export const shared = new Map<string, SharedSlice>([['hero', heroSlice]]);

export const nctx = (assets: string[] = ['ASSET0000000001']): NormalizeCtx => ({
  resolveEmbed: () => null,
  assetExists: (id) => assets.includes(id),
});

export function stubDoc(id: string) {
  return {
    id,
    type: 'page',
    tags: [],
    lang: 'en-us',
    slug: 'a-page',
    first_publication_date: '2024-01-01T00:00:00+0000',
    last_publication_date: '2024-01-02T00:00:00+0000',
    uid: 'a-page',
    link_type: 'Document' as const,
    isBroken: false as const,
  };
}

export const rctx = (calls: Array<[string, string]> = []): RenderCtx => ({
  resolveLink: (id, path) => {
    calls.push([id, path]);
    return stubDoc(id);
  },
});
