# REA 04 - SDKs and framework integrations: what they require from the server

Scope: every page under `pages/technical-reference/` (current majors read in full: `prismicio-client/v7`,
`prismicio-next/v2`, `prismicio-react/v3`, `prismicio-vue/v6`, `prismicio-svelte/v3`, `nuxtjs-prismic/v5`,
`prismicio-richtext/v2`, `prismicio-helpers/v2`, `prismicio-migrate/v0`, `prismic-ts-codegen/v1`,
`slice-machine-ui/v1`, all `slicemachine-adapter-*`; older majors skimmed), the `*-migration-guide.md` pages,
`technologies/prismic-react-v2-migration-guide.md`, `prismic-dom-technical-reference.md`, `frameworks.md`,
`nextjs.md`, `nuxt.md`, `sveltekit.md`. A few neighbouring pages (`previews.md`, `routes.md`,
`slice-machine.md`, `slices.md`, `technologies/custom-types-api.md`) were consulted only where an SDK page
points to them for behaviour.

Goal: list every server-side behaviour, endpoint, header, cookie, URL pattern, query parameter, response field
and assumption the official SDKs depend on, so a self-hosted clone works with them unchanged.

Conventions:

- `pages/<file>.md § <heading>` = Prismic docs mirror at `docs/research/prismic-docs-mirror/pages/`.
- `ev/<file>` = live captures in `docs/research/evidence/` (2026-10-19).
- `AC §x` = `docs/research/api-contracts.md` (SDK source analysis by another agent; read-only here). Where
  the docs and AC disagree, both are shown and the item is listed under Open questions.
- **[NOT IN DOCS]** = behaviour the docs do not state; taken from `ev/` or AC, or flagged for source checking.

---

## 0. Executive summary

1. **Every framework integration goes through `@prismicio/client` v7.** Next, React, Vue, Nuxt and Svelte
   add no Content API calls of their own. Server compatibility is mostly "be the Content API v2 that
   `@prismicio/client` expects", plus four browser-side contracts: the **preview toolbar**, the
   **preview cookie**, the **slice simulator** and the **image CDN (imgix semantics)**.
2. **Docs-first configuration uses a repository name.** All current guides call
   `createClient(repositoryName, {...})` (`pages/nextjs.md § The Prismic client`,
   `pages/sveltekit.md § The Prismic client`), and Nuxt v5 documents `endpoint` as "A Prismic repository
   name." (`pages/technical-reference/nuxtjs-prismic/v5.md § PrismicModule`). Users of a clone have to override
   with `documentAPIEndpoint` ("The full Content API V2 endpoint for the repository. Useful if you are using
   a proxy." - `pages/technical-reference/prismicio-client/v7.md § config options`). Per AC §0.1, keep the
   repo name as the first argument and set `documentAPIEndpoint`; a bare custom URL leaves
   `repositoryName` unset, which breaks write clients and preview cookie lookup.
3. **Hosts hard-coded in SDKs with no documented override:** the toolbar loader
   (`https://static.cdn.prismic.io/prismic.js?new=true&repo=<repo>`, AC §0.3, `ev/toolbar.prismic.js`), the
   toolbar bundle (`https://prismic.io/prismic-toolbar/5e015029/...`, `ev/toolbar.prismic.js`), and the
   Slice Machine/CLI back-office hosts. Previews stay tied to Prismic's CDN unless the user overrides the
   toolbar (see §6, Open questions Q1-Q3).
4. **Hosts that are overridable:** Content API (`documentAPIEndpoint`), Asset API (`assetAPIEndpoint`),
   Migration API (`migrationAPIEndpoint`) (`pages/technical-reference/prismicio-client/v7.md § createWriteClient()`),
   Slice Machine Content API (`apiEndpoint` in `slicemachine.config.json`,
   `pages/technical-reference/slice-machine-ui/v1.md § Configure slicemachine.config.json`).
5. **Server output feeds client helpers that have hard assumptions:** absolute image URLs that accept imgix
   query params (existing `auto=format,compress&rect=..&w=..&h=..` kept, `width=`/`dpr=` added); rich text
   as flat blocks with `start`/`end` spans; documents with a resolved relative `url`; link fields with
   `link_type`, `url`, `target`.

---

## 1. Endpoint and authentication model, as seen by the SDKs

### 1.1 Repository name vs endpoint URL

| Package (current) | How the endpoint is given | Docs reference |
|---|---|---|
| `@prismicio/client` v7 | `createClient(repositoryName, config)`; `config.documentAPIEndpoint` overrides | `pages/technical-reference/prismicio-client/v7.md § createClient()`, `§ config options` |
| `@prismicio/client` v6 | `createClient(getEndpoint(repoName))`; `getEndpoint` "ensures the API CDN is used" | `pages/prismic-client-v6-migration-guide.md § Create a client with createClient()` |
| `@prismicio/client` v5 / `prismic-dom` | full URL `https://your-repo-name.cdn.prismic.io/api/v2` | `pages/technical-reference/prismicio-client/v5.md § Example`, `pages/prismic-dom-technical-reference.md § Example` |
| `@prismicio/next` v2 | user-built client in `prismicio.ts`; `PrismicPreview repositoryName=` | `pages/nextjs.md § The Prismic client` |
| `@prismicio/vue` v6 | `createPrismic({ client })` only ("no longer supports creating a client from a repository name") | `pages/technical-reference/prismicio-vue/v6.md § Upgrading from v5` step 3 |
| `@prismicio/vue` v4/v5 | `endpoint`: "repository ID ... or the full API endpoint" | `pages/technical-reference/prismicio-vue/v4.md`, `v5.md § createPrismic` |
| `@nuxtjs/prismic` v5 | module `endpoint` (repo name, default `repositoryName` from `prismic.config.json`) + `clientConfig`, or `client: "~/prismic/client"` file | `pages/technical-reference/nuxtjs-prismic/v5.md § PrismicModule`, `§ Use a custom client, link resolver, etc.` |
| `@nuxtjs/prismic` v4 | `endpoint`: "repository name (recommended) or full endpoint" | `pages/technical-reference/nuxtjs-prismic/v4.md § PrismicModule` |
| `@prismicio/svelte` v3 | user-built client in `src/lib/prismicio.ts`; `PrismicPreview repositoryName=` | `pages/sveltekit.md § The Prismic client` |
| `slice-machine-ui` v1 | `repositoryName`; optional `apiEndpoint` "if you are working behind a network proxy" | `pages/technical-reference/slice-machine-ui/v1.md § Configure slicemachine.config.json` |
| `prismic-ts-codegen` v1 | `repositoryName` + `customTypesAPIToken` (remote models) | `pages/technical-reference/prismic-ts-codegen/v1.md § Loading remote models with the Custom Types API` |

Consequences for the clone:

- The `/api/v2` path is a convention, not a requirement: search is resolved relative to the endpoint
  (`<endpoint>/documents/search`, AC §1.1). Expose `https://<host>/api/v2` anyway, because v5/`prismic-dom`
  docs and `slice-machine-ui` say "use V2 of the API (e.g. `.../api/v2`)".
- The **repository name must be a real identifier on our side**, because (a) `PrismicPreview`/toolbar take
  `repositoryName`, (b) the preview cookie is keyed by repository host (§5), (c) the write client and the
  Custom Types API send a `repository` header (AC §0.1, `pages/technologies/custom-types-api.md § Retrieve
  custom types (GET requests)`), (d) Slice Machine environments swap the repository name
  (`pages/slice-machine.md § Fetch content from an environment`). Repository names must match AC §0.1's
  regex (4+ chars).
- Optional: AC §0.1 lists `wroom.test` among hosts from which the client infers the repository name. With
  `<repo>.wroom.test` as a local dev host, `createClient("https://<repo>.wroom.test/api/v2")` keeps
  `repositoryName` and the toolbar uses the page's protocol for `.test` hosts (`ev/toolbar.prismic.js`,
  function `p`). This is a useful local test setup, not a production pattern.

### 1.2 Access tokens

- Content API: `accessToken` in client config or per query ("Only needed if your repository is private" -
  `pages/technical-reference/prismicio-client/v7.md § config options`). Sent as the `access_token` query
  parameter, no auth header (AC §1.2). GraphQL uses `Authorization: Token <accessToken>` (AC §1.12).
- The Next and SvelteKit guides treat it as a secret ("Do not use it in client-side requests" -
  `pages/nextjs.md § Secure with an access token`). **Nuxt exposes it to the browser**: "The access token is
  public in Nuxt websites" (`pages/nuxt.md § Secure with an access token`, env
  `NUXT_PUBLIC_PRISMIC_ACCESS_TOKEN`). So the Content API is called **from browsers with
  `?access_token=`** and needs permissive CORS (`access-control-allow-origin: *` is live behaviour,
  `ev/README.md`).
- Switching to private is immediate: "Content API requests will immediately require an access token"
  (`pages/nextjs.md § Secure with an access token`, step 3). Private repo without token -> `401
  {"error":"Invalid access token"}` (`ev/api-root.wroom-401.json`).
- Write client: `writeToken` (`pages/technical-reference/prismicio-client/v7.md § createWriteClient()`),
  sent as `authorization: Bearer` + `repository` header (AC §0.8).
- Custom Types API (codegen, Slice Machine): `repository: <name>` + `Authorization: Bearer <token>`
  (`pages/technologies/custom-types-api.md § All custom types`).

### 1.3 Hard-coded hosts and override points

| Host | Used by | Override documented? |
|---|---|---|
| `https://<repo>.cdn.prismic.io/api/v2` | client (`createClient(name)`), `getRepositoryEndpoint` | yes: `documentAPIEndpoint` |
| `https://<repo>.cdn.prismic.io/graphql` | `getGraphQLEndpoint`, `graphQLFetch` users | caller passes URL to GraphQL client (AC §1.12) |
| `https://asset-api.prismic.io/` | write client | yes: `assetAPIEndpoint` |
| `https://migration.prismic.io/` | write client | yes: `migrationAPIEndpoint` |
| `https://customtypes.prismic.io` | codegen remote models, Slice Machine, CLI | not documented for codegen/SM (Q7) |
| `https://static.cdn.prismic.io/prismic.js?new=true&repo=<repo>` | `<PrismicPreview>` (Next, Svelte), `<PrismicToolbar>` (React), Nuxt `toolbar: true` | **no** (Q1) |
| `https://prismic.io/prismic-toolbar/5e015029/{toolbar.js,embedded-preview.js}` | toolbar loader | **no** (`ev/toolbar.prismic.js`) |
| `https://<repoHost>/prismic-toolbar/5e015029/iframe.html` | toolbar loader | yes, implicitly: `repo` param may be a full host (`ev/toolbar.prismic.js`, function `f`) |
| `https://images.prismic.io/<repo>/...` | image URLs returned in content | n/a: the server decides URLs |
| `auth.prismic.io`, `user-service.prismic.io` | Slice Machine / CLI login (`ev/protected-endpoints.txt`) | not documented (Q8) |

---

## 2. `@prismicio/client` v7 (and v5/v6 behaviour that still matters)

### 2.1 Config options that change requests

From `pages/technical-reference/prismicio-client/v7.md § config options`:

| Option | Server impact |
|---|---|
| `accessToken` | `access_token` query param on every request (incl. `/api/v2`). |
| `routes` | Route resolvers sent with every query ("sent on every API request", `pages/routes.md` intro); the server fills each document's and each link's `url`. Fields: `type`, `path`, `resolvers?`, `uid?`, `lang?`. |
| `brokenRoute` | `url` value the server emits for broken links ("A link is broken when its linked page has been unpublished or deleted"). |
| `defaultParams` | Any query parameter, merged into each query. Server must accept every documented param. |
| `fetchOptions` | Client-only (`RequestInit`); Next uses `{ next: { tags: ["prismic"] }, cache: "force-cache" }` (`pages/nextjs.md § The Prismic client`). No server impact, but responses are cached forever until revalidated, so webhooks must fire (see 2.8). |
| `documentAPIEndpoint` | Base URL of our Content API. |
| `fetch` | Client-only. |
| `ref` | Fixed ref (string or async function). Server must accept any ref it issued (master, release, preview token). |

`integrationFieldsRef` is a query param (`§ Query parameters`) and a repository field (`§ getRepository()`).

### 2.2 Query parameters the server must accept

From `pages/technical-reference/prismicio-client/v7.md § Query parameters`: `filters` (sent as `q`),
`graphQuery`, `orderings` (array of `{field, direction}`; default `asc`), `lang` (`"*"` = all locales),
`page`, `pageSize`, `after` (a page ID; "Can be used along with the `orderings` parameter"), `accessToken`,
`brokenRoute`, `fetchLinks`, `integrationFieldsRef`, `ref`, `routes`, deprecated `fetch` and `predicates`.

Live wire names (`ev/README.md`, `forms.everything`): `ref, q, lang, page, pageSize, after, fetch,
fetchLinks, graphQuery, orderings, referer, routes, access_token, integrationFieldsRef`. Exact
serialisation (e.g. `orderings=[my.product.price desc]`, `routes` as JSON) is in AC §1.5.

Limits: "The default and maximum page size is 100 documents" and `pageSize` "can be an integer from 1 to
100" (`pages/technical-reference/prismicio-client/v6.md § Query methods`, `§ Params object`). Live: 101 is
clamped to 100 (`ev/search.pagesize-101.json`).

### 2.3 Query methods -> wire calls

All query methods are `GET <endpoint>/documents/search` with a `q` filter set. The mapping (filter strings
in AC §1.8):

| Method | Filter / params produced | Return contract (docs) |
|---|---|---|
| `get(params)` | as given | paginated envelope |
| `getFirst(params)` | as given (+ `pageSize=1` per AC) | first doc; "Throws `NotFoundError`" if none |
| `getByID(id)` / `getByIDs(ids)` / `getAllByIDs(ids)` | `document.id` at / in | v6: "Documents will be returned in the order provided" (`pages/technical-reference/prismicio-client/v6.md § Query methods`) |
| `getByUID(type, uid)` / `getByUIDs` / `getAllByUIDs` | `document.type` + `my.<type>.uid` | `NotFoundError` if none |
| `getSingle(type)` | `document.type` | `NotFoundError` if none |
| `getByType` / `getAllByType` | `document.type` | |
| `getByTag` / `getAllByTag` | `document.tags` at | |
| `getByEveryTag` / `getAllByEveryTag` | `document.tags` at (array) | |
| `getBySomeTags` / `getAllBySomeTags` | `document.tags` any | |
| `dangerouslyGetAll` | none | v6: "Querying all documents in your repository is not performant" |

Pagination envelope (`§ get()` return value): `results`, `page`, `total_pages`, `results_size`,
`results_per_page`, `total_results_size`, `next_page` (string or null, "The API URL to the next page"),
`prev_page`. `getAll*` recurse: "This method may make multiple network requests". v6 adds: "the get-all
methods are throttled ... wait at least 500ms before sending each subsequent request ... no effect on queries
returning fewer than 100 documents" (`pages/technical-reference/prismicio-client/v6.md § Query methods`).
AC §0.9: `dangerouslyGetAll` paginates by the body's `page` number, so `next_page` needs to be non-null only
when more pages exist; it should still be an absolute URL on our host.

Release/ref selection (`§ queryLatestContent()`, `§ queryContentFromReleaseByID()`,
`§ queryContentFromReleaseByLabel()`, `§ queryContentFromRef()`): the client picks a ref from the
`/api/v2` `refs` list by `id` or `label` ("A release's label is its name shown in the Page Builder"), or uses
the supplied ref.

### 2.4 Repository methods -> `/api/v2` fields

`getRepository()` returns (`§ getRepository()`): `refs[]`, `languages[]`, `types` (API ID -> label),
`integrationFieldsRef`, `license`, `oauth_initiate`, `oauth_token`, `version`, deprecated `bookmarks`,
`experiments`, `forms`, `tags`. Ref: `id`, `ref`, `label` ("The master ref is always named \"Master.\""),
`isMasterRef`, `scheduledAt?`. Language: `id`, `name`, `is_master`. Live master ref `id` is `"master"`
(`pages/technical-reference/prismicio-client/v6.md § Repository methods` example).

- `getRefs()`, `getRefByLabel(label)` ("Throws `PrismicError` if a matching release cannot be found"),
  `getMasterRef()`, `getReleases()`, `getReleaseByID()`, `getReleaseByLabel()` all derive from `refs`.
- `getTags()`: "Fetches the repository's page tags" -> `string[]`. Per AC §1.3 it follows
  `forms.tags.action` from `/api/v2` (absolute URL, so it must point at our host), falling back to `tags`.
  So `forms` is "deprecated" in docs but still load-bearing.
- `buildQueryURL(params)`: builds the search URL locally; no server call.
- `graphQLFetch`: "adds the required `prismic-ref` and `Authorization` headers" (`§ graphQLFetch()`).

### 2.5 Preview-related client API

- `resolvePreviewURL({ previewToken, documentID, defaultURL = "/", linkResolver? })`: "The token and page ID
  are provided in the URL opened after clicking the Page Builder's **Preview the page** button"
  (`§ resolvePreviewURL()`). URL params are `token` and `documentId`: "It also automatically reads the
  `token` and `documentId` URL parameters" (`pages/prismic-client-v6-migration-guide.md § Replace
  getPreviewResolver() with resolvePreviewURL()`). Returns the doc's URL "or `defaultURL` if a matching page
  cannot be found". On the wire: `getByID(documentID, { ref: previewToken, lang: "*" })` (AC §1.11), so a
  preview token must work as a `ref` and return draft documents with a resolved `url`.
- Cookie export: `cookie.preview` "has the same value used to identify the Prismic preview cookie"
  (`pages/prismic-client-v6-migration-guide.md § Replace previewCookie with cookie.preview`); the value is
  `io.prismic.preview` (AC §1.11, `ev/toolbar.prismic.js`).
- Auto previews: v6 documents `enableAutoPreviews()` ("This is the client's default mode"),
  `enableAutoPreviewsFromReq(req)` ("Accepts a server request object containing the request's headers and
  cookies") and `disableAutoPreviews()` (`pages/technical-reference/prismicio-client/v6.md § Repository
  methods`). The v7 page no longer lists them, but `@prismicio/next` and `@prismicio/svelte` call
  framework-level `enableAutoPreviews()` that configure the client from the cookie. Effect on the wire: the
  raw cookie value is sent as `ref` (AC §0.5).
- v5 legacy: `Prismic.client(endpoint, { req })` "assigns a cookie to the `req` object"
  (`pages/technical-reference/prismicio-client/v5.md § Usage`); v6 replaced `getPreviewResolver(token,
  documentId).resolve(linkResolver, '/')`.

### 2.6 Filters

Functions (`§ Query filters`): `at`, `not`, `any`, `in`, `fulltext`, `has`, `missing`, `similar`,
`geopointNear`, `numberLessThan`, `numberGreaterThan`, `numberInRange`, `dateAfter`, `dateBefore`,
`dateBetween`, `dateDayOfMonth[After|Before]`, `dateDayOfWeek[After|Before]`, `dateMonth[After|Before]`,
`dateYear`, `dateHour[After|Before]`. Semantics the server must reproduce, stated in docs:

- `at`/`not`/`any`: paths `document.type|tags|id`, `my.<type>.uid`, key text, select, number, date,
  boolean, content relationship fields; "A `string[]` is only allowed when `path` is `document.tags`".
- `in`: only `document.id` and `my.<type>.uid`.
- `fulltext`: `document`, `my.<type>.uid`, rich text, text, select fields.
- `has` / `missing`: `my.<type>.<field>`, "Groups and slices are not supported"; `missing` "will restrict
  the results to the page type provided in `path`".
- `similar(documentID, specificity)`: "maximum number of pages that a term may appear in".
- `geopointNear(path, lat, lng, radius)`: radius in km, "sorted from nearest to farthest".
- `numberLessThan`/`GreaterThan`: strict; `numberInRange`: inclusive.
- Date filters accept "ISO 8601 date or timestamp (e.g. `2002-08-28` or `2002-08-28T15:30:00+0300`), a
  13-digit Epoch timestamp ... or a Date"; paths `document.first_publication_date`,
  `document.last_publication_date`, date and timestamp fields. Day-of-week values `monday`/`mon`/`1` ...
  `sunday`/`sun`/`7`; months `january`/`jan`/`1` ...; "Strings can be capitalized ... or all caps".
- v6 renamed predicates (`gt` -> `numberGreaterThan`, `near` -> `geopointNear`, `dayOfMonth` ->
  `dateDayOfMonth` ...) (`pages/prismic-client-v6-migration-guide.md § Replace Predicates with predicate`).
  Old clients send the same wire strings? Unknown (Q11).

### 2.7 Write client (`createWriteClient`)

- Endpoints default to `https://asset-api.prismic.io/` and `https://migration.prismic.io/`, overridable
  (`§ createWriteClient()`). "This client is only for migration scripts."
- `migrate(migration, { reporter })` events: `start`, `end`, `assets:creating`, `assets:created`,
  `documents:masterLocale` ("Fetching the master locale for a page"), `documents:creating`,
  `documents:created`, `documents:updating`, `documents:updated` (`§ migrate()`). So `migrate()` reads the
  repository (languages), uploads assets, creates documents then updates them (two-pass to resolve
  relationships).
- `publishMigrationRelease()` returns `{ totalItems }`; "Publishing is processed asynchronously".
- `createAsset(file | url, filename, { alt, notes, credits, tags })`; URL inputs are downloaded client-side;
  "Assets are deduplicated in a `Migration` instance".
- `createDocument(document, title, { masterLanguageDocument })`, `updateDocument(document, title?)`,
  `createDocumentFromPrismic(document, title)` ("also works with pages from external Prismic
  repositories"), documents "in API v2 format".
- Needs `File`, `Blob`, `FormData` (multipart upload to the Asset API).
- Wire details (queue 1500 ms, `Retry-After`, master locale = `languages[0]`) in AC §0.7, §0.10.

### 2.8 Content helpers that constrain server output

- `asDate(field)`: date `YYYY-MM-DD`, timestamp `2020-11-19T16:45:39+0000`
  (`pages/technical-reference/prismicio-helpers/v2.md § asDate(field)`); `null` if empty.
- `asLink(fieldOrDocument, { linkResolver })`: "If you are not using a link resolver, use `field.url` or
  `document.url` instead" (`pages/technical-reference/prismicio-client/v7.md § asLink()`), so the server
  must populate `url` on documents and Document links when `routes` are given.
- `asLinkAttrs`: `target` `"_blank"` "if the field's \"Open in new tab\" option is checked"; `rel`
  `"noreferrer"` "if the link is external" (`§ asLinkAttrs()`). Internal = URL starting with `/` (AC §1.13),
  so **route-resolved `url` values must be root-relative paths**.
- `asHTML` / `asText` (separator default `" "`), see §9 for node types.
- `asImageSrc`, `asImageWidthSrcSet`, `asImagePixelDensitySrcSet`: see §8.
- `mapSliceZone(slices, mappers, context)`: client-only; keyed by slice type ID.
- `isFilled.*`: `color, contentRelationship, date, embed, geoPoint, group, image, imageThumbnail,
  integrationField, keyText, link, linkToMedia, number, richText, select, table, timestamp, title`, plus
  `repeatable` and `sliceZone` (`§ isFilled`). Empty-value encodings must match (AC §1.14).

### 2.9 Errors the SDK surfaces

`NotFoundError` (getFirst/getByID/getByUID/getSingle when no match), `PrismicError` (unknown release label/ID)
(`pages/technical-reference/prismicio-client/v7.md`, each method's "Possible errors"). Status/body mapping
(404 ref-not-found with "Master ref is:" retry, `PreviewTokenExpiredError`, 401, 429) is in AC §1.7.

---

## 3. Framework packages

### 3.1 `@prismicio/next` v2 (App Router default; Pages Router via `@prismicio/next/pages`)

Server calls: none of its own; it configures the user's client and wraps `resolvePreviewURL`.

| API | Behaviour relevant to the server | Source |
|---|---|---|
| `<PrismicPreview repositoryName updatePreviewURL="/api/preview" exitPreviewURL="/api/exit-preview">` | Injects the toolbar script for `repositoryName`; "Webpages are automatically refreshed when a new content draft is saved"; fetches `updatePreviewURL` "when draft content is updated" and `exitPreviewURL` "when exiting a preview session". | `pages/technical-reference/prismicio-next/v2.md § <PrismicPreview>` |
| `enableAutoPreviews({ client })` (App) / `({ client, req, previewData })` (Pages) | "Configures a Prismic client to automatically fetch draft content during a preview session" (Draft Mode + preview cookie -> ref). | `§ enableAutoPreviews()` |
| `redirectToPreviewURL({ client, request, linkResolver?, defaultURL = "/" })`; Pages adds `basePath` | Used in `/api/preview`; calls `client.resolvePreviewURL` with `token`/`documentId` from the request and redirects. | `§ redirectToPreviewURL()` |
| `exitPreview()` | "Ends a Prismic preview by exiting Draft Mode"; only in a Route Handler. | `§ exitPreview()` |
| `setPreviewData({ req, res })` (Pages only) | "Sets data in Next.js' Preview Mode cookie needed to support content previews". | `§ setPreviewData()` |
| `<SliceSimulator zIndex background className>` | Live slice previews; children typically `<SliceZone>`. App Router page uses `getSlices(state)` on `searchParams.state`. | `§ <SliceSimulator>`, `pages/slice-machine.md § Slice simulator page` |
| `<PrismicNextImage field imgixParams alt fallbackAlt fallback loader>` | "Images are served via imgix by default" (custom `next/image` loader). `loader={undefined}` switches to the Next optimizer. | `§ <PrismicNextImage>`, `pages/technical-reference/prismicio-next/v1.md § <PrismicNextImage>` |
| `<PrismicNextLink field|document|href rel linkResolver>` | Uses `url`, `target`; external -> `rel="noreferrer"`. | `§ <PrismicNextLink>`, v1 page |
| `createLocaleRedirect()` | Removed in v2 ("significantly slowed down websites"); the guide's replacement is static and makes no API call ("Statically defining your locales avoids a Prismic API call"). | `§ createLocaleRedirect()`, `pages/nextjs.md § Internationalization` |

Generated project conventions (`pages/nextjs.md`):

- `prismic.config.json` = `{ repositoryName, routes[] }`; default routes: Homepage `/`, Page `/:uid`,
  others `/<api-id>/:uid` (`§ Define routes`).
- `/api/preview` (start), `/api/exit-preview` (end), `/api/revalidate` (webhook target, triggers
  `documentsPublished`, `documentsUnpublished`), `app/slice-simulator/page.tsx` (`§ Preview draft content`,
  `§ Handle content changes`, `§ Live previews in the Page Builder`).
- Preview URL registered in the repository: `npx prismic preview add http://localhost:3000/api/preview
  --name Development`; simulator: `npx prismic preview set-simulator http://localhost:3000`.
- Proxy matcher excludes `slice-simulator` and `api` (`§ Internationalization` step 5).
- `generateStaticParams` uses `getAllByType("page", { lang: "*" })`, so the server is hit at build time with
  `lang=*` and must return every locale's `lang` and `uid`.

### 3.2 `@prismicio/react` v3

No server calls ("We only guarantee support with Next.js websites" - `pages/technical-reference/prismicio-react/v3.md § Overview`).

- `<PrismicImage>`: `imgixParams`, `widths` (`"thumbnails"` or `"defaults"` =
  `[640, 750, 828, 1080, 1200, 1920, 2048, 3840]`), `pixelDensities` (`"defaults"` = `[1, 2, 3]`)
  (`§ <PrismicImage>`).
- `<PrismicRichText components>`: node keys listed in §9; `<PrismicTable>`: `table, thead, tbody, tr, th,
  td` plus `paragraph, em, strong, hyperlink` (`§ <PrismicTable>`).
- `<SliceZone slices components defaultComponent context>`: dispatch on `slice_type`.
- `<PrismicToolbar repositoryName>`: injects the toolbar script (`§ <PrismicToolbar>`). v2 also had
  `type="legacy"`: "If your repository requires the legacy Prismic Toolbar, provide a `type` prop"
  (`pages/technical-reference/prismicio-react/v2.md § <PrismicToolbar>`).
- v2 data hooks (`usePrismicDocumentByUID` etc.) and `usePrismicPreviewResolver` map 1:1 onto client
  methods (`pages/technical-reference/prismicio-react/v3.md § Upgrade from v2`, step 6 table), so they
  fetch from the browser: CORS needed.

### 3.3 `@prismicio/vue` v6 and `@nuxtjs/prismic` v5

- `createPrismic({ client, linkResolver?, components? })` injects `client` and `isFilled`
  (`pages/technical-reference/prismicio-vue/v6.md § createPrismic`). Components mirror React (`PrismicImage`
  widths default from plugin; `PrismicLink`; `PrismicText`; `PrismicRichText`; `PrismicTable`; `SliceZone`;
  `<SliceSimulator v-slot="{ slices }">` with `zIndex`, `background`).
- Nuxt module (`pages/technical-reference/nuxtjs-prismic/v5.md § PrismicModule`): `endpoint` (repo name,
  default from `prismic.config.json`), `clientConfig` (default `routes` from `prismic.config.json`),
  `client` file (default `~/prismic/client`), `preview` (default `"/preview"`, `false` disables), `toolbar`
  (default `true`: "The toolbar is required for content previews to work").
- `usePrismicPreview({ defaultURL = "/" })` "Resolves a content preview on the `preview` entry page"; the
  module creates `/preview` by default (`§ usePrismicPreview`). So **the preview URL registered on the
  server is `<site>/preview`** for Nuxt (`pages/nuxt.md § Preview draft content`: `npx prismic preview add
  http://localhost:3000/preview`), versus `/api/preview` for Next and SvelteKit.
- Content is fetched in `useAsyncData` (SSR, then hydration); during static generation (`nuxt generate`) a
  webhook must trigger rebuilds (`pages/nuxt.md § Handle content changes`).
- Browser-visible access token (§1.2).
- Overriding the endpoint: through `clientConfig.documentAPIEndpoint` or a custom `~/prismic/client` file;
  whether `endpoint` may still be a URL in v5 is unclear (Q4).

### 3.4 `@prismicio/svelte` v3 (SvelteKit via `@prismicio/svelte/kit`)

- `<PrismicPreview repositoryName routePrefix="preview" routePrefixName="preview">`
  (`pages/technical-reference/prismicio-svelte/v3.md § <PrismicPreview>`).
- `enableAutoPreviews({ client, cookies })`: "The `cookies` object provided to a route's `load()` function.
  This parameter is required to load previews" (`§ enableAutoPreviews()`). The preview cookie is read
  server-side from the website's own cookies.
- `redirectToPreviewURL({ client, request, cookies, defaultURL = "/", routePrefix = "preview" })`, in
  `src/routes/api/preview/+server.ts` (`§ redirectToPreviewURL()`, `pages/sveltekit.md § Preview draft content`).
- Routing: pages live under `src/routes/[[preview=preview]]/...`; preview sessions render under
  `/preview/<path>` and skip prerendering (`pages/sveltekit.md § Preview draft content`). The redirect
  prefixes the resolved document `url`, so it **must be a root-relative path** (REQ-SDK-017).
- Components as React/Vue plus `<PrismicEmbed>` and `<SliceSimulator>` with a `children({ slices })` snippet.
- Load functions pass SvelteKit `fetch` into the client (`createClient({ fetch, cookies })`), so requests run
  server-side during SSR/prerender.

### 3.5 Older framework packages (behaviour still relevant)

- `@prismicio/next` v0.1/v1: `<PrismicPreview>` "adds event listeners for Prismic Toolbar events like
  `prismicPreviewUpdate` and `prismicPreviewEnd`"; `exitPreview` route "will be fetched" when the editor
  clicks exit in the toolbar (`pages/technical-reference/prismicio-next/v1.md § <PrismicPreview>`,
  `§ exitPreview()`). Same event names as the live toolbar (`ev/toolbar.prismic.js`).
- `@prismicio/vue` v2-v5, `@nuxtjs/prismic` v4: accept a full endpoint URL (§1.1).
- `@prismicio/react` v2: browser-side hooks; `usePrismicPreviewResolver` "will automatically read the preview
  session's URL parameters" (`pages/technical-reference/prismicio-react/v2.md § usePrismicPreviewResolver(params)`).
- `slice-machine-ui` v0 used `sm.json` with `apiEndpoint` (`pages/technical-reference/slice-machine-ui/v0.md`).

---

## 4. Tooling packages

### 4.1 `prismic-ts-codegen` v1

- Reads model JSON **locally** (`models: ['./customtypes/**/index.json', './slices/**/model.json']`) or
  **remotely** from the Custom Types API with `repositoryName`, `customTypesAPIToken`
  (`PRISMIC_CUSTOM_TYPES_API_TOKEN`) and `models.fetchFromRepository: true`; "Local models take priority over
  ones fetched remotely" (`pages/technical-reference/prismic-ts-codegen/v1.md § Loading remote models with the Custom Types API`).
- Remote calls: `GET https://customtypes.prismic.io/customtypes` and `GET .../slices` with `repository` +
  `Authorization: Bearer` headers, `200` JSON arrays (`pages/technologies/custom-types-api.md § All custom
  types`, `§ All shared slices`). No documented host override (Q7).
- Model shape it depends on: custom type JSON (`id`, `label`, `repeatable`, `status`, `json` tabs with fields,
  `format`) and shared slice JSON (`id`, `name`, `variations[]` with `primary`/`items`). Generated names:
  `${Pascal(id)}Document`, `${Pascal(id)}Slice`, `${Slice}${Variation}`, `...Item`; legacy non-shared slices
  are named with their custom type ID (`§ Generated types`). The model must keep field types as Prismic
  names (e.g. `StructuredText` with `config.multi`, as in `pages/technical-reference/prismicio-migrate/v0.md
  § htmlAsRichText()`).
- Depends on `@prismicio/types` (deprecated, now in `@prismicio/client`).

### 4.2 `slice-machine-ui` v1 and adapters (deprecated, still used by existing projects)

- "Slice Machine is deprecated. It is replaced by the Type Builder and the Prismic CLI"
  (`pages/technical-reference/slice-machine-ui/v1.md` banner).
- Runs locally at `http://localhost:9999` (`pages/slice-machine.md` intro).
- `slicemachine.config.json`: `repositoryName`, `libraries`, `adapter` (string or `{resolve, options}`),
  `localSliceSimulatorURL` (e.g. `http://localhost:3000/slice-simulator`), `apiEndpoint` ("You can override
  the API endpoint using this property if you are working behind a network proxy"). Adapter options:
  `format`, `lazyLoadSlices`, `typescript`, `jsxExtension` (Next), `generatedTypesFilePath` (default
  `prismicio-types.d.ts`), `environmentVariableFilePath` (default `.env.local`)
  (`pages/technical-reference/slicemachine-adapter-next/v0.1.md § Usage`, `pages/slice-machine.md`).
- Talks to: Custom Types API (push/pull models, screenshots), Content API (`apiEndpoint`), auth and user
  services (login, repository list, environments). Hosts per `ev/protected-endpoints.txt`. The docs give no
  env-var override for those hosts (Q8).
- Environments: SM writes `NEXT_PUBLIC_PRISMIC_ENVIRONMENT` / `NUXT_PUBLIC_PRISMIC_ENVIRONMENT` /
  `VITE_PRISMIC_ENVIRONMENT` and the client does `repositoryName = env || sm.repositoryName`
  (`pages/slice-machine.md § Select an environment`, `§ Fetch content from an environment`). So **an
  environment is addressed as a different repository name**.
- Adapters' simulator pages: `@slicemachine/adapter-next/simulator` (`sliceZone` render prop),
  `@slicemachine/adapter-nuxt/simulator`, `@slicemachine/adapter-sveltekit/simulator` (`let:slices`);
  current projects use `@prismicio/next|vue|svelte` `SliceSimulator` instead.
- `@slicemachine/init` creates the repository and installs `@prismicio/slice-simulator-react`
  (`pages/technical-reference/slice-machine-ui/v1.md § init script`).

### 4.3 Prismic CLI (`npx prismic`) touchpoints referenced by the framework guides

Not in this scope beyond listing what the framework guides make it do on the server (owner: CLI/back-office
analysis): `init [--repo]` (create repository, write `prismic.config.json`), `token create` (access token),
`repo set-api-access private`, `preview add <url> --name`, `preview set-simulator <url>`, `webhook create
<url> --trigger documentsPublished --trigger documentsUnpublished`, `locale add fr-fr`, `gen setup`
(`pages/nextjs.md`, `pages/nuxt.md`, `pages/sveltekit.md`). It also reads `slicemachine.config.json` in
legacy projects (`pages/slice-machine.md`).

### 4.4 `@prismicio/migrate` v0

Pure client-side: `htmlAsRichText(html, { serializer, container, exclude, include, direction, model })` ->
`{ result, warnings }`. Output nodes carry `type`, `text`, `spans`, optional `direction: "rtl"`
(`pages/technical-reference/prismicio-migrate/v0.md § htmlAsRichText()`). Server impact: the Migration API
must accept rich text with `direction`, labels (`{ label: "code" }` spans), and validate against the field's
`config.multi` set.

---

## 5. Full-website preview: end-to-end contract

Docs view (`pages/previews.md § How full-website previews work`): "Prismic generates a temporary, secure ref
(token) for the preview session"; "Your preview route detects the cookie and fetches draft content using the
ref". Combined with SDK docs and evidence:

1. Repository stores **one or more preview URLs** (per website) and **one slice simulator URL**
   (`pages/previews.md § Set up previews`). Examples: `https://example.com/api/preview` (Next, SvelteKit),
   `https://example.com/preview` (Nuxt).
2. Editor clicks "Preview the page". Back office creates a preview ref and opens
   `<previewURL>?token=<previewRef>&documentId=<documentId>` (param names: `pages/prismic-client-v6-migration-guide.md
   § Replace getPreviewResolver() with resolvePreviewURL()`).
3. Website route: Next `redirectToPreviewURL` (+ Draft Mode / `setPreviewData`), SvelteKit
   `redirectToPreviewURL` (+ `cookies`), Nuxt `usePrismicPreview` on `/preview`. Each calls
   `client.resolvePreviewURL`, i.e. `GET <endpoint>/documents/search?ref=<token>&q=[[at(document.id,"<id>")]]&lang=*...`
   (AC §1.11) and redirects to the doc's `url` or `defaultURL`.
4. The website page loads the toolbar script. The toolbar connects to `https://<repoHost>/prismic-toolbar/
   5e015029/iframe.html`, learns the session ref, and writes cookie `io.prismic.preview` on the **website's
   own domain** (`ev/toolbar.prismic.js`). Note the docs say "Prismic sets a `preview.prismic.io` cookie"
   (`pages/previews.md`); evidence shows the name `io.prismic.preview` (Q5).
5. Every SSR request in preview mode sends the cookie value as `ref` to the Content API (AC §0.5). The clone
   must accept: plain preview ref; JSON blob `{"_tracker":"..","<repoHost>":{"preview":"<ref>"}}` (possibly
   partly URL-encoded), using the entry for its own repository host.
6. The toolbar polls the session (every 3 s while visible, `setInterval(N,3e3)` in `ev/toolbar.prismic.js`).
   When the ref changes it rewrites the cookie and fires `prismicPreviewUpdate`; framework components fetch
   `updatePreviewURL` (`/api/preview`) and refresh. Exit fires `prismicPreviewEnd`; components fetch
   `exitPreviewURL` (`/api/exit-preview`).
7. Cross-tab sync cookie `io.prismic.preview.updated` = `{"version":2,"repository","ref","at"}`, valid 10 min
   (`C=6e5` in `ev/toolbar.prismic.js`).
8. Share: toolbar "Get a shareable link"; "Shareable links are temporary and expire"; viewers need no
   repository access (`pages/previews.md § Share previews`). RPC method `share` (`ev/toolbar.prismic.js`).
9. Expired tokens: Content API returns the preview-expired error -> `PreviewTokenExpiredError` (AC §1.11).

## 6. Toolbar contract

- Loader URL injected by SDKs: `https://static.cdn.prismic.io/prismic.js?new=true&repo=<repositoryName>`
  (AC §0.3; the loader itself prints this snippet: "Add your repository name to the toolbar script"). React v2
  `type="legacy"` used a different "legacy script".
- `repo` parsing (`ev/toolbar.prismic.js`, function `f`): first comma-separated item, lower-cased, protocol and
  path stripped; **no dot -> `<repo>.prismic.io`; with a dot -> used as host (custom host OK)**; `.cdn.`
  removed; must match `host[:port]`. Protocol: `https:` unless host ends with `.test` (then page protocol).
- Iframe: `<proto>//<repoHost>/prismic-toolbar/5e015029/iframe.html`, handshake
  `postMessage({type:"prismic-toolbar:connect"}, origin, [port])`, reply `prismic-toolbar:ready`, then
  JSON-RPC-like messages `{id, result|error}`; methods include `getState` (returns `{isAuthenticated,
  preview:{ref,...}}`), `ping`, `closeSession`, `share`; 15 s timeout.
- UI bundle: `https://prismic.io/prismic-toolbar/5e015029/toolbar.js` (`mountToolbar`) and
  `embedded-preview.js` (`setupEmbeddedPreview`), loaded from Prismic, not from `repoHost`.
- Embedded mode: when the site runs inside the Page Builder iframe with `window.name` =
  `prismic:embedded-preview` (push) or `prismic:embedded-preview:poll`; the poll variant writes a plain cookie.
- Cookie attributes: `path=/`, no `domain`; `SameSite=None; Secure` when framed on https/localhost, else
  `SameSite=Lax`.
- Window events: `prismicPreviewStart`, `prismicPreviewUpdate`, `prismicPreviewEnd`, `CustomEvent` with
  `detail {ref}`, cancelable (frameworks call `preventDefault` to handle reloads themselves).
- Clone implication: with unmodified SDKs, the loader and UI come from Prismic's CDN and only the iframe comes
  from our host, and only if the `repo` value contains a dot. Next/Svelte `<PrismicPreview repositoryName>` is
  a free string, so `repositoryName="cms.example.com"` would route the iframe to us (Q2). Nuxt derives it from
  `endpoint` (Q3).

## 7. Slice simulator contract

- The Page Builder (and Slice Machine) load the site's `/slice-simulator` page in an iframe
  (`pages/slice-machine.md § Slice simulator page`). Flow (`pages/previews.md § How live previews work`):
  editor converts content "to Prismic's Content API format in real-time"; "Data is sent through an iframe
  bridge using `window.postMessage()`"; "The route receives content data and stores it as a compressed URL
  parameter". Next App Router reads it with `getSlices(searchParams.state)`.
- Mocks: Slice Machine's simulator has a "mock editor" ("Fill in content with the mock editor to the right" -
  `pages/slice-machine.md` slice simulator steps); mock content is generated by the tool, not by the Content
  API. The simulator page itself never calls the Content API.
- The simulator URL is a repository setting ("A repository holds one, and each change replaces it" -
  `pages/previews.md § Set up previews`); can be set from any document via "Live preview settings".
- Embedding constraints: blocked by `X-Frame-Options` / `frame-ancestors`
  (`pages/slice-machine.md § The simulator cannot render slices`); on Vercel needs
  `x-vercel-protection-bypass` + `x-vercel-set-bypass-cookie=samesitenone` (`pages/slices.md § Slice preview
  fails on Vercel with password protection`). Chrome "Local network access" prompt for `prismic.io` when the
  simulator is on localhost (`pages/slice-machine.md` troubleshooting).
- Clone implication: our editor must speak the simulator postMessage protocol and the `state` URL encoding of
  `@prismicio/simulator` (not documented; Q9). Slice payloads must be Content API slices: `id`
  (`<slice_type>$<uuid>`), `slice_type`, `slice_label`, `variation`, `version`, `primary`, `items`
  (`pages/slices.md § API Response`).

## 8. Image contract

- "Prismic serves images from imgix" (`pages/technical-reference/prismicio-client/v7.md § asImageSrc()`).
  Live API URLs already carry params: `https://images.prismic.io/<repo>/<file>.png?auto=format,compress&rect=0,0,1248,936&w=1600&h=1200`
  (`ev/search.homepage.json`); docs: "By default, all image URLs from Prismic apply the
  `auto=format,compress` URL parameter" and it can be removed with `auto: undefined`
  (`pages/technical-reference/prismicio-helpers/v2.md § asImageSrc()`).
- SDK appends/overrides query params on that URL (never rewrites the path):
  - `asImageSrc(field, { sat: -100 })` -> `...?auto=format,compress&sat=-100`.
  - `asImageWidthSrcSet`: entries `?width=640 640w`... (docs examples use `width`, not `w`); defaults: v7 docs
    `[640, 750, 828, 1080, 1200, 1920, 2048, 3840]` (`prismicio-client/v7.md § asImageWidthSrcSet()`),
    helpers v2 docs `640, 828, 1200, 2048, 3840`, AC §1.13 (source 7.22.3) `[640, 828, 1200, 2048, 3840]`
    (Q10). With responsive views, each view's own URL with `width=<view width>`, base at its own width
    (`prismicio-helpers/v2.md § asImageWidthSrcSet()`). AC: it removes `w`/`h` then sets `width`.
  - `asImagePixelDensitySrcSet`: `?dpr=1 1x, ?dpr=2 2x, ?dpr=3 3x`.
  - `<PrismicNextImage>` default loader: imgix-style loader; params in `imgixParams` "applied before passing
    the image URL to the loader" (`prismicio-next/v1.md § <PrismicNextImage>`). Exact loader params are
    [NOT IN DOCS] (Q10).
- Server/CDN requirements: absolute URL; honour imgix params at least `auto` (`format`, `compress`), `rect`,
  `w`, `h`, `width`, `height`, `dpr`, `fit`, `q`, `fm`, `sat`, `blur` (live probe `ev/image-cdn-probe.txt`);
  the field must include `dimensions {width,height}` (used for width/height attributes and thumbnail widths),
  `alt`, `copyright`; thumbnail views as extra keys on the image object (AC §1.13).
- Media links (`link_type: "Media"`) are plain absolute file URLs (no imgix).

## 9. Rich text and table node types (renderers in every SDK)

Block types: `heading1`-`heading6`, `paragraph`, `preformatted`, `list`, `oList`, `listItem`, `oListItem`,
`image`, `embed`; inline: `strong`, `em`, `hyperlink`, `label`, `span`
(`pages/technical-reference/prismicio-react/v3.md § <PrismicRichText>`; same list in Vue v6 and Svelte v3).

Server-side shape implied:

- Blocks are a **flat array**: `{type, text, spans:[{start, end, type, data?}], direction?}`; the SDK groups
  consecutive `listItem`/`oListItem` into `list`/`oList` itself, and splits text into `span` nodes
  (`pages/technical-reference/prismicio-richtext/v2.md § asTree()` example: span `{start:19,end:23,type:"strong"}`).
  `list`/`oList`/`span` are never emitted by the server.
- `hyperlink` span `data` is a link field (`asLink(node.data, linkResolver)`); `label` span
  `data: {label: "codespan"}` (`pages/prismic-dom-technical-reference.md § RichText.asHtml()`).
- `image` block: `url`, `alt`, `linkTo?` (link field with `url`) (`prismicio-richtext/v2.md § Example`), plus
  dimensions/copyright (AC).
- `embed` block: `oembed.html` (same).
- `start`/`end` are character offsets into `text` (JS string indices; Q12 on astral chars).
- Table field: `table`, `thead`, `tbody`, `tr`, `th`, `td`; cell content limited to `paragraph`, `em`,
  `strong`, `hyperlink` (`prismicio-react/v3.md § <PrismicTable>`); live shape `head.rows[].cells[]` (`ev/README.md`).

## 10. Route resolution and URLs

- Route resolvers are sent with every query; the API fills `url` (`pages/routes.md` intro). Keywords `:uid`,
  `:lang`, `:lang?` ("when the page is not in the master locale"); `resolvers` map custom keywords to content
  relationship fields, "Up to two levels of nesting", optional segments with `?`; `uid`-scoped and
  `lang`-scoped routes (`pages/routes.md § Path keywords`, `§ Special cases`).
- `brokenRoute` for links to unpublished/deleted docs (`§ Broken routes`).
- Link resolver is client-only and takes priority when it returns a value (`pages/routes.md § Link resolver`).
- Framework assumptions: `url` is root-relative (`/blog/x`) so `next/link`, `NuxtLink`, SvelteKit prefixing
  and `rel` logic treat it as internal; `null` when no route matches.
- Guides map routes to file-system routes (`pages/nextjs.md § Define routes`, `/:grandparent/:parent/:uid` ->
  catch-all).

---

## 11. Requirements

| ID | Pri | Requirement | Evidence |
|---|---|---|---|
| REQ-SDK-001 | P0 | Serve Content API v2 at a configurable base (`https://<host>/api/v2`) so `createClient("<repo>", { documentAPIEndpoint })` works; search at `<base>/documents/search`, tags at the URL in `forms.tags.action`. | §1.1, §2.4 |
| REQ-SDK-002 | P0 | Every repository has a name matching Prismic's repo-name rules; the same name is used in `repository` headers, preview cookie keys and environment switching. | §1.1, §4.2 |
| REQ-SDK-003 | P0 | `GET /api/v2` returns `refs` (master `id:"master"`, `label:"Master"`, `isMasterRef`), `languages` (master first), `types`, `integrationFieldsRef`, `forms` (incl. `everything`, `tags` with absolute `action` on our host), `tags`, `license`, `version`, `oauth_initiate`, `oauth_token`. | §2.4 |
| REQ-SDK-004 | P0 | Accept all documented search params (`ref, q, lang, page, pageSize, after, fetch, fetchLinks, graphQuery, orderings, routes, brokenRoute, access_token, integrationFieldsRef, referer`) and ignore unknown params (cache-busting params like AC's `x-c`). | §2.2 |
| REQ-SDK-005 | P0 | `pageSize` 1-100, default 100, clamp above; envelope fields `page, results_per_page, results_size, total_results_size, total_pages, next_page, prev_page, results`; `next_page` absolute and non-null iff more pages. | §2.3 |
| REQ-SDK-006 | P0 | Implement the full filter set with documented path restrictions and semantics (strict vs inclusive number bounds, `missing` restricts type, `geopointNear` ordering, date formats incl. 13-digit epoch, day/month names). | §2.6 |
| REQ-SDK-007 | P1 | `in(document.id, [...])` / `in(my.t.uid, [...])` return documents in the order given (v6 docs promise order for `getByIDs`/`getByUIDs`). | §2.3 |
| REQ-SDK-008 | P0 | `lang=*` returns all locales; each doc has `lang` and `alternate_languages`. | §3.1 |
| REQ-SDK-009 | P0 | Resolve `routes` (all keywords, `resolvers` 2 levels, `uid`/`lang` scoping) into document `url` and Document-link `url`; apply `brokenRoute`; `url: null` when unmatched. | §10 |
| REQ-SDK-010 | P0 | Access tokens via `access_token` query param; private repos return 401 `{"error":"Invalid access token"}` without one; switching visibility is immediate. | §1.2 |
| REQ-SDK-011 | P0 | CORS `Access-Control-Allow-Origin: *` on Content API, `/api/v2`, tags and GraphQL (Nuxt/React/Vue fetch from browsers). | §1.2, §3.2 |
| REQ-SDK-012 | P0 | Releases: refs for releases with `id`, `label`, `scheduledAt?`; querying with a release ref returns release content. | §2.3 |
| REQ-SDK-013 | P0 | Error bodies/status codes as AC §1.7 (ref-not-found 404 with "Master ref is: <ref>", parse errors 400, preview token expired). | §2.9 |
| REQ-SDK-014 | P0 | Preview refs: back office mints a preview ref per session; Content API accepts it as `ref` and returns drafts; also accepts the raw `io.prismic.preview` cookie value (plain or JSON keyed by repo host, URL-encoded or not). | §5 |
| REQ-SDK-015 | P0 | Preview launch redirects to `<previewURL>?token=<ref>&documentId=<id>`; repository stores multiple named preview URLs with arbitrary paths (`/api/preview`, `/preview`). | §5, §3.3 |
| REQ-SDK-016 | P0 | `getByID(id, { ref: previewToken, lang: "*" })` finds a never-published draft and returns its resolved `url` (so `resolvePreviewURL` works). | §2.5 |
| REQ-SDK-017 | P0 | Route-resolved URLs are root-relative paths (SvelteKit `/preview` prefixing, internal-link detection). | §3.4, §10 |
| REQ-SDK-018 | P0 | Host `https://<repoHost>/prismic-toolbar/5e015029/iframe.html` implementing the connect/ready handshake and RPC (`getState`, `ping`, `closeSession`, `share`), returning the session ref and auth state. | §6 |
| REQ-SDK-019 | P1 | Serve our own copies of the loader (`prismic.js`) and UI bundles so a site can avoid Prismic's CDN (Nuxt `toolbar:false` + manual script, or patched loader); loader must accept `repo=<our host>`. | §6, Q1 |
| REQ-SDK-020 | P1 | Toolbar session semantics: ref changes on draft save, polled every 3 s; `io.prismic.preview.updated` cookie protocol; events `prismicPreviewStart/Update/End` with `detail.ref`. | §5, §6 |
| REQ-SDK-021 | P1 | Shareable preview links that expire and work without a repository account. | §5 |
| REQ-SDK-022 | P1 | Repository setting for one slice simulator URL; editor loads it in an iframe and speaks the `@prismicio/simulator` postMessage + `state` URL protocol with Content-API-shaped slices. | §7 |
| REQ-SDK-023 | P0 | Image URLs absolute, served by an imgix-compatible service honouring `auto=format,compress`, `rect`, `w`/`h`, `width`/`height`, `dpr`, `fit`, `q`, `fm`, `sat`, `blur`, with params preserved/overridable via query string. | §8 |
| REQ-SDK-024 | P0 | Image field: `url`, `dimensions`, `alt`, `copyright`, `id`, `edit`, responsive views as extra keys each with its own `url`/`dimensions`; empty image `{}`. | §8 |
| REQ-SDK-025 | P0 | Rich text emitted as flat blocks with `spans` (`start`,`end`,`type`,`data`), only the documented types; `image` blocks with `url, alt, dimensions, linkTo?`; `embed` blocks with `oembed.html`; optional `direction`. | §9 |
| REQ-SDK-026 | P0 | Link fields carry `link_type` (`Document`,`Web`,`Media`,`Any`), `url`, `target` (when open-in-new-tab), Document links `id, uid, type, tags, lang, slug, isBroken, url`. | §2.8 |
| REQ-SDK-027 | P0 | Date `YYYY-MM-DD`, timestamp `YYYY-MM-DDTHH:mm:ss+0000`, publication dates same format. | §2.8 |
| REQ-SDK-028 | P0 | Slices: `id` `<type>$<uuid>`, `slice_type`, `slice_label`, `variation`, `version`, `primary`, `items`. | §7 |
| REQ-SDK-029 | P0 | `429` always carries a numeric `Retry-After`. | AC §0.7 |
| REQ-SDK-030 | P1 | Asset API and Migration API at configurable hosts (write client `assetAPIEndpoint`, `migrationAPIEndpoint`), auth `Bearer` + `repository`; support the create-then-update two-pass, `publishMigrationRelease` -> `{totalItems}` asynchronously. | §2.7 |
| REQ-SDK-031 | P1 | Migration API accepts rich text produced by `@prismicio/migrate` (labels, `direction`) and validates against `config.multi`. | §4.4 |
| REQ-SDK-032 | P1 | Custom Types API (`/customtypes`, `/customtypes/{id}`, `/slices`, `/slices/{id}`, insert/update) at a configurable host with `repository` + Bearer auth, returning model JSON that `prismic-ts-codegen` accepts. | §4.1 |
| REQ-SDK-033 | P1 | GraphQL endpoint at `<host>/graphql` accepting `Prismic-Ref` / `prismic-ref`, `Authorization: Token`, `prismic-integration-field-ref`, `ref` query param. | §2.4, AC §1.12 |
| REQ-SDK-034 | P1 | Webhooks with `documentsPublished` / `documentsUnpublished` triggers so `force-cache` Next sites and static Nuxt/SvelteKit sites refresh. | §3.1, §3.3 |
| REQ-SDK-035 | P1 | Environments addressable as separate repository names with their own Content API endpoint. | §4.2 |
| REQ-SDK-036 | P2 | Slice Machine compatibility: `apiEndpoint` override honoured; auth/user/customtypes hosts reachable or overridable. | §4.2, Q8 |
| REQ-SDK-037 | P2 | Legacy clients: v5 (`Prismic.client(fullURL)`, `forms.everything` usage, `query()`), `prismic-dom`, Vue v2-v5 / Nuxt v4 full-endpoint config. | §1.1, §3.5 |
| REQ-SDK-038 | P2 | Optional `<repo>.wroom.test` style local hostnames for testing unmodified `createClient(url)` flows. | §1.1 |
| REQ-SDK-039 | P1 | Integration fields: `integrationFieldsRef` in `/api/v2`, accepted as query param. | §2.1 |
| REQ-SDK-040 | P1 | Responses identical for identical URLs (stable ordering) so client-side GET de-duplication and Next fetch caching are safe. | AC §1.2 |

---

## 12. Compat test matrix (automated, against our server, unmodified SDKs)

Base setup: `const client = createClient("test-repo", { documentAPIEndpoint: BASE + "/api/v2", routes, fetch })`
seeded with fixture content (multiple types, locales, a release, a draft, a private-repo variant).

Content API (`@prismicio/client` latest 7.x):

1. `getRepository()`: shape per REQ-SDK-003; `getMasterRef()`, `getRefs()`, `getReleases()`,
   `getReleaseByLabel("Spring")`, `getReleaseByID(id)`, `getRefByLabel("nope")` throws `PrismicError`.
2. `getTags()` returns the tag list via `forms.tags.action`.
3. `get()`, `get({ page: 2, pageSize: 10 })`, `get({ pageSize: 101 })` (clamped), envelope fields.
4. `getFirst()`, `getByID(id)`, `getByID("missing")` -> `NotFoundError`.
5. `getByIDs([b, a])` order preserved; `getAllByIDs` over > 100 ids.
6. `getByUID("page","home")`, `getByUIDs`, `getAllByUIDs`, `getSingle("settings")`, `getSingle("none")` -> `NotFoundError`.
7. `getByType`, `getAllByType("blog_post")` with > 250 docs (multi-page, terminates).
8. `getByTag`, `getAllByTag`, `getByEveryTag`, `getBySomeTags`, `getAll*` variants, `dangerouslyGetAll()`.
9. `get({ lang: "fr-fr" })`, `getAllByType("page", { lang: "*" })` returns every locale.
10. `get({ orderings: [{ field: "my.product.price", direction: "desc" }, { field: "document.first_publication_date" }] })`.
11. `get({ after: id, orderings })`.
12. One test per filter function in `filter.*` incl. edge semantics (strict/inclusive bounds, `missing` type
    restriction, day/month names in caps, epoch dates, `similar`, `geopointNear` order, `fulltext` on
    `document`).
13. `get({ fetchLinks: ["author.name"] })` and `get({ graphQuery })` populate linked data.
14. Routes: `getByUID` with `{type,path:"/blog/:uid"}`, `:lang?`, `resolvers` 2 levels, `uid`-scoped,
    `lang`-scoped; `brokenRoute: "/404"` on a link to a deleted doc; `asLink(doc)` equals `doc.url`.
15. `queryContentFromReleaseByLabel("Spring")` then `getByUID` returns release content; `queryLatestContent()` reverts.
16. `queryContentFromRef(previewRef)` returns draft; same with the raw JSON cookie string
    `{"_tracker":"x","test-repo.<host>":{"preview":"<ref>"}}` (plain and URL-encoded forms).
17. `resolvePreviewURL({ previewToken, documentID, defaultURL: "/" })` returns the route URL for a
    never-published draft; unknown doc -> `"/"`; expired token -> `PreviewTokenExpiredError`.
18. Private repo: no token -> error; `accessToken` in config and per query -> OK.
19. Bad ref -> client retries with master ref from the error message; bad filter -> parsing error surfaced.
20. 429 with `Retry-After: 1` -> client retries and succeeds.
21. `buildQueryURL(params)` URL fetched directly returns the same as `get(params)`.
22. `graphQLFetch` used by a GraphQL client against `BASE/graphql`.
23. Helpers on returned content: `asHTML`, `asText`, `asDate`, `asLink`, `asLinkAttrs` (internal vs external
    `rel`, `target`), `asImageSrc` (`auto` kept, `sat` added, `auto: undefined` removed), `asImageWidthSrcSet`
    (default and `"thumbnails"`), `asImagePixelDensitySrcSet`; fetch each generated URL from our image
    service and check HTTP 200 and output dimensions for `width`, `w`, `dpr`, `rect`.
24. `isFilled.*` true/false for every field type with filled and empty fixtures.
25. `mapSliceZone` over a fetched slice zone (shape smoke test).

Write client:

26. `createWriteClient("test-repo", { writeToken, assetAPIEndpoint, migrationAPIEndpoint, documentAPIEndpoint })`,
    `createMigration()`, `createAsset(url, "a.png", { alt, tags })`, `createDocument(doc, "Title")` with a
    content relationship to another migration doc and an image, `createDocumentFromPrismic`,
    `updateDocument`, `migrate(m, { reporter })` emits all events; `publishMigrationRelease()` ->
    `{ totalItems }` and docs appear on master ref later. Repeat with `htmlAsRichText` output.

Frameworks (headless browser, Playwright):

27. Next.js App Router starter (`prismicio.ts` with `documentAPIEndpoint`): build (`generateStaticParams`
    with `lang: "*"`), render a page with `SliceZone`, `PrismicNextImage` (srcset URLs load), `PrismicNextLink`.
28. Next preview: open `/api/preview?token=<ref>&documentId=<id>` -> 307 to doc URL, Draft Mode on, draft
    content rendered when the `io.prismic.preview` cookie is set; `/api/exit-preview` ends it.
29. Next Pages Router (`@prismicio/next/pages`): `setPreviewData` + `redirectToPreviewURL` + `enableAutoPreviews({ previewData })`.
30. Nuxt 3/4 + `@nuxtjs/prismic` v5 with `clientConfig.documentAPIEndpoint` (and with a custom
    `~/prismic/client`): SSR page, `/preview?token&documentId` redirect, browser-side refetch works (CORS,
    public token).
31. SvelteKit + `@prismicio/svelte` v3: `load` with `createClient({ fetch, cookies })`, `/api/preview`
    redirect to `/preview/<path>`, prerender build.
32. Toolbar: page with `<PrismicPreview repositoryName="<our host>">` loads our iframe, RPC handshake
    succeeds, saving a draft in our editor triggers `prismicPreviewUpdate` within 3-6 s, exit triggers
    `prismicPreviewEnd`.
33. Slice simulator: our editor iframes `/slice-simulator` of the Next, Nuxt and SvelteKit starters, sends
    slices, the iframe renders them (React `getSlices(state)`, Vue `v-slot`, Svelte snippet).
34. React v3 client-side app (Vite) using TanStack Query + `client.getByUID` from the browser (CORS).

Tooling:

35. `prismic-ts-codegen` with `fetchFromRepository: true` against our Custom Types API (if a host override
    exists; otherwise via local files exported from our server) and `tsc --noEmit` on the generated types
    plus a typed `client.getByUID`.
36. `slice-machine-ui` with `apiEndpoint` set (P2): starts, lists models, simulator loads.

---

## 13. Open questions and ambiguities

- **Q1 Toolbar CDN dependency.** All framework components inject
  `https://static.cdn.prismic.io/prismic.js?...` and the loader pulls `toolbar.js` from `prismic.io`. No prop
  overrides the script URL in the docs (`prismicio-next/v2.md § <PrismicPreview>` lists only
  `repositoryName`, `updatePreviewURL`, `exitPreviewURL`). Fully self-hosted previews with unmodified SDKs
  depend on Prismic's CDN staying up and the loader keeping custom-host support. Need a decision: accept the
  dependency, document a manual `<script>` alternative, or ship a patched loader.
- **Q2** Does `getToolbarSrc` / `<PrismicPreview>` validate `repositoryName` (would a host with dots be
  rejected or URL-encoded)? Check SDK source.
- **Q3** Nuxt v5 `toolbar: true`: which value becomes `repo=`? If it is the repo name, the toolbar always
  targets `<repo>.prismic.io` and our clone needs `toolbar: false` plus a manual script.
- **Q4** Nuxt v5 `endpoint`: docs say "A Prismic repository name" (v4 said "or full endpoint"). Is a URL still
  accepted, or must users use `clientConfig.documentAPIEndpoint`?
- **Q5** Cookie name: `pages/previews.md` says "a `preview.prismic.io` cookie"; evidence and AC say
  `io.prismic.preview`. Treat the docs line as a simplification unless the source disagrees.
- **Q6** Which key does `@prismicio/client` use when the cookie is JSON? AC says the value is sent raw as
  `ref`, so the server extracts the entry; what key should the server look for when the toolbar was told
  `repo=cms.example.com` (host string as-is) versus `repo=test-repo` (`test-repo.prismic.io`)? Probably accept
  any entry whose host maps to this repository.
- **Q7** Does `prismic-ts-codegen` have a Custom Types API endpoint override (config or env var)? Docs show
  none; AC notes `@prismicio/custom-types-client` takes an endpoint option (`cti/src/client.ts:154`).
- **Q8** Slice Machine / Prismic CLI hosts (`auth.prismic.io`, `user-service.prismic.io`,
  `customtypes.prismic.io`, screenshot/S3 uploads): any env-var overrides? Not in docs.
- **Q9** The `@prismicio/simulator` message protocol and the `state` param compression are undocumented.
  Needs source reading before building the editor side.
- **Q10** Default `srcset` widths differ between docs (8 widths) and source (5 widths); and the exact
  `<PrismicNextImage>` loader params (`w` vs `width`, `fit`, `q`). Image service must accept both `w` and
  `width`; confirm imgix's own treatment of `width` (docs examples rely on it).
- **Q11** Did pre-v6 predicate names (`gt`, `near`, `dayOfMonth`) produce different wire strings that old
  clients still send? Matters only for REQ-SDK-037.
- **Q12** Span offsets: UTF-16 code units (JavaScript) or code points? Affects emoji/astral text. Verify on
  live data.
- **Q13** Is the 500 ms `getAll*` throttle (v6 docs) still in v7? Affects only expected request rate.
- **Q14** `enableAutoPreviews` / `enableAutoPreviewsFromReq` disappeared from the v7 reference page while
  frameworks still use auto previews; confirm the v7 mechanism (cookie jar access in Next App Router via
  `cookies()`/`draftMode()`).
- **Q15** Does the toolbar `getState` payload or the Page Builder iframe (embedded preview modes
  `prismic:embedded-preview[:poll]`) require additional server endpoints (e.g. document list for "pages in
  the current preview")? The toolbar UI lists previewed pages and links to the Page Builder
  (`pages/previews.md § Prismic toolbar`), so the iframe API must expose them.
- **Q16** `next_page`/`prev_page` absolute URLs: should they keep the caller's `access_token`? Live behaviour to
  check (risk of leaking tokens into logs vs. compatibility).
