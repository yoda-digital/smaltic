import { z } from 'zod';

/** Prismic types-internal schema marker enabling stricter validation. */
export const STRICT_SCHEMA = '@prismicio/types-internal@4.5.0';
export const DEFAULT_SLICE_IMAGE_URL =
  'https://images.prismic.io/slice-machine/621a5ec4-0387-4bc5-9860-2dd46cbc07cd_default_ss.png?auto=compress,format';

const label = z.string().nullish();
const fieldset = z.string().nullish();

/** number or numeric string -> number */
const numLike = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v),
  z.number(),
);
const strOrStrArray = z.union([z.string(), z.array(z.string())]);

/** Select options: numbers/booleans coerced to strings. */
const optionStr = z.preprocess(
  (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : v),
  z.string(),
);

// ---- configs (all passthrough so unknown keys survive round-trips) ----
const baseCfg = { label, placeholder: z.string().nullish() };
const cfg = (shape: z.ZodRawShape) => z.object({ ...baseCfg, ...shape }).passthrough();
const mk = <T extends string, S extends z.ZodRawShape>(type: T, shape: S, withFieldset = true) =>
  z.object({
    type: z.literal(type),
    ...(withFieldset ? { fieldset } : {}),
    config: cfg(shape).default({}),
  }).passthrough();

// Optional-config helper: field models without `config` are tolerated.
const BooleanField = mk('Boolean', {
  default_value: z.boolean().optional(),
  placeholder_true: z.string().nullish(),
  placeholder_false: z.string().nullish(),
}, false);
const ColorField = mk('Color', {});
const DateField = mk('Date', { default: z.string().optional() });
const TimestampField = mk('Timestamp', { default: z.string().optional() });
const numCfg = { min: numLike.optional(), max: numLike.optional(), step: numLike.optional() };
const NumberField = mk('Number', numCfg);
const RangeField = mk('Range', numCfg);
const TextField = mk('Text', { useAsTitle: z.boolean().optional() });
const SelectField = mk('Select', {
  options: z.array(optionStr).optional(),
  default_value: optionStr.optional(),
});
const UIDField = mk('UID', { useAsTitle: z.boolean().optional() });

const RICH_TOKENS = new Set([
  'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
  'paragraph', 'preformatted', 'strong', 'em', 'hyperlink', 'image', 'embed',
  'list-item', 'o-list-item', 'rtl',
]);
/** Drops unknown tokens; empty/null -> "paragraph". */
const richOptions = z.preprocess((v) => {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v : '';
  const kept = s.split(',').map((t) => t.trim()).filter((t) => RICH_TOKENS.has(t));
  return kept.length ? kept.join(',') : 'paragraph';
}, z.string().optional());
/** labels: null | string | string[] | {"": [{name}]} -> string[] */
const richLabels = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const group = Array.isArray(o['']) ? o[''] : Object.values(o).find(Array.isArray);
    return Array.isArray(group)
      ? group.map((x) => (x && typeof x === 'object' ? (x as { name?: unknown }).name : x))
      : [];
  }
  return v;
}, z.array(z.string()).optional());
const sideConstraint = z.preprocess((v) => {
  if (v === null || v === '' || v === 'auto') return null;
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return v;
}, z.number().nullable().optional());
const sizeObj = z.object({ width: sideConstraint, height: sideConstraint }).passthrough();

const StructuredTextField = mk('StructuredText', {
  useAsTitle: z.boolean().optional(),
  single: richOptions,
  multi: richOptions,
  imageConstraint: sizeObj.optional(),
  labels: richLabels,
  allowTargetBlank: z.boolean().optional(),
});
const ImageField = mk('Image', {
  constraint: sizeObj.optional(),
  thumbnails: z.array(z.object({ name: z.string(), width: sideConstraint, height: sideConstraint }).passthrough()).optional(),
});

const linkSelect = z.preprocess(
  (v) => (v === 'web' || v === 'document' || v === 'media' ? v : null),
  z.enum(['web', 'document', 'media']).nullable().optional(),
);
const crLeaf = z.union([z.string(), z.object({ id: z.string(), fields: z.array(z.string()) }).passthrough()]);
const crLevel2 = z.object({ id: z.string(), customtypes: z.array(z.union([z.string(), z.object({ id: z.string(), fields: z.array(crLeaf) }).passthrough()])) }).passthrough();
const customtypesEntry = z.union([
  z.string(),
  z.object({
    id: z.string(),
    fields: z.array(z.union([z.string(), z.object({ id: z.string(), fields: z.array(z.string()) }).passthrough(), crLevel2])),
  }).passthrough(),
]);
const customtypes = z.array(customtypesEntry).superRefine((arr, ctx) => {
  const ids = arr.map((e) => (typeof e === 'string' ? e : e.id));
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate custom types in link customtypes' });
  const objs = arr.filter((e) => typeof e !== 'string').length;
  if (objs > 1) ctx.addIssue({ code: 'custom', message: 'cannot have multiple custom types with fields selection' });
  if (objs > 0 && objs !== arr.length) ctx.addIssue({ code: 'custom', message: 'cannot mix custom types as strings and objects with fields' });
});
const LinkField = mk('Link', {
  useAsTitle: z.boolean().optional(),
  select: linkSelect,
  customtypes: customtypes.optional(),
  masks: strOrStrArray.optional(),
  tags: strOrStrArray.optional(),
  allowTargetBlank: z.boolean().optional(),
  allowText: z.boolean().optional(),
  repeat: z.boolean().optional(),
  variants: z.array(z.string()).optional(),
});
const EmbedField = mk('Embed', { useAsTitle: z.boolean().optional() });
const GeoPointField = mk('GeoPoint', {});
const IntegrationFieldsField = mk('IntegrationFields', { catalog: z.string().optional() });
const TableField = mk('Table', {}, false);
const SeparatorField = mk('Separator', {}, false);

const nestables = [
  BooleanField, ColorField, DateField, TimestampField, NumberField, RangeField, TextField,
  SelectField, StructuredTextField, ImageField, LinkField, EmbedField, GeoPointField,
  IntegrationFieldsField, TableField, SeparatorField,
] as const;

export const NestableField = z.discriminatedUnion('type', [...nestables]);

const groupExtras = { icon: z.string().nullish(), description: z.string().nullish() };
const groupCfg = (fields: z.ZodTypeAny) =>
  z.object({ label, repeat: z.boolean().optional(), fields: z.record(fields).optional() }).passthrough();

/** A group nested inside a group: nestables only. */
export const NestedGroupField = z.object({
  type: z.literal('Group'), fieldset, ...groupExtras, config: groupCfg(NestableField).default({}),
}).passthrough();

/** Top-level group: nestables plus exactly one level of nested group (Q4). */
export const GroupField = z.object({
  type: z.literal('Group'), fieldset, ...groupExtras,
  config: groupCfg(z.discriminatedUnion('type', [...nestables, NestedGroupField])).default({}),
}).passthrough();

// ---- slices ----
const SliceLabel = z.object({ name: z.string(), display: z.string().optional() }).passthrough();
const SharedSliceRef = z.object({ type: z.literal('SharedSlice') }).passthrough();

const Variation = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  imageUrl: z.string().default(DEFAULT_SLICE_IMAGE_URL),
  docURL: z.string().default(''),
  version: z.string().default(''),
  display: z.string().optional(),
  primary: z.record(z.discriminatedUnion('type', [...nestables, GroupField])).optional(),
  items: z.record(NestableField).optional(),
}).passthrough();

export const SharedSliceSchema = z.object({
  id: z.string().min(1),
  type: z.literal('SharedSlice'),
  name: z.string(),
  description: z.string().optional(),
  variations: z.array(Variation),
  legacyPaths: z.record(z.string()).optional(),
  schema: z.literal(STRICT_SCHEMA).optional(),
}).passthrough().superRefine((s, ctx) => {
  if (s.schema === STRICT_SCHEMA) {
    if (s.variations.length < 1) ctx.addIssue({ code: 'custom', message: 'shared slice needs at least one variation' });
  }
  const ids = s.variations.map((v) => v.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate variation id' });
});

const CompositeSlice = z.object({
  type: z.literal('Slice'),
  fieldset,
  description: z.string().nullish(),
  icon: z.string().nullish(),
  display: z.string().nullish(),
  'non-repeat': z.record(NestableField).optional(),
  repeat: z.record(NestableField).optional(),
  config: z.object({ label }).passthrough().optional(),
}).passthrough();

/** A choice in a slice zone: shared-slice ref/model, composite slice, or legacy nestable. */
const SliceChoice = z.union([
  SharedSliceRef,
  CompositeSlice,
  NestableField,
  NestedGroupField,
]);

const slicesBody = {
  fieldset,
  config: z.object({
    label,
    labels: z.record(z.array(SliceLabel)).nullish(),
    choices: z.record(SliceChoice).optional(),
  }).passthrough().default({}),
};
const SlicesField = z.object({ type: z.literal('Slices'), ...slicesBody }).passthrough();
const ChoiceField = z.object({ type: z.literal('Choice'), ...slicesBody }).passthrough();

export const FieldSchema = z.discriminatedUnion('type', [
  UIDField, ...nestables, GroupField, SlicesField, ChoiceField,
]);

// ---- custom type ----
const widgetKeyOk = (k: string) => !/[<>]/.test(k);

export const CustomTypeSchema = z.object({
  id: z.string().min(1),
  label: z.string().nullish(),
  repeatable: z.boolean().default(true),
  status: z.boolean().default(true),
  format: z.enum(['page', 'custom']).default('custom'),
  json: z.record(z.record(FieldSchema)),
  schema: z.literal(STRICT_SCHEMA).optional(),
}).passthrough().superRefine((ct, ctx) => {
  const seen = new Map<string, string>();
  let uidCount = 0;
  const checkKeys = (fields: Record<string, { type: string; config?: unknown }>, path: (string | number)[]) => {
    for (const [key, f] of Object.entries(fields)) {
      if (!widgetKeyOk(key)) ctx.addIssue({ code: 'custom', path: [...path, key], message: `invalid field key "${key}": must not contain "<" or ">"` });
      const sub = (f.config as { fields?: Record<string, { type: string; config?: unknown }> } | undefined)?.fields;
      if (f.type === 'Group' && sub) checkKeys(sub, [...path, key, 'config', 'fields']);
    }
  };
  for (const [tab, fields] of Object.entries(ct.json)) {
    checkKeys(fields, ['json', tab]);
    for (const [key, f] of Object.entries(fields)) {
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['json', tab, key], message: `duplicate field id "${key}" (tabs "${seen.get(key)}" and "${tab}")` });
      else seen.set(key, tab);
      if (f.type === 'UID') {
        uidCount++;
        if (ct.schema === STRICT_SCHEMA && key !== 'uid') ctx.addIssue({ code: 'custom', path: ['json', tab, key], message: 'the UID field id must be "uid"' });
      }
    }
  }
  if (uidCount > 1) ctx.addIssue({ code: 'custom', path: ['json'], message: 'only one UID field is allowed per custom type' });
});

export type Field = z.infer<typeof FieldSchema>;
export type CustomType = z.infer<typeof CustomTypeSchema>;
export type SharedSlice = z.infer<typeof SharedSliceSchema>;
export type FieldType = Field['type'];
