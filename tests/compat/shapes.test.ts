import {
  asDate,
  asHTML,
  asImageSrc,
  asLink,
  asLinkAttrs,
  asText,
  createClient,
  isFilled,
  mapSliceZone,
} from "@prismicio/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ctx, documentAPIEndpoint } from "./context.js";

const c = ctx();
const client = createClient(c.repo, { documentAPIEndpoint: documentAPIEndpoint(c), fetch });

let full: Record<string, any>;
let empty: Record<string, any>;
beforeAll(async () => {
  full = (await client.getByUID("kitchen_sink", "full")).data as Record<string, any>;
  empty = (await client.getByUID("kitchen_sink", "empty")).data as Record<string, any>;
});

/**
 * For each field type: the `isFilled` helper of the official client, the field id in the fixture,
 * the empty value Smaltic must render (R2 §2.20) and the requirement ids.
 */
const fields: Array<{ req: string; helper: keyof typeof isFilled; field: string; emptyValue: unknown; pick?: (d: Record<string, any>) => unknown }> = [
  { req: "REQ-FLD-010~", helper: "title", field: "title", emptyValue: [] },
  { req: "REQ-FLD-010~", helper: "richText", field: "body", emptyValue: [] },
  { req: "REQ-FLD-013~ REQ-SDK-024", helper: "image", field: "image", emptyValue: {} },
  { req: "REQ-FLD-014~", helper: "imageThumbnail", field: "image.mobile", emptyValue: undefined, pick: (d) => d.image?.mobile },
  { req: "REQ-FLD-016~ REQ-SDK-026", helper: "link", field: "link", emptyValue: { link_type: "Any" } },
  { req: "REQ-FLD-016~", helper: "repeatable", field: "links", emptyValue: [] },
  { req: "REQ-FLD-020~ REQ-SDK-026", helper: "linkToMedia", field: "media", emptyValue: { link_type: "Media" } },
  { req: "REQ-FLD-017~", helper: "contentRelationship", field: "rel", emptyValue: { link_type: "Document" } },
  { req: "REQ-FLD-004", helper: "date", field: "date", emptyValue: null },
  { req: "REQ-FLD-004", helper: "timestamp", field: "ts", emptyValue: null },
  { req: "REQ-FLD-003", helper: "color", field: "color", emptyValue: null },
  { req: "REQ-FLD-005", helper: "number", field: "num", emptyValue: null },
  { req: "REQ-FLD-007", helper: "keyText", field: "text", emptyValue: null },
  { req: "REQ-FLD-006", helper: "select", field: "select", emptyValue: null },
  { req: "REQ-FLD-023~", helper: "embed", field: "embed", emptyValue: {} },
  { req: "REQ-FLD-025", helper: "geoPoint", field: "geo", emptyValue: {} },
  { req: "REQ-FLD-028", helper: "integrationField", field: "integ", emptyValue: null },
  { req: "REQ-FLD-030~", helper: "table", field: "table", emptyValue: null },
  { req: "REQ-FLD-029~", helper: "group", field: "group", emptyValue: [] },
  { req: "REQ-SDK-028", helper: "sliceZone", field: "slices", emptyValue: [] },
];

describe("isFilled.* on Smaltic values (filled and empty)", () => {
  for (const f of fields) {
    it(`REQ-FLD-001~ ${f.req} isFilled.${String(f.helper)}: true when filled, false for the rendered empty value`, () => {
      const get = f.pick ?? ((d: Record<string, any>) => d[f.field]);
      const fn = isFilled[f.helper] as (v: unknown) => boolean;
      expect(fn(get(full)), `filled ${f.field}`).toBe(true);
      expect(get(empty), `empty ${f.field}`).toEqual(f.emptyValue);
      expect(fn(get(empty)), `empty ${f.field}`).toBe(false);
    });
  }

  it("REQ-FLD-002 Boolean is never null: false by default, default_value true honoured, true when set", () => {
    expect(full.flag).toBe(true);
    expect(empty.flag).toBe(false);
    expect(empty.flag_on).toBe(true);
  });

  it("REQ-FLD-006 an empty Select returns its default_value", () => {
    expect(empty.select_def).toBe("two");
  });

  it("REQ-FLD-001~ every model field is present on the empty document", () => {
    for (const f of fields.filter((x) => !x.pick)) expect(empty, f.field).toHaveProperty(f.field);
  });
});

describe("Field shapes", () => {
  it("REQ-FLD-013~ REQ-SDK-024 image: url, dimensions, alt, copyright, id, edit; the URL is absolute and served", async () => {
    expect(full.image).toMatchObject({ id: c.assetId, alt: "Main image", dimensions: { width: 4, height: 3 }, edit: { x: 0, y: 0, zoom: 1, background: "transparent" } });
    expect(full.image).toHaveProperty("copyright");
    expect(full.image.url).toMatch(/^https?:\/\//);
    expect(full.image.mobile).toMatchObject({ id: c.assetId, dimensions: { width: expect.any(Number), height: expect.any(Number) } });
    expect(full.image.mobile.url).toMatch(/^https?:\/\//);
    const res = await fetch(asImageSrc(full.image)!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\//);
  });

  it("REQ-FLD-020~ link to media: kind image, string size/width/height", () => {
    expect(full.media).toMatchObject({ link_type: "Media", id: c.assetId, kind: "image", name: "blue.png", width: "4", height: "3" });
    expect(typeof full.media.size).toBe("string");
  });

  it("REQ-FLD-016~ REQ-SDK-026 web link keeps target; asLinkAttrs adds rel for external links", () => {
    expect(full.link).toMatchObject({ link_type: "Web", url: "https://example.org", target: "_blank" });
    expect(asLinkAttrs(full.link)).toMatchObject({ href: "https://example.org", target: "_blank", rel: "noreferrer" });
    expect(full.links[0]).toMatchObject({ link_type: "Web", url: "https://example.com" });
    expect(full.links[0].key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("REQ-FLD-030~ table: head?/body rows with keyed cells", () => {
    expect(full.table.body.rows[0].cells[0]).toMatchObject({ type: "data", content: [{ type: "paragraph", text: "cell" }] });
    expect(full.table.body.rows[0].key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("REQ-SDK-028 REQ-MOD-007~ shared slice: id <type>$<uuid>, slice_label null, variation, version, primary, items", () => {
    const s = full.slices[0];
    expect(s).toMatchObject({ slice_type: "text_block", slice_label: null, variation: "default", version: "initial", items: [] });
    expect(s.id).toMatch(/^text_block\$[0-9a-f-]{36}$/);
    expect(s.primary.text[0].text).toBe("Slice text");
  });

  it("REQ-SDK-025~ REQ-FLD-010~ rich text helpers: asText, asHTML (spans, list, image block)", () => {
    expect(asText(full.title)).toBe("Everything filled");
    const html = asHTML(full.body);
    expect(html).toContain("<h2>Section</h2>");
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain('<a href="https://example.org"');
    expect(html).toContain("<ul><li>Item</li></ul>");
    expect(html).toMatch(/<img src="https?:\/\/[^"]+" alt="Inline"/);
  });

  it("REQ-FLD-004 REQ-SDK-027 asDate on Date and Timestamp values", () => {
    expect(full.date).toBe("2024-02-29");
    expect(full.ts).toBe("2024-02-29T12:34:56+0000");
    expect(asDate(full.date)!.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(asDate(full.ts)!.toISOString()).toBe("2024-02-29T12:34:56.000Z");
  });

  it("REQ-FLD-017~ asLink on a content relationship resolves via its url (null without routes)", async () => {
    expect(full.rel).toMatchObject({ link_type: "Document", id: c.ids["page:home"], uid: "home" });
    expect(asLink(full.rel, { linkResolver: (l) => `/x/${l.uid}` })).toBe("/x/home");
  });

  it("REQ-SDK-028 mapSliceZone maps a fetched slice zone", async () => {
    const mapped = await mapSliceZone(full.slices, { text_block: ({ slice }: { slice: any }) => ({ text: asText(slice.primary.text) }) });
    expect(mapped).toEqual([expect.objectContaining({ __mapped: true, id: full.slices[0].id, slice_type: "text_block", text: "Slice text" })]);
  });

  it.todo("REQ-SDK-023 REQ-MED-005 asImageSrc/asImageWidthSrcSet/asImagePixelDensitySrcSet transforms (w, dpr, rect) change output dimensions <reason: Plan 2 image CDN>");
});

