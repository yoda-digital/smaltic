import { describe, expect, it } from 'vitest';
import { collectDocumentLinkIds, extractSearchText, normalizeDocumentData, renderDocumentData } from '../src/index.js';
import { allFields, ct, heroSlice, nctx, rctx, shared, stubDoc } from './contentFixtures.js';

describe('renderDocumentData', () => {
  it('outputs every empty shape', () => {
    const out = renderDocumentData(allFields, shared, {}, rctx());
    expect(out).toStrictEqual({
      flag: false,
      flag_on: true,
      color: null,
      date: null,
      ts: null,
      num: null,
      text: null,
      size: null,
      size_def: null,
      title: [],
      body: [],
      image: {},
      link: { link_type: 'Any' },
      links: [],
      media: { link_type: 'Media' },
      rel: { link_type: 'Document' },
      embed: {},
      geo: {},
      integ: null,
      table: null,
      group: [],
      slices: [],
    });
  });

  it('renders normalized empties identically (except the stored Select default)', async () => {
    const { data } = await normalizeDocumentData(allFields, shared, {}, nctx());
    expect(renderDocumentData(allFields, shared, data, rctx())).toStrictEqual({
      ...renderDocumentData(allFields, shared, {}, rctx()),
      size_def: 'M',
    });
  });

  it('renders content after model change', () => {
    const v1 = ct({ Main: { old: { type: 'Text' }, n: { type: 'Text' }, keep: { type: 'Number' } } });
    const v2 = ct({ Main: { n: { type: 'Image' }, keep: { type: 'Number' }, added: { type: 'Group', config: { fields: {} } } } });
    const stored = { old: 'gone', n: 'a string', keep: 4 };
    expect(renderDocumentData(v1, new Map(), stored, rctx())).toStrictEqual({ old: 'gone', n: 'a string', keep: 4 });
    const out = renderDocumentData(v2, new Map(), stored, rctx());
    expect(out).toStrictEqual({ n: {}, keep: 4, added: [] });
    expect(out).not.toHaveProperty('old');
  });

  it('renders retyped values of every kind as empty without throwing', () => {
    const stored: Record<string, unknown> = {};
    for (const k of Object.keys(renderDocumentData(allFields, shared, {}, rctx()))) stored[k] = k === 'text' ? 5 : 'str';
    stored.text = 5;
    const out = renderDocumentData(allFields, shared, stored, rctx());
    expect(out).toStrictEqual({ ...renderDocumentData(allFields, shared, {}, rctx()), color: null, size: 'str', size_def: 'str' });
  });

  it('delegates Document links to resolveLink, keeping field keys and dropping span keys', () => {
    const calls: Array<[string, string]> = [];
    const key = '6c1724f0-357c-4e5d-98fc-ad1e58a012f8';
    const out = renderDocumentData(
      allFields,
      shared,
      {
        rel: { link_type: 'Document', id: 'DOC0000000000001', key, text: 'Read', variant: 'Primary' },
        body: [
          {
            type: 'paragraph',
            text: 'see doc',
            spans: [{ start: 4, end: 7, type: 'hyperlink', data: { link_type: 'Document', id: 'DOC0000000000002' } }],
            direction: 'ltr',
          },
        ],
      },
      rctx(calls),
    );
    expect(out.rel).toStrictEqual({ ...stubDoc('DOC0000000000001'), key, text: 'Read', variant: 'Primary' });
    expect(Object.keys(out.rel as object).slice(-5)).toEqual(['link_type', 'key', 'isBroken', 'text', 'variant']);
    expect(out.body).toStrictEqual([
      { type: 'paragraph', text: 'see doc', spans: [{ start: 4, end: 7, type: 'hyperlink', data: stubDoc('DOC0000000000002') }], direction: 'ltr' },
    ]);
    expect(calls).toEqual([
      ['DOC0000000000002', 'body'],
      ['DOC0000000000001', 'rel'],
    ]);
  });

  it('renders shared slices with the live key set and drops unknown slices', () => {
    const id = 'hero$61fa5c9e-559e-4acd-8fe3-b493f40685a7';
    const stored = {
      slices: [
        { variation: 'compact', version: 'initial', items: [{}], primary: { size: 2, removed: 'x' }, id, slice_type: 'hero', slice_label: null },
        { variation: 'gone', version: 'initial', items: [], primary: {}, id: 'hero$x', slice_type: 'hero', slice_label: null },
        { variation: 'default', version: 'initial', items: [], primary: {}, id: 'old$x', slice_type: 'old', slice_label: null },
      ],
    };
    const out = renderDocumentData(allFields, shared, stored, rctx());
    expect(out.slices).toStrictEqual([
      { variation: 'compact', version: 'initial', items: [{}], primary: { size: 2 }, id, slice_type: 'hero', slice_label: null },
    ]);
    expect(heroSlice.variations).toHaveLength(2);
  });

  it('fills image thumbnails from the main image and drops unknown image keys', () => {
    const image = {
      dimensions: { width: 800, height: 600 },
      alt: 'a',
      copyright: null,
      url: 'https://img.test/a.png?auto=compress,format',
      id: 'ASSET0000000001',
      edit: { x: 0, y: 0, zoom: 1, background: 'transparent' },
      stale_thumb: { id: 'x' },
    };
    const out = renderDocumentData(allFields, shared, { image }, rctx()).image as Record<string, any>;
    expect(Object.keys(out)).toEqual(['dimensions', 'alt', 'copyright', 'url', 'id', 'edit', 'mobile']);
    expect(out.mobile).toMatchObject({ id: 'ASSET0000000001', dimensions: { width: 400, height: 300 } });
  });

  it('rebuilds image and media urls through resolveAssetUrl, keeping image query strings (R12)', () => {
    const seen: string[] = [];
    const ctx = {
      ...rctx(),
      resolveAssetUrl: (id: string) => {
        seen.push(id);
        return id === 'ASSET0000000001' ? `https://cms.test/assets/repo/${id}_a.png` : null;
      },
    };
    const stored = {
      image: { dimensions: { width: 8, height: 6 }, url: 'https://old.test/a.png?auto=format&rect=0,0,8,6', id: 'ASSET0000000001', mobile: { url: 'https://old.test/a.png?w=4', id: 'ASSET0000000001' } },
      body: [{ type: 'image', url: 'https://old.test/a.png', id: 'ASSET0000000001', dimensions: { width: 8, height: 6 } }],
      media: { link_type: 'Media', id: 'ASSET0000000001', url: 'https://old.test/a.png?x=1', name: 'a.png', kind: 'image', size: '1' },
      link: { link_type: 'Media', id: 'MISSING00000001', url: 'https://old.test/gone.pdf', name: 'gone.pdf', kind: 'file', size: '1' },
    };
    const out = renderDocumentData(allFields, shared, stored, ctx) as Record<string, any>;
    expect(out.image.url).toBe('https://cms.test/assets/repo/ASSET0000000001_a.png?auto=format&rect=0,0,8,6');
    expect(out.image.mobile.url).toBe('https://cms.test/assets/repo/ASSET0000000001_a.png?w=4');
    expect(out.body[0].url).toBe('https://cms.test/assets/repo/ASSET0000000001_a.png');
    expect(out.media.url).toBe('https://cms.test/assets/repo/ASSET0000000001_a.png');
    expect(out.link.url).toBe('https://old.test/gone.pdf');
    expect(new Set(seen)).toEqual(new Set(['ASSET0000000001', 'MISSING00000001']));
    // Input is not mutated.
    expect(stored.image.url).toBe('https://old.test/a.png?auto=format&rect=0,0,8,6');
  });

  it('collects Document link ids for batch loading', async () => {
    const stored = {
      rel: { link_type: 'Document', id: 'A000000000000001' },
      body: [{ type: 'paragraph', text: 'x', spans: [{ start: 0, end: 1, type: 'hyperlink', data: { link_type: 'Document', id: 'B000000000000001' } }] }],
      slices: [{ primary: { cards: [{ link: { link_type: 'Document', id: 'A000000000000001' } }] } }],
    };
    expect(collectDocumentLinkIds(stored).sort()).toEqual(['A000000000000001', 'B000000000000001']);
  });
});

describe('extractSearchText', () => {
  it('splits headings, titles and key text from body text and selects, excluding image alt', () => {
    const stored = {
      text: 'Key words',
      size: 'M',
      title: [{ type: 'heading1', text: 'Main title', spans: [] }],
      body: [
        { type: 'heading2', text: 'Sub heading', spans: [] },
        { type: 'paragraph', text: 'Body para', spans: [] },
        { type: 'image', alt: 'secret alt', url: 'u', id: 'i' },
      ],
      group: [{ label: 'In group' }],
      slices: [{ variation: 'default', slice_type: 'hero', primary: { title: [{ type: 'heading1', text: 'Slice title', spans: [] }] }, items: [{ caption: 'cap' }] }],
    };
    const { weightA, weightB } = extractSearchText(allFields, stored, { sharedSlices: shared, uid: 'my-uid' });
    for (const s of ['Key words', 'Main title', 'Sub heading', 'my-uid', 'In group', 'Slice title', 'cap']) expect(weightA).toContain(s);
    for (const s of ['Body para', 'M']) expect(weightB).toContain(s);
    expect(weightA + weightB).not.toContain('secret alt');
    expect(weightA).not.toContain('Body para');
  });
});
