# Prismic — reverse-engineering analysis (REA)

Date: 2026-10-19. Purpose: specify a self-hosted, wire-compatible equivalent of prismic.io (project
"Smaltic"). Everything below is backed by one of three evidence classes, and every detailed claim in the
sub-reports carries a citation:

| Class | What | Where |
|---|---|---|
| **DOC** | All 114 pages of the official docs (sitemap-complete mirror, fetched as the official `.md` renditions; `robots.txt` allows `ai-input`) | `prismic-docs-mirror/` (git-ignored, regenerate with `tools/crawl-docs.py`); cited as `pages/<file>.md § <heading>` |
| **LIVE** | HTTP captures from Prismic production (`prismic-main`, the repo behind prismic.io) | `evidence/` (index: `evidence/README.md`) |
| **SRC** | Source of the official SDKs: `@prismicio/client` 7.22.3, `types-internal` 4.8.0, `custom-types-client` 2.1.0, `migrate` 0.0.2 | `api-contracts.md` (file:line citations) |

Detailed reports (read these for the contracts):

| Report | Scope | Requirements |
|---|---|---|
| `rea/01-apis-and-delivery.md` | Content API, filters, GraphQL, Tags, Repository, Custom Types API, Migration API, Asset API, Integration Fields, routes, previews, webhooks, environments, CLI/MCP/AI | REQ-API, REQ-WAPI, REQ-PRV, REQ-WH, REQ-ENV, REQ-DEV (113) |
| `rea/02-content-modeling.md` | Type/slice model JSON, all 18 fields (config + filled/empty API shapes), slices & variations, Type Builder vs Slice Machine vs Legacy Builder | REQ-MOD, REQ-FLD (57) |
| `rea/03-product-editor-admin.md` | Page Builder, publishing lifecycle, releases, history, media library, locales, users/roles, settings, plans, environments UI | REQ-ED, REQ-ADM, REQ-MED, REQ-L10N (90) |
| `rea/04-sdks-and-frameworks.md` | What the SDKs/frameworks (client, next, nuxt, svelte, react, vue, richtext, codegen, adapters) need from the server; compat test matrix | REQ-SDK (40) |
| `rea/05-coverage-sweep.md` | Pages not cited by 01–04, swept for anything missed; full page→report coverage table | REQ-SWP |
| `parity-matrix.md` | Generated list of every requirement with priority, source line and build status | 300+ |

## 1. What Prismic is, in one paragraph

Prismic is a hosted headless CMS that calls itself a "headless page builder". Developers model **page
types** and **custom types** made of **fields**, and **slices**: reusable, variant-able page sections
backed by components in the developer's website. Editors compose pages from those slices in the **Page Builder**,
preview them on the real website, and publish them directly or as **releases**, which can be scheduled.
Websites read content through a CDN-cached, ref-versioned **Content API** (REST v2 or GraphQL) using official
SDKs for Next.js, Nuxt and SvelteKit. Since mid-2026, models are edited in the cloud **Type Builder** and
synced with code through the **Prismic CLI**. **Slice Machine** is deprecated (`rea/02` §4, `rea/03` §1).

## 2. System map (what runs where)

| Service | Host (production) | Auth | Evidence |
|---|---|---|---|
| Content API v2 (+ `/api/tags`) | `<repo>.cdn.prismic.io/api/v2` (CloudFront, `x-prismic-version: 6`) | public, or `access_token` for private repos | LIVE `api-root.*`, `search.*` |
| GraphQL API | `<repo>.cdn.prismic.io/graphql` (GET, `Prismic-Ref` header) | same | LIVE `graphql.*` |
| Custom Types API | `customtypes.prismic.io` (`/customtypes`, `/slices`, insert/update/delete) | `repository` header + Bearer | LIVE `protected-endpoints.txt`, SRC §4 |
| Migration API | `migration.prismic.io/documents` | `repository` + Bearer write token | LIVE, SRC §5.2, DOC |
| Asset API | `asset-api.prismic.io/assets` (rate-limited) | `repository` + Bearer | LIVE (10 req/s headers), SRC §5.3 |
| Image CDN | `images.prismic.io/<repo>/…`, which is **imgix** (`server: imgix`) | public | LIVE `image-cdn-probe.txt` |
| Files CDN | `<repo>.cdn.prismic.io/<repo>/<file>` | public | LIVE `field-shapes.observed.md` (link:Media) |
| Preview toolbar | `static.cdn.prismic.io/prismic.js` → iframe on `<repo>.prismic.io/prismic-toolbar/<hash>/iframe.html` | editor session | LIVE `toolbar.prismic.js` |
| Auth / user service | `auth.prismic.io`, `user-service.prismic.io` | — | LIVE `protected-endpoints.txt` |

All write services are AWS API Gateway (`x-amzn-*` headers). Reads are served from CloudFront.

## 3. How content is versioned: refs

Every read is made **at a ref**. `GET /api/v2` lists the refs: the master ref (`id:"master"`, `isMasterRef`)
plus one per release. Each publish mints a new master ref. A search without `ref` returns 400 `Please specify ref`.
An unknown or expired ref returns 404 or 410, and the message ends with `Master ref is: <ref>`. The client
parses that text and retries (LIVE `search.bad-ref.json`, SRC §0.6). Preview sessions are refs too: a
preview token passed as `ref`. The toolbar stores it in the `io.prismic.preview` cookie as JSON keyed by
repository host. The docs name the cookie wrongly (`rea/01` discrepancy register). One mechanism covers
published content, releases and previews, and Smaltic has to reproduce it.

## 4. Read path (Content API)

- Search: `GET /api/v2/documents/search?ref&q&lang&page&pageSize(≤100)&after&orderings&fetch&fetchLinks&graphQuery&routes&access_token&integrationFieldsRef`.
  The authoritative parameter list comes from the live `forms.everything` (LIVE `api-root.prismic-main.json`).
- **Filters (predicates):** `[[at(path, value)]]` … 28 filters (at, not, any, in, fulltext, has, missing,
  similar, geopoint.near, number.lt/gt/inRange, 16 date filters). Each `q` param is ANDed. Exact
  strings: SRC §1.8. Semantics: `rea/01` §filters. Parse errors return 400 `api_parsing_error` (LIVE).
- **Document envelope:** `id, uid, url, type, href, tags, first_publication_date, last_publication_date,
  slugs, linked_documents, lang, alternate_languages, data`. Dates are `YYYY-MM-DDTHH:mm:ss+0000` (LIVE).
- **Field values:** `rea/02` §2 has the filled and empty shape of every field. Production differs from the
  SDK types: an empty content relationship is `{"link_type":"Document"}`, an empty image is `{}`, tables
  are keyed rows and cells, and slices carry ids of the form `<slice_type>$<uuid>` (LIVE
  `field-shapes.observed.md`, scan of 1,983 slices).
- **Routes:** a `routes` JSON param (route resolver) computes `url` for each document and linked document
  (`:uid`, `:lang`, `:lang?`, parent resolvers) (`rea/01` §routes).
- **GraphQL:** a schema generated from the models (`allBlogs(first:)`, `_meta`, slice unions) (LIVE, DOC).

## 5. Write path

- Models: a custom type is `{id, label, repeatable, status, format: "page"|"custom", json: {Tab: {field: {type, config}}}}`.
  Shared slices are `{id, type: "SharedSlice", name, variations[{id, name, primary, items, imageUrl}]}`.
  Model changes that would orphan existing documents are rejected (`rea/02` §1–3, SRC §3–4).
- **Documents:** they are drafted in the editor or created through the Migration API, which writes into a
  *migration release* that is then published. Field input uses the Content API shape with reduced links
  (SRC §5.2, `rea/01` §Migration API).
- **Lifecycle:** Draft → Live → Archived (archiving unpublishes) → Deleted (only from the archive, and
  permanent). History keeps versions, and restoring one turns it into a draft. Releases hold up to 200 pages
  and can be scheduled (`rea/03` §publishing).
- **Webhooks:** triggers for document publish/unpublish, release create/update/delete, tags and test. The
  secret travels in the JSON body. Failed deliveries are retried and endpoints are auto-disabled, with a
  30-day log (`rea/01` §webhooks).

## 6. Editor and admin (behavioural)

The editor has three panes: slice list with live thumbnails, field editor with tabs, and a versions/locale
panel. It also offers slice copy and paste, find, presence, and a slice simulator iframe on the website's
`/slice-simulator` route. The media library has tags, search, crops and alt text, with limits of 10 MB per
image and 100 MB per file. Locales have one master locale, translations are linked by group, and pages can
be copied to another locale (optionally with AI translation). Roles are Owner, Administrator, Publisher and
Writer, plus Enterprise Contributor with per-space and per-locale grants. SSO and environments (cloned
repositories) are also available. Details are in `rea/03`.

## 7. Compatibility constraints that shape Smaltic

1. The SDK infers a repository name only from Prismic hostnames. Users of Smaltic must call
   `createClient("<repo>", { documentAPIEndpoint })` and override the asset, migration and custom-types
   endpoints (SRC §0.1–0.3).
2. Emitted absolute URLs (`forms.tags.action`, `next_page`, `href`) must point at our host (SRC §0.4).
3. The `ref` param must accept a plain ref, a preview token, or the toolbar's JSON cookie (SRC §1.11).
4. Error bodies and their exact wording drive SDK behaviour, including `Master ref is:` and 429 `Retry-After` (SRC §0.6–0.7).
5. `languages[0]` must be the master locale (SRC §0.10).
6. The toolbar accepts a custom host in `repo=` and loads `/prismic-toolbar/<hash>/iframe.html` from it, so
   Smaltic can serve its own preview bridge (LIVE toolbar, `rea/04` §toolbar).
7. Image URLs must be absolute and honour imgix parameters, both `w` and `width`, and `auto=format,compress` (`rea/04` §images).

## 8. Out of scope for Smaltic (with reason)

Billing, plans, Spend Manager and API-call quotas are SaaS commerce and don't apply to self-hosting. Unsplash
integration and the AI features that depend on Prismic's hosted models are P2 at most and pluggable.
Prismic's proprietary UI and branding are not copied; the behaviour is reproduced with an original UI.

## 9. Known documentation vs production discrepancies

These are collected in `rea/01` (discrepancy register, 14 rows) and `rea/02` §open questions. Production
behaviour (LIVE/SRC) wins over the docs wherever they conflict. Examples: the preview cookie name, the
table JSON shape, empty link shapes, `direction:"ltr"` on rich text, the Asset API rate limit, and the
release size limit.
