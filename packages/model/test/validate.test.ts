import { describe, expect, it } from 'vitest';
import { flattenFields, newId, sliceId, validateCustomType, validateSharedSlice } from '../src/index.js';

const pageType = {
  id: 'page',
  label: 'Page',
  repeatable: true,
  json: {
    Page: { uid: { type: 'UID', config: { label: 'UID', placeholder: 'example-unique-identifier' } } },
  },
  status: true,
};

const legacyJson = {
  'Example First Tab': {
    example_number: { type: 'Number', config: { label: 'Example Number', placeholder: '3.14159...' } },
    body: {
      type: 'Slices',
      fieldset: 'Slice zone',
      config: {
        labels: { example_first_slice: [] },
        choices: {
          example_first_slice: {
            type: 'Slice',
            fieldset: 'Example First Slice',
            description: 'This is the first example slice.',
            icon: 'adb',
            display: 'list',
            'non-repeat': {
              example_slice_key_text: { type: 'Text', config: { label: 'Example Slice Key Text', placeholder: 'Massa' } },
            },
            repeat: {},
          },
        },
      },
    },
  },
  'Example Second Tab': { example_color: { type: 'Color', config: { label: 'Example Color' } } },
};

const sharedSlice = {
  id: 'image_gallery',
  type: 'SharedSlice',
  name: 'ImageGallery',
  description: 'ImageGallery',
  variations: [
    {
      id: 'default',
      name: 'Default',
      docURL: '...',
      version: 'sktwi1xtmkfgx8626',
      description: 'Text',
      primary: {
        text: {
          type: 'StructuredText',
          config: { label: 'Text', placeholder: 'Text with rich formatting', allowTargetBlank: false, multi: 'paragraph' },
        },
      },
      items: {},
      imageUrl: 'https://images.prismic.io/tutorial-series/shared-slices/image_gallery/preview.png',
    },
  ],
};

const group = (fields: Record<string, unknown>) => ({ type: 'Group', config: { label: 'g', repeat: true, fields } });
const ct = (json: Record<string, unknown>) => ({ id: 't', json });

describe('validateCustomType', () => {
  it('accepts the R2 1.2 envelope example and applies defaults', () => {
    const r = validateCustomType(pageType);
    expect(r.ok).toBe(true);
    const r2 = validateCustomType({ id: 'x', json: { Main: {} } });
    expect(r2.ok && r2.value).toMatchObject({ repeatable: true, status: true, format: 'custom' });
  });

  it('accepts the legacy builder JSON with two tabs and a composite slice', () => {
    const r = validateCustomType({ id: 'legacy', json: legacyJson });
    expect(r.ok).toBe(true);
  });

  it('accepts shared slice refs in a slice zone', () => {
    const r = validateCustomType(ct({ Main: { slices: { type: 'Slices', config: { choices: { hero: { type: 'SharedSlice' } } } } } }));
    expect(r.ok).toBe(true);
  });

  it('keeps unknown config keys', () => {
    const r = validateCustomType(ct({ Main: { t: { type: 'Text', config: { label: 'T', weird: 1 } } } }));
    expect(r.ok && (r.value.json.Main.t.config as Record<string, unknown>).weird).toBe(1);
  });

  it('normalizes numeric strings, select options and rich text tokens', () => {
    const r = validateCustomType(ct({ Main: {
      n: { type: 'Number', config: { min: '1', max: 5, step: '0.5' } },
      s: { type: 'Select', config: { options: [1, true, 'x'] } },
      r: { type: 'StructuredText', config: { multi: 'paragraph,bogus,em', single: '', labels: { '': [{ name: 'sup' }] } } },
    } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.json.Main.n.config).toMatchObject({ min: 1, max: 5, step: 0.5 });
      expect(r.value.json.Main.s.config).toMatchObject({ options: ['1', 'true', 'x'] });
      expect(r.value.json.Main.r.config).toMatchObject({ multi: 'paragraph,em', single: 'paragraph', labels: ['sup'] });
    }
  });

  it('rejects a duplicate field id across tabs', () => {
    const r = validateCustomType(ct({ A: { x: { type: 'Text' } }, B: { x: { type: 'Color' } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('duplicate field');
  });

  it('accepts one nested group level and rejects deeper', () => {
    const ok = validateCustomType(ct({ Main: { g: group({ inner: group({ t: { type: 'Text' } }) }) } }));
    expect(ok.ok).toBe(true);
    const bad = validateCustomType(ct({ Main: { g: group({ a: group({ b: group({ t: { type: 'Text' } }) }) }) } }));
    expect(bad.ok).toBe(false);
  });

  it('rejects field keys containing < or >', () => {
    expect(validateCustomType(ct({ Main: { 'a<b': { type: 'Text' } } })).ok).toBe(false);
    expect(validateCustomType(ct({ Main: { g: group({ 'a>b': { type: 'Text' } }) } })).ok).toBe(false);
  });

  it('rejects more than one UID field', () => {
    const r = validateCustomType(ct({ Main: { uid: { type: 'UID' }, uid2: { type: 'UID' } } }));
    expect(r.ok).toBe(false);
  });

  it('rejects unknown field types and UID inside a group', () => {
    expect(validateCustomType(ct({ Main: { x: { type: 'Nope' } } })).ok).toBe(false);
    expect(validateCustomType(ct({ Main: { g: group({ uid: { type: 'UID' } }) } })).ok).toBe(false);
  });

  it('requires uid key under the strict schema marker', () => {
    const r = validateCustomType({ id: 't', schema: '@prismicio/types-internal@4.5.0', json: { M: { slug: { type: 'UID' } } } });
    expect(r.ok).toBe(false);
  });

  it('rejects non-objects without throwing', () => {
    expect(validateCustomType(null).ok).toBe(false);
    expect(validateCustomType('x').ok).toBe(false);
  });

  it('rejects mixed link customtypes', () => {
    const r = validateCustomType(ct({ Main: { l: { type: 'Link', config: { select: 'document', customtypes: ['a', { id: 'b', fields: ['n'] }] } } } }));
    expect(r.ok).toBe(false);
  });

  it('unknown link select falls back to null', () => {
    const r = validateCustomType(ct({ Main: { l: { type: 'Link', config: { select: 'weird' } } } }));
    expect(r.ok && (r.value.json.Main.l.config as { select: unknown }).select).toBeNull();
  });
});

describe('validateSharedSlice', () => {
  it('accepts the R2 3.3 example and fills variation defaults', () => {
    const r = validateSharedSlice(sharedSlice);
    expect(r.ok).toBe(true);
    const r2 = validateSharedSlice({ ...sharedSlice, variations: [{ id: 'v', name: 'V' }] });
    expect(r2.ok && r2.value.variations[0].imageUrl).toContain('621a5ec4');
  });

  it('rejects duplicate variation ids', () => {
    const v = sharedSlice.variations[0];
    expect(validateSharedSlice({ ...sharedSlice, variations: [v, v] }).ok).toBe(false);
  });
});

describe('flattenFields and ids', () => {
  it('merges tabs', () => {
    const r = validateCustomType({ id: 'legacy', json: legacyJson });
    if (!r.ok) throw new Error('invalid');
    expect([...flattenFields(r.value).keys()]).toEqual(['example_number', 'body', 'example_color']);
  });

  it('newId is 16 chars of the url-safe alphabet', () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newId()).not.toBe(newId());
  });

  it('sliceId has the type$uuid shape', () => {
    expect(sliceId('hero')).toMatch(/^hero\$[0-9a-f-]{36}$/);
  });
});
