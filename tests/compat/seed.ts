/**
 * Fixture models and content, written over HTTP only (Custom Types API, Asset API, Migration API,
 * Preview API), so the same seed runs against an in-process server and a remote one.
 */

export const LOCALE = "en-us";
export const ALT_LOCALE = "fr-fr";
export const BULK_COUNT = 260;
/** Id of a document that never existed: a link to it renders as broken. */
export const MISSING_DOC_ID = "ZZZZZZZZZZZZZZZZ";

/** 4x3 blue PNG. */
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWMwTvsPRww4OQBrlhMhHVF2fQAAAABJRU5ErkJggg==";
export const png = () => Buffer.from(PNG_BASE64, "base64");

// ---- models ----

const uid = { type: "UID", config: { label: "UID" } };
const heading1 = (label: string) => ({ type: "StructuredText", config: { label, single: "heading1" } });
const docLink = (label: string, customtypes?: string[]) => ({
  type: "Link",
  config: { label, select: "document", ...(customtypes ? { customtypes } : {}) },
});

export const textBlockSlice = {
  id: "text_block",
  type: "SharedSlice",
  name: "TextBlock",
  description: "Text block",
  variations: [
    {
      id: "default",
      name: "Default",
      docURL: "",
      version: "initial",
      description: "Default",
      imageUrl: "",
      primary: { text: { type: "StructuredText", config: { label: "Text", multi: "paragraph,strong,em,hyperlink" } } },
      items: { caption: { type: "Text", config: { label: "Caption" } } },
    },
  ],
};

const model = (id: string, json: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  label: id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
  repeatable: true,
  status: true,
  format: "custom",
  json: { Main: json },
  ...extra,
});

export const customTypes = [
  model("company", { uid, name: { type: "Text", config: { label: "Name" } } }),
  model("author", {
    uid,
    name: { type: "Text", config: { label: "Name" } },
    bio: { type: "StructuredText", config: { label: "Bio", multi: "paragraph" } },
    company: docLink("Company", ["company"]),
  }),
  model(
    "page",
    {
      uid,
      title: heading1("Title"),
      parent: docLink("Parent", ["page"]),
      related: docLink("Related"),
      body: { type: "Slices", fieldset: "Slice Zone", config: { choices: { text_block: { type: "SharedSlice" } } } },
    },
    { format: "page" },
  ),
  model("settings", { site_name: { type: "Text", config: { label: "Site name" } } }, { repeatable: false }),
  model("blog_post", {
    uid,
    title: heading1("Title"),
    author: docLink("Author", ["author"]),
    published_on: { type: "Date", config: { label: "Published on" } },
  }),
  model("product", {
    uid,
    name: { type: "Text", config: { label: "Name" } },
    subtitle: { type: "Text", config: { label: "Subtitle" } },
    price: { type: "Number", config: { label: "Price" } },
    size: { type: "Select", config: { label: "Size", options: ["S", "M", "L"] } },
    location: { type: "GeoPoint", config: { label: "Location" } },
    release_date: { type: "Date", config: { label: "Release date" } },
    launched_at: { type: "Timestamp", config: { label: "Launched at" } },
    description: { type: "StructuredText", config: { label: "Description", multi: "paragraph" } },
  }),
  model("kitchen_sink", {
    uid,
    title: heading1("Title"),
    body: { type: "StructuredText", config: { label: "Body", multi: "paragraph,heading2,strong,em,hyperlink,image,embed,list-item" } },
    image: { type: "Image", config: { label: "Image", thumbnails: [{ name: "mobile", width: 2, height: 2 }] } },
    link: { type: "Link", config: { label: "Link", allowTargetBlank: true } },
    links: { type: "Link", config: { label: "Links", repeat: true } },
    media: { type: "Link", config: { label: "Media", select: "media" } },
    rel: docLink("Relationship"),
    date: { type: "Date", config: { label: "Date" } },
    ts: { type: "Timestamp", config: { label: "Timestamp" } },
    color: { type: "Color", config: { label: "Color" } },
    num: { type: "Number", config: { label: "Number" } },
    text: { type: "Text", config: { label: "Text" } },
    select: { type: "Select", config: { label: "Select", options: ["one", "two"] } },
    flag: { type: "Boolean", config: { label: "Flag" } },
    flag_on: { type: "Boolean", config: { label: "Flag on", default_value: true } },
    select_def: { type: "Select", config: { label: "Select with default", options: ["one", "two"], default_value: "two" } },
    bounded: { type: "Number", config: { label: "Bounded", min: 0, max: 10 } },
    embed: { type: "Embed", config: { label: "Embed" } },
    geo: { type: "GeoPoint", config: { label: "Geo" } },
    integ: { type: "IntegrationFields", config: { label: "Integration", catalog: "compat--shop" } },
    table: { type: "Table", config: { label: "Table" } },
    group: { type: "Group", config: { label: "Group", fields: { label: { type: "Text", config: { label: "Label" } } } } },
    slices: { type: "Slices", fieldset: "Slice Zone", config: { choices: { text_block: { type: "SharedSlice" } } } },
  }),
  model("bulk_item", { uid, n: { type: "Number", config: { label: "N" } } }),
];

/** `routes` used by the client tests: uid- and lang-scoped routes, `:lang?`, 1- and 2-level resolvers. */
export const routes: Array<{ type: string; path: string; uid?: string; lang?: string; resolvers?: Record<string, string> }> = [
  { type: "page", uid: "home", path: "/" },
  { type: "page", lang: ALT_LOCALE, path: "/fr/:uid" },
  { type: "page", path: "/:lang?/:parent?/:uid", resolvers: { parent: "parent" } },
  { type: "blog_post", path: "/blog/:company/:author/:uid", resolvers: { author: "author", company: "author.company" } },
  { type: "author", path: "/authors/:uid" },
];

// ---- content helpers ----

export const h1 = (text: string) => [{ type: "heading1", text, spans: [] }];
export const para = (text: string) => [{ type: "paragraph", text, spans: [] }];
const link = (id: string) => ({ link_type: "Document", id });

// ---- HTTP ----

export interface Target {
  baseUrl: string;
  repo: string;
  writeToken: string;
}

const writeHeaders = (t: Target, json = true): Record<string, string> => ({
  repository: t.repo,
  authorization: `Bearer ${t.writeToken}`,
  ...(json ? { "content-type": "application/json" } : {}),
});

async function call(t: Target, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: writeHeaders(t, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

async function expectOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

export async function uploadAsset(t: Target, filename: string, bytes: Buffer, meta: { alt?: string; credits?: string } = {}) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), filename);
  if (meta.alt) form.append("alt", meta.alt);
  if (meta.credits) form.append("credits", meta.credits);
  const res = await expectOk(
    await fetch(`${t.baseUrl}/asset-api/assets`, { method: "POST", headers: writeHeaders(t, false), body: form }),
    "upload asset",
  );
  return (await res.json()) as { id: string; url: string };
}

export interface NewDoc {
  key?: string;
  title: string;
  type: string;
  lang?: string;
  uid?: string;
  tags?: string[];
  alternate_language_id?: string;
  data: Record<string, unknown>;
}

export async function createDocument(t: Target, d: NewDoc): Promise<string> {
  const { key: _key, ...body } = d;
  const res = await expectOk(
    await call(t, "POST", "/migration-api/documents", { lang: LOCALE, tags: [], ...body }),
    `create ${d.type}:${d.uid ?? d.title}`,
  );
  return ((await res.json()) as { id: string }).id;
}

export async function publishMigrationRelease(t: Target): Promise<number> {
  const res = await expectOk(await call(t, "POST", "/migration-api/migration-release/publish", {}), "publish migration release");
  return ((await res.json()) as { totalItems: number }).totalItems;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export interface SeedResult {
  ids: Record<string, string>;
  assetId: string;
}

const keyOf = (d: NewDoc) => d.key ?? `${d.type}:${d.uid ?? d.title}`;

/**
 * Seeds models and content into an empty repository whose locales are `en-us` (master) and `fr-fr`.
 * Everything is published except `page:draft-page`, which stays a draft in the open migration release.
 */
export async function seed(t: Target): Promise<SeedResult> {
  // A repository that already holds the fixture models was seeded by an earlier run: refuse, since
  // UIDs and counts would collide.
  const probe = await call(t, "GET", "/customtypes-api/customtypes/kitchen_sink");
  if (probe.status === 200) throw new Error(`Repository "${t.repo}" was already seeded: the compat suite needs a fresh repository`);
  if (probe.status !== 404) throw new Error(`Custom Types API probe: HTTP ${probe.status} ${await probe.text()}`);

  await expectOk(await call(t, "POST", "/customtypes-api/slices/insert", textBlockSlice), "insert slice text_block");
  for (const ct of customTypes) await expectOk(await call(t, "POST", "/customtypes-api/customtypes/insert", ct), `insert type ${ct.id}`);

  const asset = await uploadAsset(t, "blue.png", png(), { alt: "Blue pixels", credits: "Smaltic" });
  const ids: Record<string, string> = {};
  const add = async (d: NewDoc) => (ids[keyOf(d)] = await createDocument(t, d));
  const addAll = (ds: NewDoc[]) => pool(ds, 8, add);

  await add({ title: "Acme", type: "company", uid: "acme", data: { name: "Acme" } });
  await add({
    title: "Jane",
    type: "author",
    uid: "jane",
    data: { name: "Jane Doe", bio: para("Writes about coffee."), company: link(ids["company:acme"]!) },
  });

  await add({
    title: "Home",
    type: "page",
    uid: "home",
    tags: ["landing", "featured"],
    data: {
      title: h1("Home"),
      body: [{ slice_type: "text_block", variation: "default", primary: { text: para("Welcome") }, items: [{ caption: "One" }] }],
    },
  });
  await addAll([
    { title: "About", type: "page", uid: "about", tags: ["landing"], data: { title: h1("About"), parent: link(ids["page:home"]!) } },
    { title: "Contact", type: "page", uid: "contact", tags: ["featured"], data: { title: h1("Contact"), related: link(MISSING_DOC_ID) } },
    { title: "Old page", type: "page", uid: "old-page", data: { title: h1("Old page") } },
    {
      title: "Accueil",
      type: "page",
      uid: "accueil",
      lang: ALT_LOCALE,
      alternate_language_id: ids["page:home"],
      data: { title: h1("Accueil") },
    },
    { key: "settings", title: "Settings", type: "settings", data: { site_name: "Compat site" } },
  ]);
  await add({ title: "Linker", type: "page", uid: "linker", data: { title: h1("Linker"), related: link(ids["page:old-page"]!) } });

  const jane = link(ids["author:jane"]!);
  await addAll([
    { title: "Hello", type: "blog_post", uid: "hello-world", tags: ["news"], data: { title: h1("Hello world"), author: jane, published_on: "2024-05-01" } },
    { title: "Second", type: "blog_post", uid: "second-post", tags: ["news"], data: { title: h1("Second post"), author: jane, published_on: "2024-06-01" } },
  ]);

  await addAll([
    {
      title: "Alpha",
      type: "product",
      uid: "alpha",
      tags: ["kitchen", "sale"],
      data: {
        name: "Alpha",
        subtitle: "The first",
        price: 10,
        size: "S",
        location: { latitude: 48.8566, longitude: 2.3522 }, // Paris
        release_date: "2024-01-15", // Monday
        launched_at: "2024-01-15T08:30:00+0000",
        description: para("Smooth café espresso machine"),
      },
    },
    {
      title: "Beta",
      type: "product",
      uid: "beta",
      tags: ["kitchen"],
      data: {
        name: "Beta",
        subtitle: "The second",
        price: 20,
        size: "M",
        location: { latitude: 45.764, longitude: 4.8357 }, // Lyon
        release_date: "2024-03-10", // Sunday
        launched_at: "2024-03-10T14:00:00+0000",
        description: para("Compact espresso grinder"),
      },
    },
    {
      title: "Gamma",
      type: "product",
      uid: "gamma",
      tags: ["garden", "sale"],
      data: {
        name: "Gamma",
        price: 30,
        size: "L",
        location: { latitude: 51.5074, longitude: -0.1278 }, // London
        release_date: "2025-07-04", // Friday
        launched_at: "2025-07-04T20:15:00+0000",
        description: para("Garden hose reel"),
      },
    },
  ]);

  await addAll([
    {
      title: "Full",
      type: "kitchen_sink",
      uid: "full",
      data: {
        title: h1("Everything filled"),
        body: [
          { type: "heading2", text: "Section", spans: [] },
          { type: "paragraph", text: "Bold and linked", spans: [{ start: 0, end: 4, type: "strong" }, { start: 9, end: 15, type: "hyperlink", data: { link_type: "Web", url: "https://example.org" } }] },
          { type: "list-item", text: "Item", spans: [] },
          { type: "image", id: asset.id, alt: "Inline", dimensions: { width: 4, height: 3 } },
        ],
        image: { id: asset.id, alt: "Main image", mobile: { id: asset.id } },
        link: { link_type: "Web", url: "https://example.org", target: "_blank" },
        links: [{ link_type: "Web", url: "https://example.com" }],
        media: { link_type: "Media", id: asset.id },
        rel: link(ids["page:home"]!),
        date: "2024-02-29",
        ts: "2024-02-29T12:34:56+0000",
        color: "#ff8800",
        num: 0,
        text: "Some text",
        select: "two",
        flag: true,
        embed: { embed_url: "https://example.org/video", type: "video", html: "<iframe src=\"https://example.org/video\"></iframe>" },
        geo: { latitude: 47.0105, longitude: 28.8638 },
        integ: { id: "sku-1", title: "Integration item" },
        table: { body: { rows: [{ cells: [{ content: para("cell") }] }] } },
        group: [{ label: "first" }],
        slices: [{ slice_type: "text_block", variation: "default", primary: { text: para("Slice text") }, items: [] }],
      },
    },
    { title: "Empty", type: "kitchen_sink", uid: "empty", data: {} },
  ]);

  await addAll(
    Array.from({ length: BULK_COUNT }, (_, i) => ({
      title: `Bulk ${i}`,
      type: "bulk_item",
      uid: `bulk-${String(i).padStart(3, "0")}`,
      tags: i % 2 === 0 ? ["bulk", "even"] : ["bulk"],
      data: { n: i },
    })),
  );

  await publishMigrationRelease(t);

  // Never published: visible through preview tokens only.
  await add({ title: "Draft page", type: "page", uid: "draft-page", data: { title: h1("Draft page"), parent: link(ids["page:home"]!) } });

  return { ids, assetId: asset.id };
}

/** `GET /previews/session` -> `{ token, previewUrl }` (write token auth). */
export async function previewSession(t: Target, documentId?: string, config?: string): Promise<{ token: string; previewUrl: string | null }> {
  const p = new URLSearchParams();
  if (documentId) p.set("documentId", documentId);
  if (config) p.set("config", config);
  const qs = p.size ? `?${p}` : "";
  const res = await expectOk(await call(t, "GET", `/r/${t.repo}/previews/session${qs}`), "preview session");
  return (await res.json()) as { token: string; previewUrl: string | null };
}

export async function createPreviewConfig(t: Target, cfg: { name: string; website_url: string; resolver_path: string }) {
  const res = await expectOk(await call(t, "POST", `/r/${t.repo}/previews/configs`, cfg), "create preview config");
  return (await res.json()) as { id: string };
}
