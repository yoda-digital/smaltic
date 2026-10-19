import { describe, expect, it } from 'vitest';
import { normalizeDocumentData, validateUid } from '../src/index.js';
import { allFields, ct, nctx, shared, UUID_RE } from './contentFixtures.js';

const run = (input: Record<string, unknown>, ctx = nctx()) => normalizeDocumentData(allFields, shared, input, ctx);

describe('normalizeDocumentData', () => {
  it('fills slice ids, keys and defaults', async () => {
    const { data, errors } = await run({
      flag: null,
      size_def: null,
      link: { link_type: 'Document', id: 'XxnD3REAACYAk_CJ', type: 'page', slug: 'x', tags: [], lang: 'en-us', text: 'Go' },
      links: [{ link_type: 'Web', url: 'https://a.test' }, null, { link_type: 'Any' }],
      rel: { link_type: 'Document', id: '_____broken_____', isBroken: true },
      table: {
        head: { rows: [{ cells: [{ type: 'header', content: [{ type: 'paragraph', text: 'H', spans: [] }] }] }] },
        body: { rows: [{ cells: [{ type: 'data', content: [{ type: 'paragraph', text: 'D', spans: [], direction: 'ltr' }] }] }] },
      },
      slices: [
        {
          slice_type: 'hero',
          variation: 'default',
          primary: { title: [{ type: 'heading1', text: 'Hi', spans: [] }], cards: [{ label: 'a', link: { link_type: 'Web', url: '/x' } }] },
          items: [{ caption: 'c' }],
        },
      ],
    });
    expect(errors).toEqual([]);

    // defaults
    expect(data.flag).toBe(false);
    expect(data.flag_on).toBe(true);
    expect(data.size_def).toBe('M');
    expect(data.size).toBeNull();

    // Document link reduced to id (+ stored key and editor props)
    const link = data.link as Record<string, unknown>;
    expect(link).toEqual({ link_type: 'Document', id: 'XxnD3REAACYAk_CJ', key: expect.stringMatching(UUID_RE), text: 'Go' });

    // repeatable links: falsy entries dropped, every item keyed, including the empty one
    const links = data.links as Array<Record<string, unknown>>;
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ link_type: 'Web', key: expect.stringMatching(UUID_RE), url: 'https://a.test' });
    expect(links[1]).toEqual({ link_type: 'Any', key: expect.stringMatching(UUID_RE) });

    // broken placeholder kept as a broken link
    expect(data.rel).toMatchObject({ link_type: 'Document', id: '_____broken_____', isBroken: true });

    // table rows and cells keyed; direction kept only where present
    const table = data.table as { head: { rows: any[] }; body: { rows: any[] } };
    expect(table.head.rows[0].key).toMatch(UUID_RE);
    expect(table.head.rows[0].cells[0].key).toMatch(UUID_RE);
    expect(table.head.rows[0].cells[0].content[0]).toEqual({ type: 'paragraph', text: 'H', spans: [] });
    expect(table.body.rows[0].cells[0]).toMatchObject({ type: 'data', content: [{ direction: 'ltr' }] });

    // slices
    const [s] = data.slices as Array<Record<string, any>>;
    expect(s.id).toMatch(/^hero\$[0-9a-f-]{36}$/);
    expect(UUID_RE.test(s.id.split('$')[1])).toBe(true);
    expect(s.version).toBe('initial');
    expect(s.slice_label).toBeNull();
    expect(s.variation).toBe('default');
    expect(s.items).toEqual([{ caption: 'c' }]);
    expect(s.primary.cards[0].link).toEqual({ link_type: 'Web', key: expect.stringMatching(UUID_RE), url: '/x' });
    expect(s.primary.cta).toEqual([]);
  });

  it('keeps a valid slice id, version and existing keys', async () => {
    const id = 'hero$61fa5c9e-559e-4acd-8fe3-b493f40685a7';
    const key = '07f5c24d-3ae6-4342-b716-49543351342e';
    const { data, errors } = await run({
      link: { link_type: 'Web', url: 'https://a.test', key },
      slices: [{ id, slice_type: 'hero', variation: 'compact', version: 'sktwi1xtmkfgx8626', primary: { size: 3 } }],
    });
    expect(errors).toEqual([]);
    expect((data.link as { key: string }).key).toBe(key);
    expect(data.slices).toEqual([
      { variation: 'compact', version: 'sktwi1xtmkfgx8626', items: [], primary: { size: 3 }, id, slice_type: 'hero', slice_label: null },
    ]);
  });

  it('returns FieldError for a select value outside its options and a number above max', async () => {
    const { errors } = await run({ size: 'XL', num: 11 });
    expect(errors).toEqual([
      { property: 'data.num', value: 11, error: 'The value must be lower than or equal to 10' },
      { property: 'data.size', value: 'XL', error: 'The value must be one of the options: S, M, L' },
    ]);
  });

  it('validates colors, dates, geopoints, rich text block types, assets and slices', async () => {
    const { errors } = await run({
      color: 'red',
      date: '2024-13-45',
      ts: 'yesterday',
      geo: { latitude: '95', longitude: '10' },
      body: [
        { type: 'paragraph', text: 'ok', spans: [] },
        { type: 'heading2', text: 'no', spans: [] },
      ],
      image: { id: 'MISSING00000000x' },
      link: { link_type: 'Web', url: 'https://a.test', target: 1 },
      slices: [{ slice_type: 'nope', variation: 'default' }, { slice_type: 'hero', variation: 'zzz' }, { slice_type: 'hero', variation: 'compact', id: 'bad' }],
    });
    expect(errors).toEqual([
      { property: 'data.color', value: 'red', error: 'The value must be a hexadecimal color value' },
      { property: 'data.date', value: '2024-13-45', error: 'The value must be a date in the format YYYY-MM-DD' },
      { property: 'data.ts', value: 'yesterday', error: 'The value must be a timestamp in the format YYYY-MM-DDTHH:MM:SS+0000' },
      { property: 'data.body.1.type', value: 'heading2', error: 'Invalid block type. Supported block types are: paragraph, image, embed' },
      { property: 'data.image.id', value: 'MISSING00000000x', error: 'The asset MISSING00000000x does not exist' },
      { property: 'data.link.target', value: 1, error: 'The target must be a string' },
      { property: 'data.geo.latitude', value: '95', error: 'The latitude must be a number between -90 and 90' },
      { property: 'data.slices.0.slice_type', value: 'nope', error: 'Unknown slice type "nope"' },
      { property: 'data.slices.1.variation', value: 'zzz', error: 'Unknown variation "zzz" for slice "hero"' },
      { property: 'data.slices.2.id', value: 'bad', error: 'The slice id must be "hero$" followed by a uuid v4' },
    ]);
  });

  it('coerces geopoint strings and stores image defaults', async () => {
    const { data, errors } = await run({
      geo: { latitude: '-9', longitude: '-160' },
      image: { id: 'ASSET0000000001', url: 'https://img.test/a.png?auto=compress,format', dimensions: { width: 800, height: 600 } },
    });
    expect(errors).toEqual([]);
    expect(data.geo).toEqual({ latitude: -9, longitude: -160 });
    expect(data.image).toEqual({
      dimensions: { width: 800, height: 600 },
      alt: null,
      copyright: null,
      url: 'https://img.test/a.png?auto=compress,format',
      id: 'ASSET0000000001',
      edit: { x: 0, y: 0, zoom: 1, background: 'transparent' },
    });
  });

  it('keeps {embed_url} when oEmbed cannot be resolved and merges it when it can', async () => {
    const a = await run({ embed: { embed_url: 'https://youtu.be/x', title: 'T' } });
    expect(a.data.embed).toEqual({ embed_url: 'https://youtu.be/x', title: 'T' });
    const b = await normalizeDocumentData(allFields, shared, { embed: { embed_url: 'https://youtu.be/x' } }, {
      resolveEmbed: async () => ({ type: 'video', version: '1.0', html: '<iframe></iframe>' }),
      assetExists: () => true,
    });
    expect(b.data.embed).toEqual({ embed_url: 'https://youtu.be/x', type: 'video', version: '1.0', html: '<iframe></iframe>' });
  });

  it('ignores unknown keys and never stores UID or Separator values in data', async () => {
    const { data } = await run({ uid: 'x', sep: 'y', extra: 1 });
    expect(Object.keys(data)).not.toContain('uid');
    expect(Object.keys(data)).not.toContain('sep');
    expect(Object.keys(data)).not.toContain('extra');
  });

  it('validates UID format with unicode allowed', () => {
    expect(validateUid('my-page_1')).toBeNull();
    expect(validateUid('café')).toBeNull();
    expect(validateUid('привет')).toBeNull();
    expect(validateUid('🎉-party')).toBeNull();
    expect(validateUid('Has Space')?.property).toBe('uid');
    expect(validateUid('Upper')).not.toBeNull();
    expect(validateUid('a/b')).not.toBeNull();
    expect(validateUid('')).not.toBeNull();
  });

  it('rejects a second block in a single-block rich text field', async () => {
    const model = ct({ Main: { t: { type: 'StructuredText', config: { single: 'heading1' } } } });
    const { errors } = await normalizeDocumentData(model, new Map(), {
      t: [{ type: 'heading1', text: 'a', spans: [] }, { type: 'heading1', text: 'b', spans: [] }],
    }, nctx());
    expect(errors).toEqual([{ property: 'data.t', value: expect.any(Array), error: 'The field accepts a single block' }]);
  });
});
