// Hand-written recursive-descent parser for the Prismic filter (predicate) language.
// Error messages reproduce the live API format exactly.

export type FilterName =
  | "at" | "not" | "any" | "in" | "fulltext" | "has" | "missing" | "similar"
  | "geopoint.near" | "number.lt" | "number.gt" | "number.inRange"
  | "date.after" | "date.before" | "date.between"
  | "date.day-of-month" | "date.day-of-month-after" | "date.day-of-month-before"
  | "date.day-of-week" | "date.day-of-week-after" | "date.day-of-week-before"
  | "date.month" | "date.month-after" | "date.month-before"
  | "date.year" | "date.hour" | "date.hour-after" | "date.hour-before";

export type MetaField = "id" | "type" | "tags" | "first_publication_date" | "last_publication_date";

export type Path =
  | { kind: "document" }
  | { kind: "meta"; field: MetaField }
  | { kind: "field"; type: string; field: string; sub?: string };

// Booleans are accepted too (e.g. `not(my.p.flag, true)` from the SDK helpers).
export type Arg = string | number | boolean | Arg[];

export interface FilterNode {
  name: FilterName;
  path: Path | null;
  args: Arg[];
}

export class QueryParseError extends Error {
  readonly pos: { line: number; column: number; id: 0; location: "query" };
  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "QueryParseError";
    this.pos = { line, column, id: 0, location: "query" };
  }
}

type Kind = "path" | "string" | "number" | "boolean" | "array" | "any";
interface Spec { path: boolean; args: Kind[] }

const DATE_ARG: Kind = "any"; // string (ISO / name) or number (epoch ms / ordinal)
const dates: Record<string, Spec> = {};
for (const n of ["after", "before", "day-of-month", "day-of-month-after", "day-of-month-before",
  "day-of-week", "day-of-week-after", "day-of-week-before", "month", "month-after", "month-before",
  "year", "hour", "hour-after", "hour-before"]) dates[`date.${n}`] = { path: true, args: [DATE_ARG] };
dates["date.between"] = { path: true, args: [DATE_ARG, DATE_ARG] };

const SPECS: Record<string, Spec> = {
  at: { path: true, args: ["any"] },
  not: { path: true, args: ["any"] },
  any: { path: true, args: ["array"] },
  in: { path: true, args: ["array"] },
  fulltext: { path: true, args: ["string"] },
  has: { path: true, args: [] },
  missing: { path: true, args: [] },
  similar: { path: false, args: ["string", "number"] },
  "geopoint.near": { path: true, args: ["number", "number", "number"] },
  "number.lt": { path: true, args: ["number"] },
  "number.gt": { path: true, args: ["number"] },
  "number.inRange": { path: true, args: ["number", "number"] },
  ...dates,
};
const ALIASES: Record<string, string> = { lt: "number.lt", gt: "number.gt" };

const META: MetaField[] = ["id", "type", "tags", "first_publication_date", "last_publication_date"];
const DOC_MATRIX: Record<string, (n: string) => boolean> = {
  document: (n) => n === "fulltext",
  tags: (n) => ["at", "not", "any"].includes(n),
  type: (n) => ["at", "not", "any"].includes(n),
  id: (n) => ["at", "not", "any", "in"].includes(n),
  first_publication_date: (n) => n.startsWith("date."),
  last_publication_date: (n) => n.startsWith("date."),
};

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isIdent = (c: string | undefined) => !!c && /[A-Za-z0-9_.\-]/.test(c);

class Parser {
  private i = 0;
  constructor(private readonly q: string) {}

  fail(index: number, desc: string): never {
    let line = 1, col = 1;
    for (let k = 0; k < index && k < this.q.length; k++) {
      if (this.q[k] === "\n") { line++; col = 1; } else col++;
    }
    const message = `${desc} on line:${line} col:${col} in query '${this.q}'\n${this.q}\n${" ".repeat(col - 1)}^\n`;
    throw new QueryParseError(message, line, col);
  }

  private ws() { while (this.i < this.q.length && isWs(this.q[this.i]!)) this.i++; }
  private found(): string { return this.i < this.q.length ? `'${this.q[this.i]}'` : "end of input"; }
  private expect(ch: string) {
    this.ws();
    if (this.q[this.i] !== ch) this.fail(this.i, `'${ch}' expected but ${this.found()} found`);
    this.i++;
  }

  parseAll(): FilterNode[] {
    const out: FilterNode[] = [];
    this.ws();
    if (this.i >= this.q.length) this.fail(this.i, "'[' expected but end of input found");
    while (this.i < this.q.length) {
      this.expect("[");
      this.ws();
      if (this.q[this.i] === "[") {
        while (this.q[this.i] === "[") {
          this.i++;
          out.push(this.filter());
          this.expect("]");
          this.ws();
        }
      } else {
        out.push(this.filter());
      }
      this.expect("]");
      this.ws();
    }
    return out;
  }

  private filter(): FilterNode {
    this.ws();
    if (this.q[this.i] === ":") { // binding form  :d = at(...)
      this.i++;
      const s = this.i;
      while (isIdent(this.q[this.i])) this.i++;
      if (this.i === s) this.fail(this.i, `identifier expected but ${this.found()} found`);
      this.expect("=");
      this.ws();
    }
    const start = this.i;
    while (isIdent(this.q[this.i])) this.i++;
    const raw = this.q.slice(start, this.i);
    if (!raw) this.fail(start, `identifier expected but ${this.found()} found`);
    const name = ALIASES[raw] ?? raw;
    const spec = Object.prototype.hasOwnProperty.call(SPECS, name) ? SPECS[name]! : undefined;
    if (!spec) this.fail(start, `unrecognized attribute '${raw}'`);
    this.expect("(");

    let path: Path | null = null;
    const args: Arg[] = [];
    this.ws();
    if (spec.path) {
      const ps = this.i;
      path = this.path(name);
      void ps;
    }
    const kinds = spec.args;
    for (let k = 0; k < kinds.length; k++) {
      if (k > 0 || spec.path) {
        this.ws();
        if (this.q[this.i] !== ",") {
          this.fail(this.i, `',' expected but ${this.found()} found`);
        }
        this.i++;
      }
      this.ws();
      const as = this.i;
      const v = this.value();
      this.checkKind(kinds[k]!, v, as);
      args.push(v);
    }
    this.ws();
    if (this.q[this.i] !== ")") this.fail(this.i, `')' expected but ${this.found()} found`);
    this.i++;
    return { name: name as FilterName, path, args };
  }

  private checkKind(kind: Kind, v: Arg, at: number) {
    if (kind === "any") return;
    const actual = Array.isArray(v) ? "array" : typeof v;
    if (actual !== kind) this.fail(at, `${kind} expected but ${actual} found`);
  }

  private path(filterName: string): Path {
    const start = this.i;
    while (isIdent(this.q[this.i])) this.i++;
    const raw = this.q.slice(start, this.i);
    if (!raw) this.fail(start, `path expected but ${this.found()} found`);
    const parts = raw.split(".");
    if (parts.some((p) => p === "")) this.fail(start, `invalid path '${raw}'`);
    if (parts[0] === "document") {
      let path: Path;
      let key: string;
      if (parts.length === 1) { path = { kind: "document" }; key = "document"; }
      else if (parts.length === 2 && (META as string[]).includes(parts[1]!)) {
        path = { kind: "meta", field: parts[1] as MetaField }; key = parts[1]!;
      } else this.fail(start, `unknown document attribute '${raw}'`);
      if (!DOC_MATRIX[key]!(filterName)) {
        this.fail(start, `predicate '${filterName}' cannot be applied to path '${raw}'`);
      }
      return path;
    }
    if (parts[0] === "my" && (parts.length === 3 || parts.length === 4)) {
      const [, type, field, sub] = parts as [string, string, string, string | undefined];
      return sub === undefined ? { kind: "field", type, field } : { kind: "field", type, field, sub };
    }
    return this.fail(start, `invalid path '${raw}'`);
  }

  private value(): Arg {
    this.ws();
    const c = this.q[this.i];
    if (c === undefined) this.fail(this.i, "value expected but end of input found");
    if (c === '"' || c === "'") return this.string(c);
    if (c === "[") {
      this.i++;
      const arr: Arg[] = [];
      this.ws();
      if (this.q[this.i] === "]") { this.i++; return arr; }
      for (;;) {
        arr.push(this.value());
        this.ws();
        if (this.q[this.i] === ",") { this.i++; continue; }
        if (this.q[this.i] === "]") { this.i++; return arr; }
        this.fail(this.i, `']' expected but ${this.found()} found`);
      }
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(\.\d+)?/.exec(this.q.slice(this.i));
      if (!m) this.fail(this.i, `number expected but ${this.found()} found`);
      this.i += m[0].length;
      return Number(m[0]);
    }
    const start = this.i;
    while (isIdent(this.q[this.i])) this.i++;
    const word = this.q.slice(start, this.i);
    if (word === "true") return true;
    if (word === "false") return false;
    return this.fail(start, word ? `unexpected '${word}'` : `unexpected ${this.found()}`);
  }

  private string(quote: string): string {
    const start = this.i;
    this.i++;
    let out = "";
    while (this.i < this.q.length) {
      const c = this.q[this.i]!;
      if (c === "\\" && this.i + 1 < this.q.length) { out += this.q[this.i + 1]; this.i += 2; continue; }
      if (c === quote) { this.i++; return out; }
      out += c;
      this.i++;
    }
    return this.fail(start, "unterminated string");
  }
}

export function parseQuery(q: string): FilterNode[] {
  return new Parser(q).parseAll();
}

export function parseQueries(qs: string[]): FilterNode[] {
  return qs.flatMap(parseQuery);
}
