// Field selections over rendered `data` (R1§4.8): graphQuery, fetchLinks, deprecated `fetch` and model-level
// content relationship field selection all compile to the same `Selection` tree, which `project()` applies to
// rendered data. Projection always builds new objects; rendered values are shared, never mutated.
import { BLOCK_TYPES, isObj, isStr } from "@smaltic/model";

/** Malformed `routes` / `fetchLinks` / `graphQuery` / `fetch` parameter (Task 10 maps it to a 400). */
export class LinkParamError extends Error {}

/**
 * A selection of fields. Its meaning depends on where it applies:
 * - on document data: `fields` are data fields; `spreads` holds type ids from `...<type>Fields` (all fields);
 * - on a group: `fields` are sub-fields;
 * - on a link: `on` holds per-linked-type selections (`...on author { }`), plain `fields` apply to any type;
 * - on a slice zone: `on` holds per-slice-type branches whose `fields` are `variation`, `primary`, `items`;
 *   `spreads` (zone or branch) holds slice types selected whole (`...<slice>Fields`).
 * A `fields` value of `null` selects the whole value.
 */
export interface Selection {
  fields: Map<string, Selection | null>;
  spreads: Set<string>;
  on: Map<string, Selection>;
  /** fetchLinks: rich text fields limited to their first block (unless another source selects them whole). */
  firstBlock: Set<string>;
}

export const emptySelection = (): Selection => ({ fields: new Map(), spreads: new Set(), on: new Map(), firstBlock: new Set() });

export const isEmptySelection = (s: Selection): boolean => s.fields.size === 0 && s.spreads.size === 0 && s.on.size === 0;

/** Union of two selections (new object; inputs untouched). */
export function mergeSelections(a: Selection, b: Selection): Selection {
  const out = emptySelection();
  for (const src of [a, b]) {
    for (const [k, v] of src.fields) {
      if (!out.fields.has(k)) out.fields.set(k, v);
      else {
        const prev = out.fields.get(k)!;
        out.fields.set(k, prev === null || v === null ? null : mergeSelections(prev, v));
      }
    }
    for (const s of src.spreads) out.spreads.add(s);
    for (const [k, v] of src.on) out.on.set(k, out.on.has(k) ? mergeSelections(out.on.get(k)!, v) : v);
  }
  // First-block only if every source selecting the field limits it.
  for (const k of out.fields.keys()) {
    const limited = (s: Selection) => !s.fields.has(k) || s.firstBlock.has(k);
    if (limited(a) && limited(b)) out.firstBlock.add(k);
  }
  return out;
}

// ---- graphQuery parser --------------------------------------------------------------------------------------

type Tok = { t: "{" | "}" | "..." | "id"; v: string; pos: number };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/[\s,]/.test(c)) { i++; continue; }
    if (c === "{" || c === "}") { out.push({ t: c, v: c, pos: i }); i++; continue; }
    if (s.startsWith("...", i)) { out.push({ t: "...", v: "...", pos: i }); i += 3; continue; }
    const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
    if (!m) throw new LinkParamError(`graphQuery: unexpected character '${c}' at position ${i}`);
    out.push({ t: "id", v: m[0], pos: i });
    i += m[0].length;
  }
  return out;
}

/**
 * Parses a graphQuery (R1§4.8). The root selection's `fields` map page type ids to their selection:
 * `{ blog { title author { ...on author { name } } } }` -> fields{blog -> fields{title, author -> on{author -> {name}}}}.
 */
export function parseGraphQuery(s: string): Selection {
  const toks = tokenize(s);
  let i = 0;
  const peek = () => toks[i];
  const fail = (what: string): never => {
    const t = toks[i];
    throw new LinkParamError(`graphQuery: expected ${what} ${t ? `at position ${t.pos}` : "at end of input"}`);
  };
  const expect = (t: Tok["t"]) => (peek()?.t === t ? toks[i++]! : fail(`'${t}'`));

  const block = (): Selection => {
    expect("{");
    const sel = emptySelection();
    while (peek() && peek()!.t !== "}") {
      const tok = toks[i++]!;
      if (tok.t === "...") {
        const name = peek()?.t === "id" ? toks[i++]!.v : fail("a type name after '...'");
        if (name === "on" && peek()?.t === "id") {
          const type = toks[i++]!.v;
          const sub = block();
          sel.on.set(type, sel.on.has(type) ? mergeSelections(sel.on.get(type)!, sub) : sub);
        } else if (name.endsWith("Fields") && name.length > "Fields".length) {
          sel.spreads.add(name.slice(0, -"Fields".length));
        } else fail(`'on <type>' or '<type>Fields' after '...'`);
      } else if (tok.t === "id") {
        const sub = peek()?.t === "{" ? block() : null;
        const prev = sel.fields.get(tok.v);
        sel.fields.set(tok.v, sel.fields.has(tok.v) ? (prev === null || sub === null ? null : mergeSelections(prev!, sub)) : sub);
      } else {
        i--;
        fail("a field name");
      }
    }
    expect("}");
    return sel;
  };

  const root = block();
  if (i !== toks.length) fail("end of input");
  return root;
}

/** Applies a parsed graphQuery to a document's rendered `data`; types the query does not mention are unchanged. */
export function applyGraphQuery(selection: Selection, data: Record<string, unknown>, type: string): Record<string, unknown> {
  const sel = selection.fields.get(type);
  return sel ? project(data, sel, type) : data;
}

// ---- fetchLinks / fetch -------------------------------------------------------------------------------------

function listItems(param: string, name: string): string[] {
  let s = param.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const items = s.split(",").map((x) => x.trim()).filter((x) => x !== "");
  if (items.length === 0) throw new LinkParamError(`${name}: empty selection`);
  return items;
}

/**
 * `fetchLinks=type.field | type.group.field | type.body`, comma-separated, optionally in brackets.
 * Returns per linked type the selection of its `data`. Rich text fields keep only their first block.
 */
export function parseFetchLinks(param: string): Map<string, Selection> {
  const out = new Map<string, Selection>();
  for (const item of listItems(param, "fetchLinks")) {
    const parts = item.split(".");
    if (parts.length < 2 || parts.length > 3 || parts.some((x) => !/^[A-Za-z0-9_-]+$/.test(x))) {
      throw new LinkParamError(`fetchLinks: invalid item '${item}'`);
    }
    const [type, field, sub] = parts as [string, string, string | undefined];
    const one = emptySelection();
    if (sub === undefined) {
      one.fields.set(field, null);
      one.firstBlock.add(field);
    } else {
      const inner = emptySelection();
      inner.fields.set(sub, null);
      inner.firstBlock.add(sub);
      one.fields.set(field, inner);
    }
    out.set(type, out.has(type) ? mergeSelections(out.get(type)!, one) : one);
  }
  return out;
}

/** Deprecated `fetch=type.field` (comma list, optional brackets): per document type, the top-level fields kept. */
export function parseFetch(param: string): Map<string, Selection> {
  const out = new Map<string, Selection>();
  for (const item of listItems(param, "fetch")) {
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(item);
    if (!m) throw new LinkParamError(`fetch: invalid item '${item}'`);
    const sel = out.get(m[1]!) ?? emptySelection();
    sel.fields.set(m[2]!, null);
    out.set(m[1]!, sel);
  }
  return out;
}

// ---- model-level field selection ----------------------------------------------------------------------------

/**
 * Selection for a document of `type` linked through a content relationship whose `config.customtypes` selects
 * fields (R2§2.13): strings are fields, `{id, fields}` are group sub-fields, `{id, customtypes}` a nested
 * relationship (level 2). `null` when the config selects nothing for that type.
 */
export function modelSelection(customtypes: unknown, type: string): Selection | null {
  if (!Array.isArray(customtypes)) return null;
  const entry = customtypes.find((c) => isObj(c) && c.id === type);
  if (!entry || !Array.isArray(entry.fields)) return null;
  const sel = fieldsSelection(entry.fields);
  return isEmptySelection(sel) ? null : sel;
}

function fieldsSelection(fields: unknown[]): Selection {
  const sel = emptySelection();
  for (const f of fields) {
    if (isStr(f)) sel.fields.set(f, null);
    else if (isObj(f) && isStr(f.id)) {
      if (Array.isArray(f.fields)) sel.fields.set(f.id, fieldsSelection(f.fields));
      else if (Array.isArray(f.customtypes)) {
        const link = emptySelection();
        for (const c of f.customtypes) if (isObj(c) && isStr(c.id) && Array.isArray(c.fields)) link.on.set(c.id, fieldsSelection(c.fields));
        sel.fields.set(f.id, link);
      }
    }
  }
  return sel;
}

/** The selection of a linked document's `data` given the selection on the link field (`...on type` + plain fields). */
export function linkTargetSelection(link: Selection, type: string): Selection | null {
  const plain: Selection = { fields: link.fields, spreads: link.spreads, on: new Map(), firstBlock: link.firstBlock };
  const typed = link.on.get(type);
  const sel = typed ? mergeSelections(plain, typed) : plain;
  return isEmptySelection(sel) ? null : sel;
}

// ---- projection ---------------------------------------------------------------------------------------------

const isRichText = (v: unknown[]): boolean => v.length > 0 && v.every((b) => isObj(b) && isStr(b.type) && BLOCK_TYPES.has(b.type));

/** Projects document (or group item) data on a selection, in data key order. Link values are kept as rendered. */
export function project(data: Record<string, unknown>, sel: Selection, type?: string): Record<string, unknown> {
  const all = type !== undefined && sel.spreads.has(type);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!sel.fields.has(k)) {
      if (all) out[k] = v;
      continue;
    }
    const sub = sel.fields.get(k)!;
    if (sub === null) {
      out[k] = sel.firstBlock.has(k) && Array.isArray(v) && isRichText(v) ? v.slice(0, 1) : v;
    } else out[k] = projectValue(v, sub);
  }
  return out;
}

function projectValue(v: unknown, sel: Selection): unknown {
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) {
      if (isObj(item) && isStr(item.slice_type)) {
        const s = projectSlice(item, sel);
        if (s) out.push(s);
      } else out.push(isObj(item) ? project(item, sel) : item);
    }
    return out;
  }
  // Links (their `data` was selected at render time), images, embeds...: kept whole.
  return v;
}

function projectSlice(slice: Record<string, unknown>, zone: Selection): Record<string, unknown> | null {
  const type = slice.slice_type as string;
  const branch = zone.on.get(type);
  if (zone.spreads.has(type) || branch?.spreads.has(type)) return slice;
  if (!branch) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(slice)) {
    if (k === "variation") {
      if (branch.fields.has("variation")) out[k] = v;
    } else if (k === "primary" || k === "items") {
      const sub = branch.fields.get(k);
      if (sub === undefined) out[k] = k === "primary" ? {} : [];
      else if (sub === null) out[k] = v;
      else if (k === "primary") out[k] = isObj(v) ? project(v, sub) : {};
      else out[k] = Array.isArray(v) ? v.map((it) => (isObj(it) ? project(it, sub) : it)) : [];
    } else out[k] = v;
  }
  return out;
}
