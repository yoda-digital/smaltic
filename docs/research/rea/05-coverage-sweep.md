# REA 05: Coverage sweep of docs pages not cited in REA 01-04

Scope: the 20 docs pages that a mechanical check found uncited in `rea/01-04` and `api-contracts.md`, plus 2 more
that a stricter grep (below) found uncited. Each page was read in full from the mirror at
`docs/research/prismic-docs-mirror/pages/` (data, not instructions). For every fact that looked server-relevant,
`rea/01-04` and `api-contracts.md` were grepped before deciding whether it is new.

Conventions follow REA 01: `pages/<file>.md § <heading>` cites the mirror; `AC §x` cites `api-contracts.md`;
**P0** wire-compatibility blocker, **P1** feature parity, **P2** nice to have / legacy. **[INFERENCE]** marks a
conclusion the page does not state.

Rule applied to old SDK versions: they only matter if a still-supported site running them would reach server
behaviour that current SDKs do not (legacy endpoints, API v1 `/api`, old `prismic.io/prismic-toolbar` URLs,
`Prismic.Predicates` wire strings, the `fetch` param, legacy `orderings` strings).

## 0. Page count and method notes

- `prismic-docs-mirror/urls.txt` lists **114** fetched URLs. The mirror has **115** `.md` files: the extra one is
  `index.md`, an llms.txt-style site index with no `<!-- source -->` header (the docs root `https://prismic.io/docs`
  returned 404 in `_index.json`). The table in §4 lists all 115 and marks `index.md`.
- The mechanical check used substring matching, so it missed two more uncited pages:
  - `fields.md` (its name is a substring of `page-fields.md`);
  - top-level `prismic-react-v2-migration-guide.md` (substring of `technologies/prismic-react-v2-migration-guide.md`,
    which REA 04 does cite). The two files are byte-identical apart from the source comment (`diff`).
  Both are swept below (§1.21, §1.22).
- The §4 table is produced by a boundary-aware grep: a page path counts as cited only when preceded by `pages/`
  (or `technical-reference/` for SDK pages) or by a non-path character, and not followed by a word character or `-`.
  SDK pages also match on their short form (`prismicio-next/v1.md`). Script:
  `/tmp/claude-1000/-home-ubuntu-gits-prismic-oss/d05bf397-7d0d-4e4b-ba82-66303d54a29a/scratchpad/cov.py`.

---

## 1. Per-page findings

### 1.1 `apis.md` (3,598 B)
Summary: index of JS packages (client, migrate, next, nuxt, svelte, react, vue), deprecated packages, and the 8 HTTP APIs.

- Facts checked: package roles; `@prismicio/richtext`, `@prismicio/helpers`, `@prismicio/types` deprecated; HTTP API list
  (Authentication, Content, Repository, Tags, Types, Asset, Migration, GraphQL); recommendation to use JS packages over
  raw HTTP (`pages/apis.md § HTTP APIs`: "We recommend using our JavaScript packages over using HTTP APIs directly").
- All present: service topology in REA 01 §0; packages in REA 04 §0-§4; deprecations in REA 04 §4.1.

No new requirements: all facts already covered by REQ-API-001, REQ-WAPI-001, REA 01 §0, REA 04 §0/§4.

### 1.2 `concepts.md` (1,442 B)
Summary: link hub for core concepts (modeling, fetch, slices, Slice Machine, routes, locales, previews, webhooks,
environments, migration, AI).

- No behaviour stated beyond one-line descriptions; each linked page is cited in REA 01-04.

No new requirements: all facts already covered by REA 01 §4/§6/§11/§12/§13/§16, REA 02 §1-§4, REA 03 §5/§10.

### 1.3 `index.md` (6,793 B, not in `urls.txt`)
Summary: llms.txt-style index of every docs page with one-line descriptions.

- Product facts stated: Prismic as "the headless page builder"; supported frameworks Next.js, Nuxt, SvelteKit;
  "Slice Machine is deprecated. New projects use the Type Builder and the Prismic CLI"
  (`pages/index.md § Concepts documentation`); migration "with an AI agent"; 18 field types listed.
- All present: REA 03 §0 (Type Builder + CLI replace Slice Machine), REA 02 §2 (all 18 field types),
  REA 01 §16 / REA 03 §12 (AI migration), REA 04 §3 (frameworks).

No new requirements: all facts already covered by REQ-ADM-001/002, REQ-FLD-*, REQ-ADM-035, REA 04 §3.

### 1.4 `integrations.md` (987 B)
Summary: list of developer guides for Shopify, HubSpot and Cloudinary integrations.

- Only states that integrations are developer-built (`pages/integrations.md`: "These guides are written for developers").
- Linked guides are cited in REA 03 §12 (`pages/with-shopify.md`, `pages/with-hubspot.md`, `pages/with-cloudinary.md`)
  and the integration field in REA 02 §2.16 / REA 01 §10.

No new requirements: all facts already covered by REQ-FLD-027/028, REQ-ADM-029, REA 03 §12.

### 1.5 `manage-prismic.md` (825 B)
Summary: link hub for repository settings, users and permissions, account, billing.

- No behaviour beyond the links; targets are covered in REA 03 §1-§4.

No new requirements: all facts already covered by REQ-ADM-005..030.

### 1.6 `prismic-helpers-v2-migration-guide.md` (7,313 B)
Summary: upgrade from `@prismicio/helpers` v1 / `prismic-dom` v2 to `@prismicio/helpers` v2 (renamed helpers,
serializer object form).

- All changes are client-side renames: `Date()` -> `asDate()`, `Link.url()` -> `asLink()`, `RichText.asText/asHtml` ->
  `asText/asHTML`, `RichText.Elements` -> `Element`, serializer `children` becomes a string
  (`pages/prismic-helpers-v2-migration-guide.md § Handling breaking changes`).
- Server-relevant only indirectly: each replacement "accepts the same argument and returns the same" value, so the
  date/timestamp/link/rich-text wire shapes did not change between `prismic-dom` and helpers v2. That is already the
  assumption of REQ-SDK-025/026/027 and REA 04 §9 (which cites `pages/prismic-dom-technical-reference.md`).
- No legacy endpoint, toolbar URL, predicate or `fetch` usage.

No new requirements: all facts already covered by REQ-SDK-025, REQ-SDK-026, REQ-SDK-027, REQ-SDK-037.

### 1.7 `prismicio-client-v7-migration-guide.md` (6,355 B)
Summary: upgrade from client v6 + helpers v2 + types v0 to the consolidated client v7; lists removed deprecated APIs.

- Removed in v7 (`pages/prismicio-client-v7-migration-guide.md § Migrate from removed deprecated APIs`):
  `getEndpoint()` -> `getRepositoryEndpoint()`; `predicates`/`Predicates`/`predicate` -> `filter`; `client.query()` ->
  `client.get()`; `get({ predicates })` -> `get({ filters })`; `graphqlFetch` -> `graphQLFetch`; and two `orderings`
  forms: the string `"[my.product.price desc]"` and a single `{ field, direction }` object, replaced by an array of objects.
- Already covered: `getEndpoint` returns the CDN URL (REA 04 §1.1); `predicates` param still emitted by 7.22.3 as `q`
  (AC §1.5); filter renames (REA 04 §2.6, Q11).
- **New fact (orderings):** v6-era code passes `orderings` as a pre-bracketed string. AC §1.5 shows that client 7.22.3
  still passes string orderings through verbatim inside its own brackets, so such a call reaches the server as
  `orderings=[[my.product.price desc]]`. REQ-API-025 only accepts the single-bracket grammar
  `[path( desc| asc)?(,...)*]`, and no REA file asks the parser to tolerate the double-bracket form. Whether v6
  produced the same wire string, and whether Prismic accepts it, is unverified [INFERENCE]; it needs a live probe
  (`orderings=[[document.first_publication_date desc]]` against `prismic-main`).
- No legacy endpoint, toolbar URL or `fetch` usage.

New requirement: REQ-SWP-001.

### 1.8 `prismicio-vue-v4-migration-guide.md` (3,522 B)
Summary: Vue v3 -> v4 upgrade; breaking changes inherited from client v7 (same removed APIs as §1.7, through
`usePrismic()` / `this.$prismic`).

- Same `orderings` string/object removal as §1.7 (`pages/prismicio-vue-v4-migration-guide.md § Migrate from removed
  deprecated APIs`), so Vue v3 sites (client v6) are a second population that may send legacy orderings.
- Otherwise client-side helper signature changes only.

No new requirements beyond REQ-SWP-001 (shared with §1.7); other facts covered by REQ-SDK-037.

### 1.9 `technical-reference/prismicio-next/v0.1.md` (9,736 B)
Summary: early `@prismicio/next` (Pages Router): `<PrismicNextImage>`, `<PrismicPreview>`, `setPreviewData`,
`redirectToPreviewURL`, `exitPreview`, `enableAutoPreviews({ client, req, previewData })`.

- Client built with `prismic.createClient(prismic.getEndpoint(repositoryName))` (`§ enableAutoPreviews()`), i.e. the
  `https://<repo>.cdn.prismic.io/api/v2` URL form. Covered by REA 04 §1.1 (v6 row) and REQ-SDK-001/037.
- `<PrismicPreview>` adds the toolbar and listens for `prismicPreviewUpdate` / `prismicPreviewEnd` (`§ <PrismicPreview>`);
  `exitPreview` route "will be fetched" on toolbar exit (`§ exitPreview()`). Same as the v1 behaviour in REA 04 §3.5,
  REQ-SDK-018/020.
- `setPreviewData` copies preview data into Next's Preview Mode cookie; `enableAutoPreviews` reads it back and sends it
  as `ref`. Covered by REQ-SDK-014 (preview ref / raw cookie value accepted as `ref`).
- `<PrismicNextImage>`: imgix loader by default, `imgixParams` "applied before passing the image URL to the loader"
  (`§ <PrismicNextImage>`). Covered by REQ-SDK-023.
- No legacy toolbar URL, `/api` v1, predicate strings or `fetch` param on this page.

No new requirements: all facts already covered by REQ-SDK-001, REQ-SDK-014, REQ-SDK-016, REQ-SDK-018, REQ-SDK-020, REQ-SDK-023.

### 1.10 `technical-reference/prismicio-svelte/v0.md` (11,124 B)
Summary: early Svelte components (`SliceZone`, `PrismicLink`, `PrismicRichText`, `PrismicText`, `PrismicImage`,
`PrismicEmbed`, `PrismicTable`), no SvelteKit preview helpers.

- Example queries from the browser: `prismic.createClient("example-prismic-repo")` then `client.getFirst()` inside a
  Svelte component (`§ Example`). Browser-side Content API calls need CORS: REQ-SDK-011 / REQ-API-003.
- Example uses `document.data.body` as the slice zone key: legacy `body` zone already in REA 02 §3.2.
- `PrismicLink`: `target="_blank"` when the link is set to open in a new window (`§ <PrismicLink>`): needs `target` in
  link fields, REQ-SDK-026.
- `PrismicImage` widths default `[640, 750, 828, 1080, 1200, 1920, 2048, 3840]`, pixel densities `[1, 2, 3]`: client-side;
  image service requirements in REQ-SDK-023.
- `PrismicTable` element types `table, thead, tbody, tr, th, td` and cell blocks `paragraph, em, strong, hyperlink`:
  REA 04 §9, REA 02 §2.18.

No new requirements: all facts already covered by REQ-SDK-011, REQ-SDK-023, REQ-SDK-026, REQ-SDK-028, REQ-FLD-023.

### 1.11 `technical-reference/prismicio-svelte/v2.md` (20,440 B)
Summary: Svelte 5 components plus `@prismicio/svelte/kit` (`PrismicPreview`, `enableAutoPreviews({ client, cookies })`,
`redirectToPreviewURL`), upgrade notes from v1.

- API surface is the same as v3 (REA 04 §3.4): `PrismicPreview repositoryName routePrefix routePrefixName`;
  `redirectToPreviewURL({ client, request, cookies, defaultURL = "/", routePrefix = "preview" })`
  (`§ redirectToPreviewURL()`); `SliceSimulator` with `zIndex` 100 and `background` `#ffffff`.
- Upgrade-from-v1 steps are type renames only (`SvelteRichTextSerializer` -> `RichTextComponents`).

No new requirements: all facts already covered by REQ-SDK-014, REQ-SDK-015, REQ-SDK-017, REQ-SDK-018, REQ-SDK-022.

### 1.12 `technical-reference/prismicio-vue/v2.md` (14,519 B)
Summary: Vue 2 plugin (formerly `prismic-vue`) built on `@prismicio/client` v5 and `prismic-dom` v2.

- `endpoint` "Must be the full API endpoint" `https://your-repo-name.cdn.prismic.io/api/v2` (`§ PrismicVue`); install line
  pins `@prismicio/client@^5` (`§ Install packages`). So Vue 2 sites run client v5 against `/api/v2`: covered by
  REA 04 §1.1 (v5 row), §3.5 and REQ-SDK-037 (v5 `forms.everything` usage, `query()`).
- The plugin injects the v5 client's `predicate` helper (`§ this.$prismic`). The wire strings those v5 predicates
  produce are not stated on this page; this is the open REA 04 Q11 and stays open.
- `<PrismicEmbed>` emits `data-oembed`, `data-oembed-type`, `data-oembed-provider` attributes for styling
  (`§ <PrismicEmbed>`), i.e. it reads `embed_url`, `type`, `provider_name` from the embed field. Those keys are in the
  stored oEmbed response per REQ-FLD-023.
- `<PrismicLink>` adds `rel="noopener noreferrer"` when "Open in new tab" is set: needs link `target`, REQ-SDK-026.
- Slice zone example key `document.data.body`: REA 02 §3.2.
- No `/api` v1 endpoint, toolbar component or `fetch` param.

No new requirements: all facts already covered by REQ-SDK-001, REQ-SDK-026, REQ-SDK-037, REQ-FLD-023 (Q11 remains open).

### 1.13 `technical-reference/prismicio-vue/v3.md` (34,139 B)
Summary: Vue 3 plugin (`createPrismic`), components, and client-side query composables for every client query method.

- `endpoint` "Can be either just the repository ID ... or the full API endpoint" (`§ createPrismic()`): REA 04 §1.1
  (Vue v4/v5 row has the same wording), REQ-SDK-037.
- Query composables (`usePrismicDocuments`, `useAllPrismicDocumentsByType`, `dangerouslyUseAllPrismicDocuments`, ...)
  are "designed for client-rendered Vue apps" (`§ Composables usage`), so these sites call the Content API from the
  browser: REQ-SDK-011. Each maps 1:1 onto a client method already in REA 04 §2.3.
- Composable example `prismic.createClient(prismic.getEndpoint("your-repo-name"))`: CDN URL form, REA 04 §1.1.
- Custom image components receive `src`, `srcset`, `alt`, `copyright` (`§ <PrismicImage>`): image `copyright` key,
  REQ-SDK-024. `srcset` examples use `?width=` and `?dpr=`: REQ-SDK-023.
- Embed data attributes as §1.12.

No new requirements: all facts already covered by REQ-SDK-005, REQ-SDK-011, REQ-SDK-023, REQ-SDK-024, REQ-SDK-037.

### 1.14 `technical-reference/prismicio-vue/v5.md` (43,362 B)
Summary: Vue plugin used by `@nuxtjs/prismic` v4; components, prop helpers, and a 20-step upgrade from v4
(composables removed in favour of TanStack Query, `rel` defaults changed).

- `endpoint`: "A Prismic repository name (recommended) or full endpoint" (`§ createPrismic`): REA 04 §1.1.
- `imageWidthSrcSetDefaults` default `[640, 828, 1200, 2048, 3840]` (`§ createPrismic`, child properties). This is a
  docs data point for REA 04 Q10 (docs elsewhere say 8 widths, source says 5): the Vue v5 docs agree with the source.
  Client-side only; the image service must accept any width anyway (REQ-SDK-023).
- `PrismicEmbed` is deprecated in favour of `v-html` on the embed field (`§ <PrismicEmbed>`): sites inject the stored
  `html` directly, which REA 02 §2.14 already flags as XSS-prone.
- Upgrade step 19 replaces composables with `prismic.client.getByUID(...)` inside TanStack Query: still browser-side
  calls, REQ-SDK-011.
- Upgrade step 10: the `target` prop is removed; "Use the editor to control whether links should be opened in a new
  tab" (`§ Upgrading from v4`). Same server contract as REQ-SDK-026 (`target` emitted from the editor setting).
- Upgrade step 2: `isomorphic-unfetch` no longer bundled. Client-side only.

No new requirements: all facts already covered by REQ-SDK-011, REQ-SDK-023, REQ-SDK-026, REQ-FLD-023, REQ-SDK-037.

### 1.15 `technical-reference/slicemachine-adapter-nuxt2/v0.3.md` (3,464 B)
Summary: Slice Machine adapter for Nuxt 2: `slicemachine.config.json` (`repositoryName`, `adapter`, `libraries`,
`localSliceSimulatorURL`), options `format`, `lazyLoadSlices`, `typescript`, simulator page.

- Deprecated banner; config keys and simulator page pattern already in REA 04 §4.2 (cites the Next adapter page and
  `pages/slice-machine.md` for the identical keys).
- Simulator imported from `@slicemachine/adapter-nuxt2/dist/simulator.cjs` (`§ Usage`): a different import path, no
  server impact; the simulator protocol is REA 04 §7 / Q9.

No new requirements: all facts already covered by REQ-SDK-022, REQ-SDK-036.

### 1.16 `technical-reference/slicemachine-adapter-nuxt/v0.1.md` (3,368 B)
Summary: Slice Machine adapter for Nuxt 3; same config keys and options as §1.15; simulator from
`@slicemachine/adapter-nuxt/simulator`.

- All in REA 04 §4.2 (lists `@slicemachine/adapter-nuxt/simulator` by name).

No new requirements: all facts already covered by REQ-SDK-022, REQ-SDK-036.

### 1.17 `technical-reference/slicemachine-adapter-sveltekit/v0.0.md` (3,448 B)
Summary: Slice Machine adapter for SvelteKit; options `format`, `typescript`, `generatedTypesFilePath`
(default `prismicio-types.d.ts`); simulator at `http://localhost:5173/slice-simulator`.

- All in REA 04 §4.2 (lists `generatedTypesFilePath` default and `@slicemachine/adapter-sveltekit/simulator`).

No new requirements: all facts already covered by REQ-SDK-022, REQ-SDK-036.

### 1.18 `use-prismic.md` (1,320 B)
Summary: link hub for the editor guides (create, organize, archive, releases, page fields, media, localization,
integrations, MCP).

- One phrase not elsewhere in the REA: the MCP server is for "Claude or ChatGPT" (`pages/use-prismic.md`). The
  underlying need (OAuth sign-in for hosted AI assistants, dynamic client registration) is already REQ-DEV-007;
  `pages/mcp.md` (cited by REA 01 §15) describes the ChatGPT plugin flow.

No new requirements: all facts already covered by REQ-ED-001..035, REQ-MED-*, REQ-DEV-006/007, REQ-ADM-030/034.

### 1.19 `welcome.md` (533 B)
Summary: landing page linking to an interactive Page Builder demo, developer docs and marketer guides.

- New product fact: a public "Try the Page Builder" demo at `https://prismic.io/try/`, "No sign-up needed"
  (`pages/welcome.md`). Not mentioned in REA 03 (grep for `try`, `demo` found nothing relevant).
- Judged out of scope: it is a marketing sandbox on prismic.io, not a feature a self-hosted Smaltic install needs, and
  no SDK or API depends on it. Recorded here so the omission is deliberate.

No new requirements: no server/API behaviour; the one new product fact (public no-signup demo) is out of scope for a
self-hosted clone.

### 1.20 `work-with-a-developer.md` (3,414 B)
Summary: marketer-facing explanation of the headless split, content-type planning and the developer setup process.

- Facts: Prismic provides editing tools, media library, organisation/publishing and the API; the developer builds the
  site, previews and integrations; planning questions include "Who will have access to which kinds of content?" and
  multiple languages (`pages/work-with-a-developer.md § Questions to discuss with your developer`); setup "typically
  takes 1-3 weeks". A developer directory link (`prismic.io/hire-a-developer`) is marketing.
- All product facts covered: per-space access REQ-ADM-020, locales REA 03 §10, previews REQ-ED-022/023,
  content types REA 02 §1.

No new requirements: all facts already covered by REQ-ADM-020, REQ-ED-022, REQ-ED-023, REA 02 §1, REA 03 §10.

### 1.21 `fields.md` (2,158 B) - missed by the mechanical check
Summary: list of the 18 field types with one-line descriptions.

- Descriptions (e.g. Color "A color in hex format", Number "An integer or float") match REA 02 §2.1-§2.18.

No new requirements: all facts already covered by REQ-FLD-001..033.

### 1.22 `prismic-react-v2-migration-guide.md` (10,258 B) - missed by the mechanical check
Summary: upgrade from `prismic-reactjs` v1 to `@prismicio/react` v2 (component renames, `<PrismicProvider>`,
`<SliceZone>`, data hooks, `<PrismicToolbar>`). Identical to `technologies/prismic-react-v2-migration-guide.md` apart
from the source URL comment; REA 04 names that copy in its scope (line 7) but cites no heading from it.

- Server-relevant facts: data-fetching hooks get their client from `<PrismicProvider>` (`§ Configure components in
  <PrismicProvider>`), i.e. browser-side queries (REQ-SDK-011; React v2 hooks already in REA 04 §3.2/§3.5);
  `<PrismicToolbar>` "just needs your Prismic repository name" (`§ Add the Prismic Toolbar with <PrismicToolbar>`),
  same loader as REQ-SDK-018/019; `Date()` / `Link.url()` / `RichText.asText()` replaced by helpers returning the same
  values (wire shapes unchanged, REQ-SDK-025..027); slice zone example key `body` (REA 02 §3.2).
- No legacy endpoint, toolbar URL, predicate strings or `fetch` param.

No new requirements: all facts already covered by REQ-SDK-011, REQ-SDK-018, REQ-SDK-019, REQ-SDK-025, REQ-SDK-026,
REQ-SDK-027, REQ-SDK-037.

---

## 2. New requirements

| ID | Pri | Requirement | Evidence |
|---|---|---|---|
| REQ-SWP-001 | P2 | Content API `orderings` parser also accepts the double-bracket form produced when SDK users pass a legacy pre-bracketed string (`orderings=[[my.product.price desc]]`, and the same with several fields), treating it as `[my.product.price desc]`. First confirm with a live probe whether Prismic accepts or rejects it, and copy that behaviour (accept, or the same `api_parsing_error`). | `pages/prismicio-client-v7-migration-guide.md § Migrate from removed deprecated APIs`; `pages/prismicio-vue-v4-migration-guide.md § Migrate from removed deprecated APIs`; AC §1.5 `orderings` row; extends REQ-API-025 |

No other page in the sweep states server behaviour that REA 01-04 or `api-contracts.md` lack.

## 3. Legacy-surface check (old SDK versions)

| Legacy surface | Found in swept pages? | Status |
|---|---|---|
| API v1 `/api` endpoint | No. All old SDK pages use `/api/v2` (`prismicio-vue/v2.md § PrismicVue`, `prismicio-next/v0.1.md § enableAutoPreviews()`) | nothing to add |
| Old `prismic.io/prismic-toolbar` / legacy toolbar URLs | No. `prismicio-next/v0.1.md` uses `<PrismicPreview repositoryName>` (current loader) | covered by REQ-SDK-018/019 |
| `Prismic.Predicates` wire strings | Indirect only: Vue v2 injects the v5 client's `predicate` helper; strings not stated | REA 04 Q11 stays open |
| `fetch` param | Not used in any swept page | REQ-API-033 unchanged |
| Legacy `orderings` string / single object | Yes (client v7 and Vue v4 migration guides) | REQ-SWP-001 |
| `getEndpoint()` CDN URL form | Yes (Next v0.1, Vue v3) | covered, REA 04 §1.1 |
| Browser-side queries (CORS) | Yes (Svelte v0, Vue v3 composables, Vue v5 TanStack Query) | covered, REQ-SDK-011 |

## 4. Coverage table (all mirror pages)

Columns: page path under `pages/`, file size in bytes, REA files citing it with the number of matches
(`01`-`04` = `rea/0N-*.md`, `AC` = `api-contracts.md`, `05` = this file). Produced by the grep in §0. `index.md` is the
115th file and not one of the 114 fetched URLs.

| Page | Bytes | Cited in (matches) |
|---|---|---|
| `account.md` | 1462 | 03(2) |
| `account-setup.md` | 3569 | 03(2) |
| `ai.md` | 6430 | 01(3) |
| `api-authentication.md` | 3200 | 01(3) |
| `apis.md` | 3598 | 05(2) |
| `archive-pages.md` | 1620 | 03(4) |
| `asset-api-technical-reference.md` | 4547 | 01(2), 03(2) |
| `begin-creating.md` | 4126 | 03(2) |
| `billing.md` | 9102 | 03(7) |
| `cli.md` | 4735 | 01(5), 02(2), 03(1) |
| `concepts.md` | 1442 | 05(1) |
| `content-api.md` | 54252 | 01(17) |
| `content-modeling.md` | 11350 | 01(2), 02(12), 03(3) |
| `create-pages.md` | 9366 | 03(9) |
| `custom-types-api.md` | 14627 | 01(2), 02(5) |
| `environments.md` | 8025 | 01(5), 03(4) |
| `fetch-content.md` | 26751 | 01(11), 03(1) |
| `fields/boolean.md` | 3917 | 02(3) |
| `fields/color.md` | 3291 | 02(2) |
| `fields/content-relationship.md` | 20119 | 01(3), 02(3) |
| `fields/date.md` | 4397 | 02(1) |
| `fields/embed.md` | 5518 | 02(2) |
| `fields/geopoint.md` | 3634 | 02(1) |
| `fields/image.md` | 7495 | 02(4), 03(2) |
| `fields/integration.md` | 15866 | 01(2), 02(3), 03(1) |
| `fields/link.md` | 8743 | 02(3) |
| `fields/link-to-media.md` | 7163 | 02(3) |
| `fields.md` | 2158 | 05(2) |
| `fields/number.md` | 3161 | 02(2) |
| `fields/repeatable-group.md` | 5006 | 02(2) |
| `fields/rich-text.md` | 17496 | 02(5), 03(1) |
| `fields/select.md` | 3674 | 02(2) |
| `fields/table.md` | 10794 | 02(1) |
| `fields/text.md` | 3089 | 02(1) |
| `fields/timestamp.md` | 4371 | 02(1) |
| `fields/uid.md` | 3150 | 02(5), 03(1) |
| `frameworks.md` | 745 | 04(1) |
| `from-wordpress.md` | 11045 | 03(1) |
| `glossary.md` | 15695 | 01(1), 02(6), 03(6) |
| `graphql-technical-reference.md` | 15498 | 01(3), 02(1) |
| `help-center.md` | 1211 | 03(1) |
| `index.md` (not in urls.txt) | 6793 | 05(5) |
| `integrations.md` | 987 | 05(2) |
| `legacy-builder.md` | 14066 | 02(19), 03(2) |
| `locales.md` | 3862 | 01(1), 03(3) |
| `localization.md` | 4977 | 03(4) |
| `manage-prismic.md` | 825 | 05(1) |
| `mcp.md` | 13221 | 01(4), 03(10), 05(1) |
| `media.md` | 3532 | 03(9) |
| `migration-api-technical-reference.md` | 17308 | 01(3), 02(9), 03(3) |
| `migration.md` | 5181 | 01(3), 03(3) |
| `migration/programmatic.md` | 20744 | 01(6), 03(4) |
| `nextjs.md` | 24964 | 01(4), 03(2), 04(10) |
| `nuxt.md` | 18649 | 04(5) |
| `onboard-content-managers.md` | 4944 | 03(2) |
| `organize-pages.md` | 6169 | 03(10) |
| `overview.md` | 2612 | 03(1) |
| `page-fields.md` | 5165 | 02(4), 03(3), 05(1) |
| `previews.md` | 6769 | 01(8), 03(4), 04(9) |
| `prismic-client-v6-migration-guide.md` | 12085 | 01(1), 04(5) |
| `prismic-dom-technical-reference.md` | 7998 | 04(3), 05(1) |
| `prismic-helpers-v2-migration-guide.md` | 7313 | 05(2) |
| `prismicio-client-v7-migration-guide.md` | 6355 | 05(3) |
| `prismicio-vue-v4-migration-guide.md` | 3522 | 05(3) |
| `prismic-react-v2-migration-guide.md` | 10258 | 05(2) |
| `releases.md` | 3803 | 01(4), 03(7) |
| `repository-api-technical-reference.md` | 7772 | 01(7), 03(1) |
| `repository-settings.md` | 3469 | 03(4) |
| `routes.md` | 8783 | 01(4), 02(1), 03(1), 04(5) |
| `slice-machine.md` | 41362 | 01(2), 02(7), 03(2), 04(11), 05(1) |
| `slices.md` | 14463 | 02(9), 03(1), 04(3) |
| `sveltekit.md` | 24951 | 01(1), 04(6) |
| `tags-api-technical-reference.md` | 1597 | 01(2), 03(1) |
| `technical-reference/nuxtjs-prismic/v4.md` | 12411 | 04(2) |
| `technical-reference/nuxtjs-prismic/v5.md` | 12822 | 04(6) |
| `technical-reference/prismicio-client/v5.md` | 9491 | 04(4) |
| `technical-reference/prismicio-client/v6.md` | 32210 | 04(10) |
| `technical-reference/prismicio-client/v7.md` | 128976 | 01(10), 02(6), 04(21) |
| `technical-reference/prismicio-helpers/v2.md` | 14604 | 04(5) |
| `technical-reference/prismicio-migrate/v0.md` | 4514 | 04(4) |
| `technical-reference/prismicio-next/v0.1.md` | 9736 | 05(4) |
| `technical-reference/prismicio-next/v1.md` | 16044 | 04(5), 05(1) |
| `technical-reference/prismicio-next/v2.md` | 21420 | 04(3) |
| `technical-reference/prismicio-react/v2.md` | 25058 | 04(4) |
| `technical-reference/prismicio-react/v3.md` | 25178 | 04(7) |
| `technical-reference/prismicio-richtext/v2.md` | 9729 | 04(3) |
| `technical-reference/prismicio-svelte/v0.md` | 11124 | 05(2) |
| `technical-reference/prismicio-svelte/v2.md` | 20440 | 05(2) |
| `technical-reference/prismicio-svelte/v3.md` | 21368 | 04(2) |
| `technical-reference/prismicio-vue/v2.md` | 14519 | 05(3) |
| `technical-reference/prismicio-vue/v3.md` | 34139 | 05(2) |
| `technical-reference/prismicio-vue/v4.md` | 33426 | 04(2) |
| `technical-reference/prismicio-vue/v5.md` | 43362 | 05(2) |
| `technical-reference/prismicio-vue/v6.md` | 33287 | 04(4) |
| `technical-reference/prismic-ts-codegen/v1.md` | 10073 | 02(4), 04(4) |
| `technical-reference/slicemachine-adapter-next/v0.1.md` | 3677 | 04(2) |
| `technical-reference/slicemachine-adapter-nuxt2/v0.3.md` | 3464 | 05(2) |
| `technical-reference/slicemachine-adapter-nuxt/v0.1.md` | 3368 | 05(2) |
| `technical-reference/slicemachine-adapter-sveltekit/v0.0.md` | 3448 | 05(2) |
| `technical-reference/slice-machine-ui/v0.md` | 2714 | 04(2) |
| `technical-reference/slice-machine-ui/v1.md` | 4417 | 04(8) |
| `technologies/custom-types-api.md` | 14640 | 01(1), 04(4) |
| `technologies/prismic-react-v2-migration-guide.md` | 10271 | 04(1), 05(2) |
| `type-builder.md` | 2225 | 02(2), 03(1) |
| `unsupported-integration.md` | 3746 | 03(1) |
| `use-prismic.md` | 1320 | 05(2) |
| `users.md` | 5645 | 03(8) |
| `webhooks.md` | 14182 | 01(4), 03(2) |
| `welcome.md` | 533 | 05(2) |
| `with-clay.md` | 8843 | 03(1) |
| `with-cloudinary.md` | 33092 | 03(1), 05(1) |
| `with-hubspot.md` | 39499 | 03(1), 05(1) |
| `with-lokalise.md` | 27411 | 01(5), 03(2) |
| `with-shopify.md` | 37961 | 03(1), 05(1) |
| `work-with-a-developer.md` | 3414 | 05(2) |

Result: 93 of 115 files are cited by REA 01-04 / `api-contracts.md`; the other 22 (the 20 flagged pages plus
`fields.md` and top-level `prismic-react-v2-migration-guide.md`) are cited only here. With this file, every mirror page
has at least one citation. Re-run: `python3 -I cov.py rea/05-coverage-sweep.md` from `docs/research` (script path in §0).

## Resolution of REQ-SWP-001 (2026-10-19, live probe)
Production rejects double-bracket orderings with HTTP 400 `api_parsing_error`
(`evidence/search.ordering-double-bracket.json`). Smaltic reproduces the rejection; it does not add leniency.
