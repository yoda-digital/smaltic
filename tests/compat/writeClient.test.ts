import * as ct from "@prismicio/custom-types-client";
import {
  asHTML,
  createClient,
  createMigration,
  createWriteClient,
  ForbiddenError,
  NotFoundError,
  type CustomTypeModel,
  type SharedSliceModel,
} from "@prismicio/client";
import { htmlAsRichText } from "@prismicio/migrate";
import { describe, expect, it } from "vitest";
import { ctx, documentAPIEndpoint } from "./context.js";
import { h1, LOCALE, png } from "./seed.js";

// The official WriteClient throttles every request with a body to one per 1.5 s per host.
const SLOW = 180_000;

const c = ctx();
const freshReader = () => createClient(c.repo, { documentAPIEndpoint: documentAPIEndpoint(c), fetch });
const read = freshReader();
const typesClient = (token: string | undefined) =>
  ct.createClient({ endpoint: `${c.baseUrl}/customtypes-api`, repositoryName: c.repo, token, fetch });
const writeClient = (writeToken = c.writeToken) =>
  createWriteClient(c.repo, {
    writeToken,
    documentAPIEndpoint: documentAPIEndpoint(c),
    migrationAPIEndpoint: `${c.baseUrl}/migration-api`,
    assetAPIEndpoint: `${c.baseUrl}/asset-api`,
    fetch,
  });

const quoteSlice: SharedSliceModel = {
  id: "quote",
  type: "SharedSlice",
  name: "Quote",
  description: "A quote",
  variations: [
    {
      id: "default",
      name: "Default",
      docURL: "",
      version: "initial",
      description: "Default",
      imageUrl: "",
      primary: { quote: { type: "StructuredText", config: { label: "Quote", multi: "paragraph,em" } } },
      items: {},
    },
  ],
};

const articleType: CustomTypeModel = {
  id: "wc_article",
  label: "Article",
  repeatable: true,
  status: true,
  format: "custom",
  json: {
    Main: {
      uid: { type: "UID", config: { label: "UID" } },
      title: { type: "StructuredText", config: { label: "Title", single: "heading1" } },
      body: { type: "StructuredText", config: { label: "Body", multi: "paragraph,heading2,strong,em,hyperlink,list-item,o-list-item,image" } },
      image: { type: "Image", config: { label: "Image" } },
      related: { type: "Link", config: { label: "Related", select: "document" } },
      slices: { type: "Slices", fieldset: "Slice Zone", config: { choices: { quote: { type: "SharedSlice" } } } },
    },
  },
};

describe("Custom Types client round-trip", () => {
  it("REQ-SDK-032 REQ-MOD-013 REQ-WAPI-004 shared slices: insert, get, update, conflict", async () => {
    const tc = typesClient(c.writeToken);
    await tc.insertSharedSlice(quoteSlice);
    expect(await tc.getSharedSliceByID("quote")).toMatchObject({ id: "quote", name: "Quote", variations: [{ id: "default" }] });
    await tc.updateSharedSlice({ ...quoteSlice, description: "A pull quote" });
    expect((await tc.getSharedSliceByID("quote")).description).toBe("A pull quote");
    expect((await tc.getAllSharedSlices()).map((s: SharedSliceModel) => s.id)).toEqual(expect.arrayContaining(["quote", "text_block"]));
    await expect(tc.insertSharedSlice(quoteSlice)).rejects.toBeInstanceOf(ct.ConflictError);
  });

  it("REQ-SDK-032 REQ-WAPI-004 REQ-WAPI-005 custom types: insert, get, list, update, conflict, update of a missing type", async () => {
    const tc = typesClient(c.writeToken);
    await tc.insertCustomType(articleType);
    expect(await tc.getCustomTypeByID("wc_article")).toMatchObject({ id: "wc_article", label: "Article", repeatable: true, status: true, format: "custom" });
    expect((await tc.getAllCustomTypes()).map((t: CustomTypeModel) => t.id)).toEqual(expect.arrayContaining(["wc_article", "page", "kitchen_sink"]));
    await tc.updateCustomType({ ...articleType, label: "Migrated article" });
    expect((await tc.getCustomTypeByID("wc_article")).label).toBe("Migrated article");
    await expect(tc.insertCustomType(articleType)).rejects.toBeInstanceOf(ct.ConflictError);
    await expect(tc.updateCustomType({ ...articleType, id: "nope_type" })).rejects.toBeInstanceOf(ct.NotFoundError);
  });

  it("REQ-WAPI-006 REQ-MOD-005 a pushed type shows up in the Content API types map", async () => {
    expect((await read.getRepository()).types).toMatchObject({ wc_article: "Migrated article" });
  });

  it("REQ-WAPI-004 remove a type without documents; get -> NotFoundError", async () => {
    const tc = typesClient(c.writeToken);
    await tc.insertCustomType({ ...articleType, id: "wc_temp", label: "Temp" });
    await tc.removeCustomType("wc_temp");
    await expect(tc.getCustomTypeByID("wc_temp")).rejects.toBeInstanceOf(ct.NotFoundError);
  });

  it("REQ-WAPI-001 REQ-WAPI-002 a missing or wrong write token is rejected", async () => {
    await expect(typesClient("not-a-token").getAllCustomTypes()).rejects.toBeInstanceOf(ct.UnauthorizedError);
    await expect(typesClient(undefined).getAllCustomTypes()).rejects.toBeInstanceOf(ct.UnauthorizedError);
  });
});

describe("WriteClient migration", () => {
  it(
    "REQ-SDK-030 REQ-WAPI-009 REQ-WAPI-011 REQ-WAPI-012 REQ-WAPI-016 migrate(): assets, documents with links, createDocumentFromPrismic, updateDocument, reporter, publishMigrationRelease",
    async () => {
      const wc = writeClient();
      const migration = createMigration();

      const fromBuffer = migration.createAsset(png(), "hero.png", { alt: "Hero", credits: "Compat", tags: ["migrated"] });
      const seeded = await read.getByUID("kitchen_sink", "full");
      const fromUrl = migration.createAsset((seeded.data as any).image.url, "copy.png", { alt: "Copied" });

      const target = migration.createDocument(
        { type: "wc_article", uid: "wc-target", lang: LOCALE, tags: ["migrated"], data: { title: h1("Target") } } as never,
        "Target",
      );
      migration.createDocument(
        {
          type: "wc_article",
          uid: "wc-main",
          lang: LOCALE,
          tags: ["migrated"],
          data: {
            title: h1("Main"),
            image: fromBuffer,
            related: target,
            slices: [{ slice_type: "quote", variation: "default", primary: { quote: [{ type: "paragraph", text: "Quoted", spans: [] }] }, items: [] }],
          },
        } as never,
        "Main",
      );
      migration.createDocument(
        { type: "wc_article", uid: "wc-copy-image", lang: LOCALE, tags: [], data: { title: h1("Copy image"), image: fromUrl } } as never,
        "Copy image",
      );

      const about = await read.getByUID("page", "about");
      migration.createDocumentFromPrismic({ ...about, uid: "about-copy" } as never, "About copy");

      const second = await read.getByUID("blog_post", "second-post");
      second.data = { ...(second.data as object), title: h1("Second post (migrated)") } as never;
      migration.updateDocument(second as never, "Second (migrated)");

      const events: string[] = [];
      await wc.migrate(migration, { reporter: (e) => events.push(e.type) });
      expect(events[0]).toBe("start");
      expect(events.at(-1)).toBe("end");
      expect(events).toEqual(
        expect.arrayContaining([
          "assets:creating",
          "assets:created",
          "documents:masterLocale",
          "documents:creating",
          "documents:created",
          "documents:updating",
          "documents:updated",
        ]),
      );

      // Staged only: nothing is live yet.
      await expect(read.getByUID("wc_article", "wc-main")).rejects.toBeInstanceOf(NotFoundError);
      const masterBefore = (await read.getMasterRef()).ref;

      const { totalItems } = await wc.publishMigrationRelease();
      expect(totalItems).toBeGreaterThanOrEqual(5);
      // A fresh client: the first one caches the master ref for a few seconds.
      const after = freshReader();
      expect((await after.getMasterRef()).ref).not.toBe(masterBefore);

      const main = await after.getByUID("wc_article", "wc-main");
      const data = main.data as any;
      expect(data.related).toMatchObject({ link_type: "Document", uid: "wc-target", type: "wc_article", isBroken: false });
      expect(data.image).toMatchObject({ alt: "Hero", dimensions: { width: 4, height: 3 } });
      expect((await fetch(data.image.url)).status).toBe(200);
      expect(data.slices[0]).toMatchObject({ slice_type: "quote", variation: "default" });
      expect(((await after.getByUID("wc_article", "wc-copy-image")).data as any).image).toMatchObject({ alt: "Copied", dimensions: { width: 4, height: 3 } });
      expect(((await after.getByUID("page", "about-copy")).data as any).title[0].text).toMatch(/^About/);
      expect(((await after.getByUID("blog_post", "second-post")).data as any).title[0].text).toBe("Second post (migrated)");
    },
    SLOW,
  );

  it(
    "REQ-SDK-031 rich text produced by @prismicio/migrate htmlAsRichText is accepted",
    async () => {
      const wc = writeClient();
      const migration = createMigration();
      const html = '<h2>Imported</h2><p>Hello <strong>world</strong>, see <a href="https://example.org">this</a>.</p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>';
      const body = htmlAsRichText(html).result;
      migration.createDocument({ type: "wc_article", uid: "wc-html", lang: LOCALE, tags: [], data: { title: h1("From HTML"), body } } as never, "From HTML");
      await wc.migrate(migration);
      await wc.publishMigrationRelease();
      const out = asHTML(((await freshReader().getByUID("wc_article", "wc-html")).data as any).body);
      expect(out).toContain("<h2>Imported</h2>");
      expect(out).toContain("<strong>world</strong>");
      expect(out).toContain('<a href="https://example.org"');
      expect(out).toContain("<ul><li>one</li><li>two</li></ul>");
      expect(out).toContain("<ol><li>first</li></ol>");
    },
    SLOW,
  );

  it("REQ-WAPI-002 the WriteClient with a wrong token gets ForbiddenError", async () => {
    const migration = createMigration();
    migration.createDocument({ type: "wc_article", uid: "wc-denied", lang: LOCALE, tags: [], data: {} } as never, "Denied");
    await expect(writeClient("not-a-token").migrate(migration)).rejects.toBeInstanceOf(ForbiddenError);
  }, SLOW);
});
