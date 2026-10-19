import { describe, expect, it } from "vitest";
import { parseQuery, parseQueries, QueryParseError } from "../src/query/filterParser.js";

const doc = (field: string) => ({ kind: "meta", field });
const f = (type: string, field: string, sub?: string) => ({ kind: "field", type, field, ...(sub ? { sub } : {}) });

const cases: [string, string, unknown, unknown[]][] = [
  ['[at(document.type, "page")]', "at", doc("type"), ["page"]],
  ['[at(document.tags, ["a", "b"])]', "at", doc("tags"), [["a", "b"]]],
  ["[not(my.p.flag, true)]", "not", f("p", "flag"), [true]],
  ['[any(document.tags, ["a"])]', "any", doc("tags"), [["a"]]],
  ['[in(document.id, ["X", "Y"])]', "in", doc("id"), [["X", "Y"]]],
  ['[fulltext(document, "headless")]', "fulltext", { kind: "document" }, ["headless"]],
  ["[has(my.p.title)]", "has", f("p", "title"), []],
  ["[missing(my.p.title)]", "missing", f("p", "title"), []],
  ['[similar("ID", 10)]', "similar", null, ["ID", 10]],
  ["[geopoint.near(my.p.loc, 48.85, 2.35, 10)]", "geopoint.near", f("p", "loc"), [48.85, 2.35, 10]],
  ["[number.lt(my.p.n, 10)]", "number.lt", f("p", "n"), [10]],
  ["[number.gt(my.p.n, 10)]", "number.gt", f("p", "n"), [10]],
  ["[number.inRange(my.p.n, 1, 5)]", "number.inRange", f("p", "n"), [1, 5]],
  ['[date.after(my.p.d, "2024-01-01")]', "date.after", f("p", "d"), ["2024-01-01"]],
  ["[date.before(my.p.d, 1030545000000)]", "date.before", f("p", "d"), [1030545000000]],
  ["[date.between(my.p.d, 1, 2)]", "date.between", f("p", "d"), [1, 2]],
  ["[date.day-of-month(my.p.d, 3)]", "date.day-of-month", f("p", "d"), [3]],
  ["[date.day-of-month-after(my.p.d, 3)]", "date.day-of-month-after", f("p", "d"), [3]],
  ["[date.day-of-month-before(my.p.d, 3)]", "date.day-of-month-before", f("p", "d"), [3]],
  ['[date.day-of-week(my.p.d, "monday")]', "date.day-of-week", f("p", "d"), ["monday"]],
  ["[date.day-of-week-after(my.p.d, 1)]", "date.day-of-week-after", f("p", "d"), [1]],
  ['[date.day-of-week-before(my.p.d, "Sun")]', "date.day-of-week-before", f("p", "d"), ["Sun"]],
  ['[date.month(my.p.d, "january")]', "date.month", f("p", "d"), ["january"]],
  ["[date.month-after(my.p.d, 1)]", "date.month-after", f("p", "d"), [1]],
  ["[date.month-before(my.p.d, 12)]", "date.month-before", f("p", "d"), [12]],
  ["[date.year(my.p.d, 2024)]", "date.year", f("p", "d"), [2024]],
  ["[date.hour(my.p.d, 12)]", "date.hour", f("p", "d"), [12]],
  ["[date.hour-after(my.p.d, 12)]", "date.hour-after", f("p", "d"), [12]],
  ["[date.hour-before(document.last_publication_date, 12)]", "date.hour-before", doc("last_publication_date"), [12]],
];

describe("parseQuery", () => {
  it.each(cases)("parses %s (double and single bracket)", (filter, name, path, args) => {
    const expected = [{ name, path, args }];
    expect(parseQuery(`[${filter}]`)).toEqual(expected);
    expect(parseQuery(filter)).toEqual(expected);
  });

  it("covers all 28 wire names", () => {
    expect(new Set(cases.map((c) => c[1])).size).toBe(28);
  });

  it("accepts the binding form", () => {
    expect(parseQuery('[[:d = at(document.id, "X") ]]')).toEqual([
      { name: "at", path: doc("id"), args: ["X"] },
    ]);
  });

  it("accepts single quotes, escapes, numbers and nesting", () => {
    expect(parseQuery("[[date.month(my.p.d, 'May')]]")[0]!.args).toEqual(["May"]);
    expect(parseQuery('[[at(my.p.t, "say \\"hi\\"")]]')[0]!.args).toEqual(['say "hi"']);
    expect(parseQuery("[[at(my.p.t, 'it\\'s')]]")[0]!.args).toEqual(["it's"]);
    expect(parseQuery("[[geopoint.near(my.p.l, -48.85, 2.5, 10)]]")[0]!.args).toEqual([-48.85, 2.5, 10]);
    expect(parseQuery('[[at(my.p.t, [["a"], 1])]]')[0]!.args).toEqual([[["a"], 1]]);
  });

  it("parses sub-field paths", () => {
    expect(parseQuery('[[at(my.page.group.title, "x")]]')[0]!.path).toEqual(f("page", "group", "title"));
  });

  it("handles multiple filters and whitespace/newlines", () => {
    const r = parseQuery('[\n [at( document.type ,\n"a")]\n [ not(document.tags,["x"]) ]\n]');
    expect(r.map((n) => n.name)).toEqual(["at", "not"]);
    expect(parseQuery('[at(document.type,"a")]\n[at(document.id,"b")]')).toHaveLength(2);
    expect(parseQueries(['[[at(document.type,"a")]]', "[[has(my.p.t)]]"])).toHaveLength(2);
  });

  it("reproduces the live unknown-attribute error", () => {
    const q = '[[foo(document.type,"blog")]]';
    try {
      parseQuery(q);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QueryParseError);
      const err = e as QueryParseError;
      expect(err.message).toBe(
        `unrecognized attribute 'foo' on line:1 col:3 in query '${q}'\n${q}\n  ^\n`,
      );
      expect(err.pos).toEqual({ line: 1, column: 3, id: 0, location: "query" });
    }
  });

  it("reports syntax errors with position", () => {
    expect(() => parseQuery('[[at(document.type,"blog")')).toThrow(/^'\]' expected but end of input found on line:1 col:27/);
    expect(() => parseQuery('[[at(document.type,"blog"]]')).toThrow(/^'\)' expected but '\]' found on line:1 col:26/);
    expect(() => parseQuery('[[at(document.type,"blog)]]')).toThrow(/unterminated string/);
    expect(() => parseQuery("")).toThrow(QueryParseError);
    const e = (() => { try { parseQuery("[\n[at(document.type,]]"); } catch (x) { return x as QueryParseError; } })()!;
    expect(e.pos.line).toBe(2);
  });

  it("enforces the document path/filter matrix", () => {
    expect(() => parseQuery("[[number.lt(document.type, 1)]]")).toThrow(QueryParseError);
    expect(() => parseQuery('[[fulltext(document.type, "a")]]')).toThrow(QueryParseError);
    expect(() => parseQuery('[[at(document, "a")]]')).toThrow(QueryParseError);
    expect(() => parseQuery('[[date.after(document.id, "2024-01-01")]]')).toThrow(QueryParseError);
    expect(() => parseQuery("[[has(document.id)]]")).toThrow(QueryParseError);
    expect(() => parseQuery('[[at(document.foo, "a")]]')).toThrow(/unknown document attribute/);
    expect(() => parseQuery('[[similar(document.id, 10)]]')).toThrow(QueryParseError);
    expect(() => parseQuery('[[at(foo.bar, "a")]]')).toThrow(QueryParseError);
    expect(() => parseQuery('[[fulltext(my.p.title, "a")]]')).not.toThrow();
  });
});
