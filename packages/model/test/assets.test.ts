import { describe, expect, it } from 'vitest';
import { normalizeDocumentData, type AssetInfo, type NormalizeCtx } from '../src/index.js';
import { allFields, shared } from './contentFixtures.js';

const IMG: AssetInfo = {
  id: 'IMGASSET00000001',
  url: 'https://cms.test/assets/repo/IMGASSET00000001_pic.png',
  filename: 'pic.png',
  kind: 'image',
  size: 1234,
  width: 640,
  height: 480,
};
const PDF: AssetInfo = {
  id: 'PDFASSET00000001',
  url: 'https://cms.test/assets/repo/PDFASSET00000001_doc.pdf',
  filename: 'doc.pdf',
  kind: 'document',
  size: 99,
};

const byId = new Map([IMG, PDF].map((a) => [a.id, a]));
const lookups: string[] = [];
const ctx: NormalizeCtx = {
  resolveEmbed: () => null,
  getAsset: async (id) => {
    lookups.push(id);
    return byId.get(id) ?? null;
  },
};
const run = (input: Record<string, unknown>, c: NormalizeCtx = ctx) => normalizeDocumentData(allFields, shared, input, c);

describe('normalize with getAsset (asset-backed media)', () => {
  it('fills an id-only image field from the asset (url, dimensions) and its thumbnails', async () => {
    const { data, errors } = await run({ image: { id: IMG.id, mobile: { id: IMG.id } } });
    expect(errors).toEqual([]);
    const edit = { x: 0, y: 0, zoom: 1, background: 'transparent' };
    expect(data.image).toEqual({
      dimensions: { width: 640, height: 480 },
      alt: null,
      copyright: null,
      url: IMG.url,
      id: IMG.id,
      edit,
      mobile: { dimensions: { width: 640, height: 480 }, alt: null, copyright: null, url: IMG.url, id: IMG.id, edit },
    });
  });

  it('rebuilds the image url from the asset but keeps the original query and explicit dimensions', async () => {
    const { data, errors } = await run({
      image: { id: IMG.id, url: 'https://elsewhere.test/x/IMGASSET00000001_pic.png?auto=format&rect=0,0,10,10', dimensions: { width: 10, height: 10 } },
    });
    expect(errors).toEqual([]);
    expect(data.image).toMatchObject({ url: `${IMG.url}?auto=format&rect=0,0,10,10`, dimensions: { width: 10, height: 10 } });
  });

  it('fills an id-only rich-text image block', async () => {
    const { data, errors } = await run({ body: [{ type: 'image', id: IMG.id }] });
    expect(errors).toEqual([]);
    expect((data.body as unknown[])[0]).toMatchObject({ type: 'image', id: IMG.id, url: IMG.url, dimensions: { width: 640, height: 480 } });
  });

  it('fills an id-only link to media (image and file kinds)', async () => {
    const a = await run({ media: { link_type: 'Media', id: IMG.id, text: 'see' } });
    expect(a.errors).toEqual([]);
    expect(a.data.media).toEqual({
      link_type: 'Media',
      key: expect.any(String),
      kind: 'image',
      id: IMG.id,
      url: IMG.url,
      name: 'pic.png',
      size: '1234',
      height: '480',
      width: '640',
      text: 'see',
    });
    const b = await run({ media: { link_type: 'Media', id: PDF.id } });
    expect(b.data.media).toEqual({
      link_type: 'Media', key: expect.any(String), kind: 'file', id: PDF.id, url: PDF.url, name: 'doc.pdf', size: '99',
    });
  });

  it('reports unknown asset ids for images and media links', async () => {
    const { errors } = await run({ image: { id: 'NOPE000000000000' }, media: { link_type: 'Media', id: 'NOPE000000000001' } });
    expect(errors).toEqual([
      { property: 'data.image.id', value: 'NOPE000000000000', error: 'The asset NOPE000000000000 does not exist' },
      { property: 'data.media.id', value: 'NOPE000000000001', error: 'The asset NOPE000000000001 does not exist' },
    ]);
  });

  it('still honours a ctx that only provides assetExists', async () => {
    const { data, errors } = await run(
      { image: { id: 'X', url: 'https://img.test/a.png' } },
      { resolveEmbed: () => null, assetExists: (id) => id === 'X' },
    );
    expect(errors).toEqual([]);
    expect(data.image).toMatchObject({ id: 'X', url: 'https://img.test/a.png' });
  });
});
