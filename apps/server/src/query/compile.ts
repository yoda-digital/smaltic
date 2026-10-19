// Search compiler: FilterNode[] + orderings + pagination + lang -> one parameterized SQL query (R1§4.3-4.5).
// User values are always bound parameters; JSON keys are field ids validated against the custom type model and
// are bound as parameters too.
import { flattenFields, type CustomType, type StoredData } from "@smaltic/model";
import type { Fragment, Sql } from "../db/index.js";
import { searchQuery, searchVector } from "../domain/documents.js";
import { ModelService, NotFound } from "../domain/models.js";
import { QueryParseError, type Arg, type FilterName, type FilterNode, type Path } from "./filterParser.js";
import { visibleVersionsSql, type RefScope } from "./visible.js";

export type { RefScope };

export interface SearchParams {
  filters: FilterNode[];
  /** Raw `orderings` param, e.g. `[my.product.price desc,my.product.title]`. */
  orderings?: string;
  page: number;
  pageSize: number;
  /** Document id cursor: results that follow it in the effective ordering. */
  after?: string;
  /** Locale code, or `*` for all locales. */
  lang: string;
}

/** A visible document version with its envelope fields (rendering happens elsewhere). */
export interface VersionRow {
  id: string;
  uid: string | null;
  type: string;
  lang: string;
  tags: string[];
  groupId: string;
  firstPublicationDate: Date | null;
  lastPublicationDate: Date | null;
  versionId: string;
  data: StoredData;
}

export const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

const fail = (message: string): never => {
  throw new QueryParseError(message, 1, 1);
};

// ---- field model --------------------------------------------------------------------------------------------

type FieldModel = { type: string; config?: Record<string, unknown> };
type Kind = "uid" | "text" | "select" | "number" | "date" | "timestamp" | "boolean" | "richtext" | "geo" | "cr" | "link" | "color" | "none";

function kindOf(f: FieldModel): Kind {
  const cfg = f.config ?? {};
  switch (f.type) {
    case "UID": return "uid";
    case "Text": return "text";
    case "Select": return "select";
    case "Number":
    case "Range": return "number";
    case "Date": return "date";
    case "Timestamp": return "timestamp";
    case "Boolean": return "boolean";
    case "StructuredText": return "richtext";
    case "GeoPoint": return "geo";
    case "Color": return "color";
    case "Link": {
      const cts = cfg.customtypes;
      return cfg.select === "document" || (Array.isArray(cts) && cts.length > 0) ? "cr" : "link";
    }
    default: return "none";
  }
}

const DATE_FILTERS = new Set<FilterName>([
  "date.after", "date.before", "date.between", "date.day-of-month", "date.day-of-month-after", "date.day-of-month-before",
  "date.day-of-week", "date.day-of-week-after", "date.day-of-week-before", "date.month", "date.month-after",
  "date.month-before", "date.year", "date.hour", "date.hour-after", "date.hour-before",
]);
const set = (...xs: FilterName[]) => new Set<FilterName>(xs);
/** R1§4.3 path/field-type compatibility matrix (`my.T.f` paths; document paths are checked by the parser). */
const MATRIX: Record<Kind, Set<FilterName>> = {
  uid: set("at", "not", "any", "in", "fulltext", "has", "missing"),
  text: set("at", "not", "any", "fulltext", "has", "missing"),
  select: set("at", "not", "any", "fulltext", "has", "missing"),
  number: set("at", "not", "any", "has", "missing", "number.lt", "number.gt", "number.inRange"),
  date: set("at", "not", "any", "has", "missing", ...DATE_FILTERS),
  timestamp: set("has", "missing", ...DATE_FILTERS),
  cr: set("at", "not", "any", "has", "missing"),
  boolean: set("at", "not", "has", "missing"),
  richtext: set("fulltext", "has", "missing"),
  geo: set("has", "missing", "geopoint.near"),
  color: set("has", "missing"),
  link: set("has", "missing"),
  none: set(),
};

/** Resolved `my.T.f[.sub]` path. */
interface FieldTarget {
  typeId: string;
  label: string;
  field: string;
  sub?: string;
  model: FieldModel;
  kind: Kind;
}

class Models {
  private cache = new Map<string, Map<string, FieldModel> | null>();
  private svc: ModelService;
  constructor(sql: Sql, private repoId: string) {
    this.svc = new ModelService(sql);
  }

  async resolve(path: Extract<Path, { kind: "field" }>): Promise<FieldTarget> {
    const label = `my.${path.type}.${path.field}${path.sub ? `.${path.sub}` : ""}`;
    const fields = await this.fields(path.type);
    if (!fields) return fail(`unknown custom type '${path.type}' in path '${label}'`);
    const top = fields.get(path.field);
    if (!top) return fail(`unknown field '${path.field}' in path '${label}'`);
    if (path.sub === undefined) return { typeId: path.type, label, field: path.field, model: top, kind: kindOf(top) };
    const subs = (top.type === "Group" ? (top.config?.fields ?? {}) : {}) as Record<string, FieldModel>;
    const sub = Object.prototype.hasOwnProperty.call(subs, path.sub) ? subs[path.sub] : undefined;
    if (!sub) return fail(`unknown field '${path.sub}' in path '${label}'`);
    return { typeId: path.type, label, field: path.field, sub: path.sub, model: sub, kind: kindOf(sub) };
  }

  private async fields(typeId: string): Promise<Map<string, FieldModel> | null> {
    if (!this.cache.has(typeId)) {
      try {
        const ct = (await this.svc.getType(this.repoId, typeId)) as unknown as CustomType;
        this.cache.set(typeId, flattenFields(ct) as unknown as Map<string, FieldModel>);
      } catch (e) {
        if (!(e instanceof NotFound)) throw e;
        this.cache.set(typeId, null);
      }
    }
    return this.cache.get(typeId)!;
  }
}

// ---- argument coercion --------------------------------------------------------------------------------------

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function badArg(name: string, v: Arg, what: string): never {
  return fail(`invalid argument ${JSON.stringify(v)} for filter '${name}': ${what} expected`);
}

function intArg(name: string, v: Arg, min: number, max: number, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return badArg(name, v, what);
  return n;
}

/** Weekday / month: full or 3-letter name in any casing, or its 1-based number. */
function namedArg(name: string, v: Arg, names: string[], what: string): number {
  if (typeof v === "string" && !/^\d+$/.test(v.trim())) {
    const s = v.trim().toLowerCase();
    const i = names.findIndex((n) => n === s || n.slice(0, 3) === s);
    return i < 0 ? badArg(name, v, what) : i + 1;
  }
  return intArg(name, v, 1, names.length, what);
}

/** `YYYY-MM-DD` (UTC midnight), ISO 8601 with offset, or epoch milliseconds. Returns an ISO string. */
function dateArg(name: string, v: Arg): string {
  const what = "date (YYYY-MM-DD, ISO 8601 with offset or epoch milliseconds)";
  let ms = NaN;
  if (typeof v === "number") ms = v;
  else if (typeof v === "string") {
    const s = v.trim();
    let m: RegExpExecArray | null;
    if (/^-?\d+$/.test(s)) ms = Number(s);
    else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      ms = Date.UTC(y, mo - 1, d);
      const back = new Date(ms);
      if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) ms = NaN;
    } else if ((m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|([+-]\d{2}):?(\d{2}))$/.exec(s))) {
      ms = Date.parse(`${m[1]}${m[2] === "Z" ? "Z" : `${m[3]}:${m[4]}`}`);
    }
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return badArg(name, v, what);
  return new Date(ms).toISOString();
}

const strArg = (name: string, v: Arg): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : badArg(name, v, "string");
const numArg = (name: string, v: Arg): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : badArg(name, v, "number");
};
const boolArg = (name: string, v: Arg): boolean =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : badArg(name, v, "boolean");
const arrArg = (name: string, v: Arg): Arg[] => (Array.isArray(v) ? v : badArg(name, v, "array"));

// ---- compilation --------------------------------------------------------------------------------------------

interface OrderKey { expr: Fragment; desc: boolean }

class Compiler {
  readonly where: Fragment[] = [];
  readonly implicitOrder: OrderKey[] = [];
  readonly ctes: Fragment[] = [];
  private models: Models;

  constructor(private sql: Sql, repoId: string) {
    this.models = new Models(sql, repoId);
  }

  // JSON accessors over a jsonb expression `j`.
  private txt = (j: Fragment) => this.sql`(${j} #>> '{}')`;
  private num = (j: Fragment) => this.sql`(case when jsonb_typeof(${j}) = 'number' then (${j} #>> '{}')::numeric end)`;
  private ts = (j: Fragment) => this.sql`smaltic_ts(${j} #>> '{}')`;
  private bool = (j: Fragment) => this.sql`(case when jsonb_typeof(${j}) = 'boolean' then (${j} #>> '{}')::boolean end)`;
  private arr = (j: Fragment) => this.sql`(case when jsonb_typeof(${j}) = 'array' then ${j} else '[]'::jsonb end)`;
  private richText = (j: Fragment) =>
    this.sql`(select string_agg(b.value ->> 'text', ' ') from jsonb_array_elements(${this.arr(j)}) as b(value))`;
  private linkId = (j: Fragment, id: string) =>
    this.sql`(case when jsonb_typeof(${j}) = 'array'
      then exists (select 1 from jsonb_array_elements(${j}) as l(value) where l.value ->> 'link_type' = 'Document' and l.value ->> 'id' = ${id}::text)
      else ${j} ->> 'link_type' = 'Document' and ${j} ->> 'id' = ${id}::text end)`;

  /** `pred` over the field value; for group sub-fields, true when any group item matches. Never null. */
  private each(t: FieldTarget, pred: (j: Fragment) => Fragment): Fragment {
    const sql = this.sql;
    if (t.kind === "uid") return sql`coalesce(${pred(sql`to_jsonb(v.uid)`)}, false)`;
    const top = sql`(v.data -> ${t.field}::text)`;
    if (t.sub === undefined) return sql`coalesce(${pred(top)}, false)`;
    return sql`exists (select 1 from jsonb_array_elements(${this.arr(top)}) as e(value)
      where coalesce(${pred(sql`(e.value -> ${t.sub}::text)`)}, false))`;
  }

  /** Scalar over the field value; the minimum over group items for sub-fields. */
  private minOf(t: FieldTarget, expr: (j: Fragment) => Fragment): Fragment {
    const sql = this.sql;
    const top = sql`(v.data -> ${t.field}::text)`;
    if (t.sub === undefined) return expr(top);
    return sql`(select min(${expr(sql`(e.value -> ${t.sub}::text)`)}) from jsonb_array_elements(${this.arr(top)}) as e(value))`;
  }

  private filled(kind: Kind, j: Fragment): Fragment {
    const sql = this.sql;
    switch (kind) {
      case "number": return sql`jsonb_typeof(${j}) = 'number'`;
      case "boolean": return sql`jsonb_typeof(${j}) = 'boolean'`;
      case "geo": return sql`jsonb_typeof(${j} -> 'latitude') = 'number' and jsonb_typeof(${j} -> 'longitude') = 'number'`;
      case "richtext":
        return sql`(jsonb_typeof(${j}) = 'array' and (jsonb_array_length(${j}) > 1
          or coalesce(${j} -> 0 ->> 'text', '') <> '' or (${j} -> 0 ->> 'type') in ('image', 'embed')))`;
      case "cr":
      case "link":
        return sql`(case when jsonb_typeof(${j}) = 'array' then jsonb_array_length(${j}) > 0
          else coalesce(${j} ->> 'link_type', 'Any') <> 'Any' end)`;
      default: return sql`(jsonb_typeof(${j}) = 'string' and (${j} #>> '{}') <> '')`;
    }
  }

  private haversine(j: Fragment, lat: number, lng: number): Fragment {
    const sql = this.sql;
    const la = sql`(case when jsonb_typeof(${j} -> 'latitude') = 'number' then (${j} ->> 'latitude')::float8 end)`;
    const lo = sql`(case when jsonb_typeof(${j} -> 'longitude') = 'number' then (${j} ->> 'longitude')::float8 end)`;
    return sql`(2 * 6371 * asin(least(1, sqrt(
      power(sin(radians(${la} - ${lat}::float8) / 2), 2)
      + cos(radians(${lat}::float8)) * cos(radians(${la})) * power(sin(radians(${lo} - ${lng}::float8) / 2), 2)))))`;
  }

  /** Equality with one value, typed by the field kind. */
  private eq(name: string, t: FieldTarget, v: Arg): (j: Fragment) => Fragment {
    const sql = this.sql;
    switch (t.kind) {
      case "number": { const n = numArg(name, v); return (j) => sql`${this.num(j)} = ${n}::numeric`; }
      case "date": { const d = dateArg(name, v); return (j) => sql`${this.ts(j)} = ${d}::timestamptz`; }
      case "boolean": { const b = boolArg(name, v); return (j) => sql`${this.bool(j)} = ${b}::boolean`; }
      case "cr": { const id = strArg(name, v); return (j) => this.linkId(j, id); }
      default: { const s = strArg(name, v); return (j) => sql`${this.txt(j)} = ${s}::text`; }
    }
  }

  async filter(f: FilterNode): Promise<void> {
    const sql = this.sql;
    if (f.name === "similar") return this.similar(f);
    const path = f.path!;
    if (path.kind === "document") return this.fulltext(f, null);
    if (path.kind === "meta") return this.meta(f, path.field);
    const t = await this.models.resolve(path);
    if (!MATRIX[t.kind].has(f.name)) {
      return fail(`unsupported filter '${f.name}' for field '${t.label}' of type ${t.model.type}`);
    }
    this.where.push(sql`v.type = ${t.typeId}::text`);
    const [a0, a1, a2] = f.args as [Arg, Arg, Arg];
    switch (f.name) {
      case "at": this.where.push(this.each(t, this.eq(f.name, t, a0))); return;
      case "not": this.where.push(sql`not ${this.each(t, this.eq(f.name, t, a0))}`); return;
      case "any": {
        const preds = arrArg(f.name, a0).map((v) => this.eq(f.name, t, v));
        this.where.push(preds.length ? this.each(t, (j) => join(sql, preds.map((p) => p(j)), sql` or `, true)) : sql`false`);
        return;
      }
      case "in": { // uid only (matrix)
        const list = arrArg(f.name, a0).map((v) => strArg(f.name, v));
        this.where.push(sql`v.uid = any(${list}::text[])`);
        this.implicitOrder.push({ expr: sql`array_position(${list}::text[], v.uid)`, desc: false });
        return;
      }
      case "fulltext": return this.fulltext(f, t);
      case "has": this.where.push(this.each(t, (j) => this.filled(t.kind, j))); return;
      case "missing": this.where.push(sql`not ${this.each(t, (j) => this.filled(t.kind, j))}`); return;
      case "geopoint.near": {
        const [lat, lng, radius] = [numArg(f.name, a0), numArg(f.name, a1), numArg(f.name, a2)];
        this.where.push(this.each(t, (j) => sql`${this.haversine(j, lat, lng)} <= ${radius}::float8`));
        this.implicitOrder.push({ expr: this.minOf(t, (j) => this.haversine(j, lat, lng)), desc: false });
        return;
      }
      case "number.lt": { const n = numArg(f.name, a0); this.where.push(this.each(t, (j) => sql`${this.num(j)} < ${n}::numeric`)); return; }
      case "number.gt": { const n = numArg(f.name, a0); this.where.push(this.each(t, (j) => sql`${this.num(j)} > ${n}::numeric`)); return; }
      case "number.inRange": {
        const [lo, hi] = [numArg(f.name, a0), numArg(f.name, a1)];
        this.where.push(this.each(t, (j) => sql`${this.num(j)} between ${lo}::numeric and ${hi}::numeric`));
        return;
      }
      default: {
        const pred = this.datePred(f);
        this.where.push(this.each(t, (j) => pred(this.ts(j))));
        return;
      }
    }
  }

  private meta(f: FilterNode, field: string): void {
    const sql = this.sql;
    const a0 = f.args[0]!;
    if (field === "first_publication_date" || field === "last_publication_date") {
      const pred = this.datePred(f);
      this.where.push(sql`coalesce(${pred(sql`v.${sql(field)}`)}, false)`);
      return;
    }
    if (field === "tags") {
      const list = Array.isArray(a0) ? a0.map((v) => strArg(f.name, v)) : [strArg(f.name, a0)];
      if (f.name === "at") this.where.push(sql`v.tags @> ${list}::text[]`);
      else if (f.name === "not") this.where.push(sql`not (v.tags && ${list}::text[])`);
      else this.where.push(sql`v.tags && ${list}::text[]`); // any
      return;
    }
    const col = sql`v.${sql(field)}`; // id | type
    switch (f.name) {
      case "at": this.where.push(sql`${col} = ${strArg(f.name, a0)}::text`); return;
      case "not": this.where.push(sql`${col} <> ${strArg(f.name, a0)}::text`); return;
      case "any": this.where.push(sql`${col} = any(${arrArg(f.name, a0).map((v) => strArg(f.name, v))}::text[])`); return;
      case "in": {
        const list = arrArg(f.name, a0).map((v) => strArg(f.name, v));
        this.where.push(sql`${col} = any(${list}::text[])`);
        this.implicitOrder.push({ expr: sql`array_position(${list}::text[], ${col})`, desc: false });
        return;
      }
      default: return fail(`unsupported filter '${f.name}' for path 'document.${field}'`);
    }
  }

  /** Date filter predicate over a timestamptz expression; parts are taken in UTC. */
  private datePred(f: FilterNode): (t: Fragment) => Fragment {
    const sql = this.sql;
    const [a0, a1] = f.args as [Arg, Arg];
    const part = (unit: "day" | "isodow" | "month" | "year" | "hour", t: Fragment) =>
      sql`extract(${sql.unsafe(unit)} from (${t}) at time zone 'UTC')`;
    const cmp = (unit: "day" | "isodow" | "month" | "hour", n: number, op: "=" | ">" | "<") =>
      (t: Fragment) => sql`${part(unit, t)} ${sql.unsafe(op)} ${n}::numeric`;
    const opOf = (name: string): "=" | ">" | "<" => (name.endsWith("-after") ? ">" : name.endsWith("-before") ? "<" : "=");
    const name = f.name;
    switch (name) {
      case "date.after": { const d = dateArg(name, a0); return (t) => sql`${t} > ${d}::timestamptz`; }
      case "date.before": { const d = dateArg(name, a0); return (t) => sql`${t} < ${d}::timestamptz`; }
      case "date.between": {
        const [d1, d2] = [dateArg(name, a0), dateArg(name, a1)];
        return (t) => sql`${t} between ${d1}::timestamptz and ${d2}::timestamptz`;
      }
      case "date.year": { const y = intArg(name, a0, -9999, 9999, "year"); return (t) => sql`${part("year", t)} = ${y}::numeric`; }
      default: break;
    }
    if (name.startsWith("date.day-of-month")) return cmp("day", intArg(name, a0, 1, 31, "day of month (1-31)"), opOf(name));
    if (name.startsWith("date.day-of-week")) return cmp("isodow", namedArg(name, a0, WEEKDAYS, "weekday (monday..sunday or 1-7)"), opOf(name));
    if (name.startsWith("date.month")) return cmp("month", namedArg(name, a0, MONTHS, "month (january..december or 1-12)"), opOf(name));
    if (name.startsWith("date.hour")) return cmp("hour", intArg(name, a0, 0, 23, "hour (0-23)"), opOf(name));
    return fail(`unsupported filter '${name}'`);
  }

  private fulltext(f: FilterNode, t: FieldTarget | null): void {
    const sql = this.sql;
    const q = searchQuery(sql, strArg(f.name, f.args[0]!));
    if (t === null) {
      this.where.push(sql`(v.search_a || v.search_b) @@ ${q}`);
    } else {
      const text = (j: Fragment) => (t.kind === "richtext" ? this.richText(j) : this.txt(j));
      this.where.push(this.each(t, (j) => sql`${searchVector(sql, text(j))} @@ ${q}`));
    }
    // Relevance over the whole document: weight A (headings, titles, UID, key text) above B.
    this.implicitOrder.push({ expr: sql`ts_rank(setweight(v.search_a, 'A') || setweight(v.search_b, 'B'), ${q})`, desc: true });
  }

  /**
   * similar(id, max): the source document's lexemes whose document frequency (over the visible set) is <= max;
   * other documents rank by how many of them they share.
   */
  private similar(f: FilterNode): void {
    const sql = this.sql;
    const id = strArg(f.name, f.args[0]!);
    const max = numArg(f.name, f.args[1]!);
    const name = sql(`similar_${this.ctes.length}`);
    this.ctes.push(sql`${name} as (select array(
      select l.lex from vis o cross join lateral unnest(tsvector_to_array(o.search_a || o.search_b)) as l(lex)
      where l.lex = any(array(select unnest(tsvector_to_array(s.search_a || s.search_b)) from vis s where s.id = ${id}::text))
      group by l.lex having count(*) <= ${max}::numeric) as terms)`);
    const score = sql`(select count(*) from unnest(tsvector_to_array(v.search_a || v.search_b)) as x(lex)
      where x.lex = any(coalesce((select terms from ${name}), '{}'::text[])))`;
    this.where.push(sql`v.id <> ${id}::text and ${score} > 0`);
    this.implicitOrder.push({ expr: score, desc: true });
  }

  /** `[path( asc| desc)?, ...]` on document dates/id/type and sortable `my.T.f` fields. */
  async orderings(raw: string): Promise<OrderKey[]> {
    const sql = this.sql;
    const m = /^\s*\[([\s\S]*)\]\s*$/.exec(raw);
    if (!m) return fail(`invalid orderings '${raw}'`);
    const out: OrderKey[] = [];
    for (const item of m[1]!.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
      const im = /^([A-Za-z0-9_.-]+)(?:\s+(asc|desc))?$/i.exec(item);
      if (!im) return fail(`invalid ordering '${item}' in orderings '${raw}'`);
      const desc = (im[2] ?? "asc").toLowerCase() === "desc";
      const parts = im[1]!.split(".");
      if (parts[0] === "document" && parts.length === 2
        && ["first_publication_date", "last_publication_date", "id", "type"].includes(parts[1]!)) {
        out.push({ expr: sql`v.${sql(parts[1]!)}`, desc });
        continue;
      }
      if (parts[0] !== "my" || parts.length !== 3) return fail(`invalid ordering path '${im[1]}'`);
      const t = await this.models.resolve({ kind: "field", type: parts[1]!, field: parts[2]! });
      const j = sql`(v.data -> ${t.field}::text)`;
      let expr: Fragment;
      switch (t.kind) {
        case "uid": expr = sql`v.uid`; break;
        case "text": case "select": expr = this.txt(j); break;
        case "richtext": expr = sql`(case when jsonb_typeof(${j}) = 'array' then ${j} -> 0 ->> 'text' end)`; break;
        case "number": expr = this.num(j); break;
        case "date": case "timestamp": expr = this.ts(j); break;
        case "boolean": expr = this.bool(j); break;
        default: return fail(`unsupported ordering on field '${t.label}' of type ${t.model.type}`);
      }
      out.push({ expr: sql`(case when v.type = ${t.typeId}::text then ${expr} end)`, desc });
    }
    return out;
  }
}

function join(sql: Sql, parts: Fragment[], sep: Fragment, paren = false): Fragment {
  const joined = parts.reduce((acc, p) => sql`${acc}${sep}${p}`);
  return paren ? sql`(${joined})` : joined;
}

const clamp = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;

export async function search(sql: Sql, repoId: string, scope: RefScope, params: SearchParams): Promise<{ total: number; rows: VersionRow[] }> {
  const pageSize = clamp(params.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const page = clamp(params.page, 1, Number.MAX_SAFE_INTEGER, 1);

  const c = new Compiler(sql, repoId);
  for (const f of params.filters) await c.filter(f);
  if (params.lang !== "*") c.where.push(sql`v.lang = ${params.lang}::text`);

  const explicit = params.orderings?.trim() ? await c.orderings(params.orderings) : [];
  const keys: OrderKey[] = explicit.length ? explicit
    : c.implicitOrder.length ? c.implicitOrder
    : [{ expr: sql`v.last_publication_date`, desc: true }];

  const col = (i: number) => sql(`_o${i}`);
  const orderCols = keys.map((k, i) => sql`, ${k.expr} as ${col(i)}`);
  const windowOrder = join(sql, [
    ...keys.map((k, i) => sql`${col(i)} ${k.desc ? sql`desc` : sql`asc`} nulls last`),
    sql`f.id asc`,
  ], sql`, `);
  const where = c.where.length ? join(sql, c.where.map((w) => sql`(${w})`), sql` and `) : sql`true`;
  const ctes = c.ctes.length ? sql`, ${join(sql, c.ctes, sql`, `)}` : sql``;

  const rows = await sql`
    with vis as (
      select d.id, d.type, d.lang, d.group_id, d.first_publication_date, d.last_publication_date,
        ver.id as version_id, ver.uid, ver.tags, ver.data, ver.search_a, ver.search_b
      from (${visibleVersionsSql(sql, repoId, scope)}) x
      join documents d on d.id = x.document_id
      join document_versions ver on ver.id = x.version_id
      where d.repo_id = ${repoId}::text
    )${ctes},
    filtered as (select v.* ${orderCols} from vis v where ${where}),
    ordered as (select f.*, row_number() over (order by ${windowOrder}) as rn from filtered f),
    cursor_pos as (select coalesce((select rn from ordered where id = ${params.after ?? null}::text), 0) as rn)
    select (select count(*) from ordered)::int as total,
      o.id, o.uid, o.type, o.lang, o.tags, o.group_id, o.first_publication_date, o.last_publication_date, o.version_id, o.data
    from (select 1) as one
    left join lateral (
      select * from ordered where rn > (select rn from cursor_pos) order by rn
      offset ${(page - 1) * pageSize}::bigint limit ${pageSize}::int
    ) o on true`;

  const total = rows.length ? Number(rows[0]!.total) : 0;
  return {
    total,
    rows: rows.filter((r) => r.id !== null).map((r) => ({
      id: r.id,
      uid: r.uid,
      type: r.type,
      lang: r.lang,
      tags: r.tags,
      groupId: r.group_id,
      firstPublicationDate: r.first_publication_date,
      lastPublicationDate: r.last_publication_date,
      versionId: String(r.version_id),
      data: r.data,
    })),
  };
}
