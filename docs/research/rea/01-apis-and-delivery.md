# REA 01: APIs, delivery and developer platform

Scope: every HTTP API Prismic documents (Content/Repository/Tags/GraphQL read APIs, Types/Migration/Asset/Integration-Fields write APIs), route resolution, previews, webhooks, environments, CLI, MCP server and AI tooling. Field shapes, editor UI and SDK internals are covered by other REA files.

Conventions:

- `pages/<file>.md § <heading>` cites the docs mirror at `docs/research/prismic-docs-mirror/pages/`.
- `ev/<file>` cites live captures in `docs/research/evidence/` (prismic.io production, 2026-10-19).
- `contracts §0.n` cites the SDK-derived executive summary in `docs/research/api-contracts.md`.
- **[DISCREPANCY]** marks docs vs docs or docs vs evidence conflicts. **[INFERENCE]** marks conclusions not literally stated anywhere.
- Priorities: **P0** wire-compatibility blocker for `@prismicio/client` and framework kits; **P1** needed for feature parity; **P2** nice to have / legacy.

---

## 0. Service topology

| Service | Host (Prismic) | Auth | Source |
|---|---|---|---|
| Repository API | `https://<repo>.cdn.prismic.io/api/v2` (also uncached `https://<repo>.prismic.io/api/v2`) | none / `access_token` | `pages/repository-api-technical-reference.md`, `ev/protected-endpoints.txt` |
| Content API | `https://<repo>.cdn.prismic.io/api/v2/documents/search` | none / `access_token` | `pages/content-api.md § Overview` |
| Tags API | `https://<repo>.cdn.prismic.io/api/tags` | none / `access_token` | `pages/tags-api-technical-reference.md` |
| GraphQL API | `https://<repo>.cdn.prismic.io/graphql` (explorer `https://<repo>.prismic.io/graphql`) | `Prismic-Ref` header + optional `Authorization` | `pages/graphql-technical-reference.md` |
| API Explorer (UI) | `https://<repo>.prismic.io/builder/explorer`, `https://prismic.io/explorer` | session | `pages/content-api.md § q`, `pages/fetch-content.md § API Explorer` |
| Types API | `https://customtypes.prismic.io` | `repository` header + Bearer write token | `pages/custom-types-api.md` |
| Migration API | `https://migration.prismic.io` | `repository` + Bearer write token | `pages/migration-api-technical-reference.md` |
| Asset API | `https://asset-api.prismic.io` | `repository` + Bearer write token | `pages/asset-api-technical-reference.md` |
| Integration Fields write API | `https://if-api.prismic.io/if/write/<repo>--<catalog>` | Bearer catalog token | `pages/fields/integration.md § Push data to Prismic` |
| Image CDN | `https://images.prismic.io/<repo>/...` (imgix) | none | `ev/image-cdn-probe.txt` |
| Preview toolbar script | `https://static.cdn.prismic.io/prismic.js?new=true&repo=<repo>` | none | `ev/toolbar.prismic.js`, `contracts §0.3` |
| Preview toolbar iframe | `https://<repo>.prismic.io/prismic-toolbar/<build>/iframe.html` | Prismic session cookie | `ev/toolbar.prismic.js` |
| MCP server | `https://mcp.prismic.io/mcp` | OAuth (Auth0 `prismic-auth.eu.auth0.com`) or Bearer write token | `pages/mcp.md` |
| Auth / user services | `https://auth.prismic.io/login`, `https://user-service.prismic.io/profile` | (undocumented) | `ev/protected-endpoints.txt` |
| OAuth (repo, legacy) | `https://<repo>.prismic.io/auth`, `/auth/token` | n/a | `ev/api-root.prismic-main.json` |

All write services are AWS API Gateway behind CloudFront; without a token they answer `403` with `x-amzn-errortype: AccessDeniedException` or `MissingAuthenticationTokenException` (`ev/protected-endpoints.txt`).

### Requirements

- **REQ-API-001 (P0)** Serve the read APIs per repository under a configurable base URL that mirrors the path layout `/api/v2`, `/api/v2/documents/search`, `/api/tags`, `/graphql`. Repository routing by subdomain (`<repo>.<host>`) AND by path or header must both be supported, because `@prismicio/client` derives the repository name only from Prismic hostnames and otherwise needs `createClient("<repo>", { documentAPIEndpoint })` (`contracts §0.1`).
- **REQ-API-002 (P0)** All absolute URLs emitted by the server (`forms.*.action`, `next_page`, `prev_page`, `href`, `oauth_*`, webhook `apiUrl`) must use the clone's own public host, never prismic.io (`contracts §0.4`).
- **REQ-API-003 (P0)** All read responses are `application/json` with `access-control-allow-origin: *` (`ev/api-root.headers.txt`).
- **REQ-WAPI-001 (P0)** Write APIs (types, migration, asset) accept `repository: <repo>` and `Authorization: Bearer <write token>` headers and can be hosted on one host with path prefixes, provided the paths below are preserved (clients allow overriding `customTypesAPIEndpoint`, `assetAPIEndpoint`, `migrationAPIEndpoint`; `pages/technical-reference/prismicio-client/v7.md § createWriteClient`).

---

## 1. Authentication and content visibility

### What
Two token families: **access tokens** (read; Content/Repository/Tags/GraphQL) and **write tokens** a.k.a. permanent/bearer tokens (Types, Asset, Migration APIs; also authenticate the CLI and MCP).

### Contract
- Write: headers `repository: repo-name` and `Authorization: Bearer <token>`; "this is not HTTP Basic Authentication"; HTTPS only; "Calls made over plain HTTP or without authentication will fail" (`pages/api-authentication.md § Write tokens`).
- Read: `access_token=<token>` query param on the Content API (`pages/content-api.md § access_token`); access tokens are secrets, not for client-side use (`pages/api-authentication.md § Access tokens`).
- Token creation: `npx prismic token create` (access), `npx prismic token create --write` (write), `npx prismic token create --allow-releases` ("Read token with access to releases", `pages/with-lokalise.md` step 2). Also UI: Settings → API & Security (→ Write APIs). Multiple tokens per app are allowed.
- Visibility levels (`pages/fetch-content.md § Content visibility`):

| Level | Published | Release content | Archived |
|---|---|---|---|
| Open API | Public | Public | No access |
| Public API for Master only (default) | Public | Requires access token | No access |
| Private API | Requires access token | Requires access token | No access |

  Set by `npx prismic repo set-api-access private`. The repository `license` string changes with visibility (`pages/repository-api-technical-reference.md`, `license`).
- Release refs appear in `/api/v2` `refs` only with a "master+releases access token" or Open API (`pages/repository-api-technical-reference.md`, `refs`).
- Private repo without/with bad token: `401 {"error":"Invalid access token"}` (`ev/api-root.wroom-401.json`).

### Requirements
- **REQ-API-004 (P0)** Implement three visibility modes exactly as tabulated; archived content is never served by read APIs.
- **REQ-API-005 (P0)** Access tokens have a scope: `master` only, or `master+releases` (CLI `--allow-releases`). Release refs are listed in `/api/v2` and accepted as `ref` only when the visibility mode or token scope allows it.
- **REQ-API-006 (P0)** Accept the access token as `access_token` query param on `/api/v2`, `/documents/search`, `/api/tags`; accept it as `Authorization` header on `/graphql` (see §5). Invalid/missing token on a protected repo: HTTP 401 body `{"error":"Invalid access token"}`.
- **REQ-WAPI-002 (P0)** Write tokens are repository-scoped administrator credentials, revocable, multiple per repo, managed via UI and `prismic token create --write`. Requests without them: 401/403 JSON.
- **REQ-WAPI-003 (P1)** A write token must NOT authorize repository-settings changes from the CLI (`webhook create`, `preview remove`, ...): "not allowed with a write token. Use a user login" (`pages/cli.md § Authenticate in scripts and CI workflows`). Model a separate user-session auth for settings endpoints.

---

## 2. Repository API

### What
`GET /api/v2` returns repository metadata, most importantly refs. "Every time you publish changes, a new master ref is generated." Old refs are kept for a while then purged (`pages/repository-api-technical-reference.md`).

### Contract
- `GET https://<repo>.cdn.prismic.io/api/v2[?access_token=...]`
- Response (docs example, `pages/repository-api-technical-reference.md`):

```json
{
  "refs": [
    { "id": "master", "ref": "ZG5h3BAAAB8AhmzJ", "label": "Master", "isMasterRef": true },
    { "id": "ZIBvwhAAACMAgx9w", "ref": "ZIBvwxAAACEAgx93~ZIBJVRAAACMAgmBd", "label": "", "scheduledAt": 1696633200000 }
  ],
  "bookmarks": {},
  "experiments": { "draft": [], "running": [] },
  "types": { "home": "Home", "pages": "Pages" },
  "languages": [
    { "id": "en-us", "name": "English - United States" },
    { "id": "en-gb", "name": "English - United Kingdom" }
  ],
  "forms": "// Omitted ",
  "oauth_initiate": "https://your-repo-name.prismic.io/auth",
  "oauth_token": "https://your-repo-name.prismic.io/auth/token",
  "tags": [],
  "license": "All Rights Reserved",
  "version": "482083b"
}
```

- Live `forms` (`ev/api-root.prismic-main.json`), which is the authoritative list of search params:

```json
"forms": {
  "everything": {
    "method": "GET", "enctype": "application/x-www-form-urlencoded",
    "action": "https://prismic-main.cdn.prismic.io/api/v2/documents/search",
    "fields": {
      "ref": {"type":"String","multiple":false},
      "q": {"type":"String","multiple":true},
      "lang": {"type":"String","multiple":false},
      "page": {"type":"Integer","multiple":false,"default":"1"},
      "pageSize": {"type":"Integer","multiple":false,"default":"20"},
      "after": {"type":"String","multiple":false},
      "fetch": {"type":"String","multiple":false},
      "fetchLinks": {"type":"String","multiple":false},
      "graphQuery": {"multiple":false,"type":"String"},
      "orderings": {"type":"String","multiple":false},
      "referer": {"type":"String","multiple":false},
      "routes": {"type":"String","multiple":false},
      "access_token": {"type":"String","multiple":false},
      "integrationFieldsRef": {"type":"String","multiple":false}
    }
  },
  "tags": {
    "method": "GET", "enctype": "application/x-www-form-urlencoded",
    "action": "https://prismic-main.cdn.prismic.io/api/tags",
    "fields": { "access_token": {"type":"String","multiple":false} }
  }
}
```

- Live languages carry `is_master` (`{"id":"en-eu","name":"English - European Union","is_master":true}`), absent from the docs table (`ev/api-root.prismic-main.json`).
- Property semantics (`pages/repository-api-technical-reference.md` table):
  - `refs[0]` "is always the master ref"; master `id` is `"master"`, `label` always `"Master"`, `isMasterRef: true` present only on master.
  - Release ref: `id` is the release id; `ref` is two ids joined by `~` (first changes when the release content changes, second when anything in the repo is published); `label` defaults to `""` for scheduled releases (custom label settable); `scheduledAt` present only on scheduled releases, Unix ms.
  - `types`: type API id → display label. `languages[0]` "is always the master locale".
  - `bookmarks`, `experiments`, `tags` deprecated (always `{}`, `{draft:[],running:[]}`, `[]`).
  - `forms`: "internally-used API features". `version`: build hash for debugging.
  - `integrationFieldsRef: string|null` exists per the client typings (`pages/technical-reference/prismicio-client/v7.md § getRepository()`), and is the source of the `integrationFieldsRef` search param (`pages/content-api.md § integrationFieldsRef`). Not present in the prismic-main capture (no integration catalogs) [INFERENCE: omitted or null when unused].
- Headers observed: `cache-control: max-age=0, no-store`, `x-prismic-version: 6`, `access-control-allow-origin: *`, CloudFront `x-cache` (`ev/api-root.headers.txt`). Uncached host adds `x-ratelimit-limit: 200`, `x-ratelimit-remaining`, `x-ratelimit-reset` (epoch seconds) (`ev/protected-endpoints.txt`).

**[DISCREPANCY]** Docs say `scheduledAt` is a "string" containing a Unix timestamp; example (and webhook payloads) show a number in ms. Implement number.
**[DISCREPANCY]** Docs say a release ref id "is made up of two hashes separated by a hash symbol"; the example and webhooks use `~`. Implement `~`.
**[DISCREPANCY]** Docs table spells `oauth_initate`; JSON key is `oauth_initiate`.

### Requirements
- **REQ-API-007 (P0)** `GET /api/v2` returns exactly the keys above (`refs, bookmarks, experiments, types, languages, forms, oauth_initiate, oauth_token, tags, license, version`, plus `integrationFieldsRef` when integration catalogs exist), never cached (`cache-control: max-age=0, no-store`).
- **REQ-API-008 (P0)** `refs[0]` is the master ref; ref values are opaque 16-char URL-safe ids (`[A-Za-z0-9_-]{16}` observed, e.g. `atX5SBEAACkAzXoH`); a new master ref is minted on every publish; old refs stay queryable for a retention window then return "ref expired" (see §4.10).
- **REQ-API-009 (P0)** One ref per active release `{id, ref:"<releaseVersion>~<masterRef>", label, scheduledAt?}`, filtered by visibility/token scope (REQ-API-005).
- **REQ-API-010 (P0)** `languages` lists master locale first and includes `is_master` booleans (the write client takes `languages[0].id` as master, `contracts §0.10`).
- **REQ-API-011 (P0)** `forms.everything` advertises the 14 fields above with the clone's own `action` URL; `forms.tags.action` points at the clone's tags endpoint (the client follows it, `contracts §0.4`).
- **REQ-API-012 (P1)** `license` reflects visibility ("All Rights Reserved" observed for default/public; exact strings for other modes unknown).
- **REQ-API-013 (P2)** Response header `x-prismic-version: 6`.

---

## 3. Tags API

### What
Beta endpoint returning all tags in the repository (`pages/tags-api-technical-reference.md`).

### Contract
- `GET https://<repo>.cdn.prismic.io/api/tags[?access_token=]` → `["blue", "yellow", "red"]` (flat string array). Live: sorted array of 89 strings, uppercase before lowercase (byte order) (`ev/tags.json`).
- Contents: tags on published pages and pages in releases; another sentence adds drafts.
- "If the repository is brand new and without any tags, we return a 404. Otherwise, it will be an empty array `[]`."

**[DISCREPANCY]** Page says tags come from "published pages and pages in releases" and then "drafts and pages in releases will also apear". Treat as: union of tags over all non-archived document versions.

### Requirements
- **REQ-API-014 (P0)** `GET /api/tags` returns a JSON array of unique tag strings in byte-wise ascending order, honoring `access_token` like the Content API.
- **REQ-API-015 (P2)** Reproduce the 404 for a never-tagged brand-new repo only if a compatibility test demands it; otherwise return `[]` (clients treat 404 as error).

---

## 4. Content API (`/api/v2/documents/search`)

### 4.1 What
Main read endpoint; every query needs a ref. "Query URLs ... will expire as the ref goes out of date" (`pages/content-api.md § Overview`). SDKs first fetch `/api/v2` for the master ref (`pages/content-api.md § ref (required)`).

### 4.2 Contract: request
`GET https://<repo>.cdn.prismic.io/api/v2/documents/search?<params>` — all options are URL search params whose values are `encodeURIComponent`-encoded (`pages/content-api.md § Encoding`).

| Param | Type | Default | Limits / semantics | Source |
|---|---|---|---|---|
| `ref` | string | required | master, release or preview ref | `§ ref (required)` |
| `access_token` | string | — | required for private repos / release refs | `§ access_token` |
| `q` | string, **multiple** | — | filter set `[[f1][f2]...]`; multiple `q` params ANDed | `§ q`, `ev/api-root` forms |
| `lang` | string | master locale | locale code or `*` for all | `§ lang` |
| `page` | integer | 1 | 1-based | `§ page` |
| `pageSize` | integer | 20 | max 100; values >100 clamped to 100 (`ev/search.pagesize-101.json` → `results_per_page:100`) | `§ pageSize` |
| `after` | string (document id) | — | cursor; results after that doc in current ordering | `§ after` |
| `orderings` | string | — | `[path( desc)?,...]` | `§ orderings` |
| `fetch` | string | — | deprecated selective fetch | `§ fetch` |
| `fetchLinks` | string | — | linked-doc field selection | `§ fetchLinks` |
| `graphQuery` | string | — | selective + deep fetch | `§ graphQuery` |
| `routes` | string (JSON) | — | route resolvers → `url` | `§ routes` |
| `brokenRoute` | string | — | `url` for broken links | `§ brokenRoute` |
| `integrationFieldsRef` | string | — | integration data version, e.g. `example-repo~7207b47e-3472-4350-bb0c-5a771c0ea671` | `§ integrationFieldsRef` |
| `referer` | string | — | advertised in forms, undocumented | `ev/api-root.prismic-main.json` |

Note `brokenRoute` is documented but absent from `forms.everything` (`ev/api-root.prismic-main.json`) **[DISCREPANCY]**; accept it anyway.

Limits (`pages/content-api.md § Limits`, `pages/fetch-content.md § Rate limits`):
- Max URL length 2048 characters.
- 200 non-cached requests/second/repository; "Cached queries have no rate limit"; the client retries rate-limited requests after one second.
- Monthly plan quotas: Free/Starter/Small 4M calls + 100 GB; Medium 5M + 500 GB; Platinum 10M (overage to 20M) + 1 TB; Enterprise custom (`pages/fetch-content.md § API limits`). Usage dashboard under Settings → Usage Dashboard.

### 4.3 Filter (predicate) language — `q`

Grammar as documented (`pages/content-api.md § q`):
```
q        := "[" filter+ "]"
filter   := "[" name "(" arg ("," arg)* ")" "]"
arg      := path | string | number | array
path     := "document" | "document." meta | "my." type "." field ("." field)?
meta     := "type" | "id" | "tags" | "first_publication_date" | "last_publication_date"
string   := '"' chars '"'            (one docs example uses '...'; see below)
array    := "[" (string|number) ("," (string|number))* "]"
```
Whitespace around args is allowed (`[at( path, value )]`). All filters are ANDed, also across multiple `q` params and other params (`§ q`).

Observed extensions to support:
- Document `href` values use a **binding form** `[[:d = at(document.id, "ZYCIiBEAAM8Dec8o") ]]` (`ev/search.homepage.json` `href`). The parser must accept `:<var> = <filter>`.
- Docs examples also show **single-bracket** `q=[geopoint.near(...)]` and two filters separated by a newline without the outer brackets (`§ geopointNear`, `§ Date filters` URL examples) and a single-quoted string `'May'` (`§ Date filters`). [INFERENCE] accept both forms; treat `'...'` as string.
- Parse error (HTTP 400, `ev/search.bad-predicate.json`):
```json
{"type":"api_parsing_error","message":"unrecognized attribute 'foo' on line:1 col:3 in query '[[foo(document.type,\"blog\")]]'\n[[foo(document.type,\"blog\")]]\n  ^\n","pos":{"line":1,"column":3,"id":0,"location":"query"}}
```

Paths (`§ q` table): `my.[custom-type].[field]`, `my.[custom-type].[group-field].[field]`, `document.type`, `document.id` (e.g. `WGvVEDIAAAcuB3lJ`), `document.tags` ("must always be listed in an array"), `document.first_publication_date` (never changes), `document.last_publication_date` (updated on every publish), `document` (fulltext only: all rich text, title, key text, select and UID fields).

Field-type ↔ filter compatibility pivot (`pages/content-api.md § q`, `FiltersTable`):

| Field / path | Compatible filters |
|---|---|
| `document` | fulltext |
| `document.tags` | at, not, any |
| `document.id` | at, not, any, in, similar |
| `document.type` | at, not, any |
| `document.first_publication_date`, `document.last_publication_date` | all date filters |
| UID `my.T.uid` | at, not, any, in, fulltext, has, missing |
| Key Text | at, not, any, fulltext, has, missing |
| Select | at, not, any, fulltext, has, missing |
| Number | at, not, any, has, missing, lt, gt, inRange |
| Date | at, not, any, has, missing, date filters |
| Content Relationship | at, not, any, has, missing (value = linked document id) |
| Boolean | at, not, has, missing |
| Rich Text, Title | fulltext, has, missing |
| Geopoint | has, missing, near |
| Timestamp | has, missing, date filters |
| Color, Link | has, missing |
| Image, Embed, Group, Integration | none |

Complete filter catalog (`pages/content-api.md` subsections; JS helper names from the same page):

| # | Wire name | JS helper | Args | Semantics |
|---|---|---|---|---|
| 1 | `at` | `filter.at` | path, value | Exact match. Single value for top-level fields (not inside slices); array only for `document.tags` = doc has **all** listed tags ("with the tags 'Macaron' and 'Cupcake'"). CR: value is doc id. Paths: document.type/tags/id, my.T.uid, key text, select, number, date, boolean, content relationship. |
| 2 | `not` | `filter.not` | path, value | Negation of `at`; same paths; arrays only for tags ("without the tags ..."). |
| 3 | `any` | `filter.any` | path, values[] | Matches any value; for id/uid result order is not the array order. Same paths as `at`. |
| 4 | `in` | `filter.in` | path (`document.id` or `my.T.uid`), values[] | Like `any` but faster and **results ordered as the given array**. |
| 5 | `fulltext` | `filter.fulltext` | path (`document` or `my.T.{uid,rich text,title,key text,select}`), string | All space-separated terms must appear (AND); case-insensitive; stemmed ("Dogs" matches "dog"); considers rich text, title, key text, select, UID anywhere incl. groups and slices; ignores image alt in rich text; results ordered by relevance with priority on rich text, especially headings. |
| 6 | `has` | `filter.has` | path `my.T.field` | Field has a value; all field kinds except groups and slices; implies type T. |
| 7 | `missing` | `filter.missing` | path `my.T.field` | Field has no value; restricts results to type T. |
| 8 | `similar` | `filter.similar` | id string, max number | Docs with similar content to the doc; `max` = maximum number of documents a term may appear in to stay relevant (higher → more results). Live: `[[similar("ZYCIiBEAAM8Dec8o",10)]]` returns 29 docs of mixed types (`ev/search.similar.json`). |
| 9 | `geopoint.near` | `filter.geopointNear` | path, latitude, longitude, radius (km) | Within radius; ordered nearest → farthest. |
| 10 | `lt` | `filter.numberLessThan` | path (number field), number | Strict `<`. |
| 11 | `gt` | `filter.numberGreaterThan` | path, number | Strict `>`. |
| 12 | `number.inRange` | `filter.numberInRange` | path, lower, upper | Inclusive both ends. |
| 13 | `date.after` | `dateAfter` | path, date | Exclusive. |
| 14 | `date.before` | `dateBefore` | path, date | Exclusive. |
| 15 | `date.between` | `dateBetween` | path, start, end | Inclusive. |
| 16 | `date.day-of-month` | `dateDayOfMonth` | path, day | Equal. |
| 17 | `date.day-of-month-after` | `dateDayOfMonthAfter` | path, day | Strictly after. |
| 18 | `date.day-of-month-before` | `dateDayOfMonthBefore` | path, day | Strictly before. |
| 19 | `date.day-of-week` | `dateDayOfWeek` | path, weekday | Equal. |
| 20 | `date.day-of-week-after` | `dateDayOfWeekAfter` | path, weekday | After. |
| 21 | `date.day-of-week-before` | `dateDayOfWeekBefore` | path, weekday | Before. |
| 22 | `date.month` | `dateMonth` | path, month | Equal. |
| 23 | `date.month-after` | `dateMonthAfter` | path, month | After. |
| 24 | `date.month-before` | `dateMonthBefore` | path, month | Before. |
| 25 | `date.year` | `dateYear` | path, year | Equal. |
| 26 | `date.hour` | `dateHour` | path, hour | Equal. |
| 27 | `date.hour-after` | `dateHourAfter` | path, hour | After. |
| 28 | `date.hour-before` | `dateHourBefore` | path, hour | Before. |

Date-filter argument types (`§ Date filters` "Accepted values"):
- path: `document.first_publication_date`, `document.last_publication_date`, `my.T.<date>`, `my.T.<timestamp>`.
- date: `"2002-08-28"`, `"2002-08-28T15:30:00+0300"`, or 13-digit epoch ms `1030545000000`.
- day: day of month number. year: number. hour: 0–23 ("Date field values have an hour value of 0").
- weekday: Monday-first; `"monday"|"mon"|1` … `"sunday"|"sun"|7`; also `"Monday"` and `"MONDAY"`.
- month: `"january"|"jan"|1` … `"december"|"dec"|12`; also capitalized and all-caps.
- Docs header says "sixteen filters for dates" = rows 13–28. Live `date.after(document.first_publication_date,"2024-01-01")` works (`ev/search.number-date.json`).

Note: `filter.fulltext` path table in docs omits `document` and title while examples use `fulltext(document,"quickstart")`; live `[[fulltext(document,"headless")]]` returns 297 results (`ev/search.fulltext.json`).

### 4.4 Ordering — `orderings`
- Syntax `orderings=[my.product.price]`, descending `[my.product.price desc]`, multiple `[my.product.price,my.product.title]` (tie-break left to right) (`pages/content-api.md § orderings`). Default direction ascending; client direction values `"asc"` (default) / `"desc"` (`pages/fetch-content.md § Sort`).
- Field formats: `my.[type].[field]` and `document.[metadata]` incl. `document.first_publication_date`, `document.last_publication_date`. Live `orderings=[document.first_publication_date desc]` (space encoded `+`) (`ev/search.ordering.json`).
- Sortable field kinds are not listed for REST; GraphQL lists rich text, title, key text, select, date, timestamp, number (`pages/graphql-technical-reference.md § Arguments`) [INFERENCE: same set; rich text/title sort by text of first block].
- Default order without `orderings` is undocumented. Live, untyped queries return a stable non-chronological sequence (`ev/search.pagesize-101.json` ids `ZYCIiBEAAM8Dec8o, ZO8HtREAACwARj42, ...`). `fulltext` sorts by relevance; `in` by array order; `geopoint.near` by distance.

### 4.5 Pagination and `after`
- `page` (default 1) and `pageSize` (default 20, max 100).
- `after=<docId>` returns the documents following that id in the current ordering; reverse the ordering to page backwards (`§ after`). Live: `after=ZYCIiBEAAM8Dec8o` on type blog returns the 2nd blog doc, `total_results_size` stays 258 (whole set, not the remainder) and `next_page` keeps `after` plus `page=2` (`ev/search.after.json`).

### 4.6 Response envelope
Live (`ev/search.ordering.json`, docs table in `pages/fetch-content.md § get methods (paginated)`):
```json
{
  "page": 1,
  "results_per_page": 3,
  "results_size": 3,
  "total_results_size": 258,
  "total_pages": 86,
  "next_page": "https://prismic-main.cdn.prismic.io/api/v2/documents/search?ref=atX5SBEAACkAzXoH&q=%5B%5Bat%28document.type%2C%22blog%22%29%5D%5D&orderings=%5Bdocument.first_publication_date+desc%5D&page=2&pageSize=3&fetch=blog.title",
  "prev_page": null,
  "results": [ /* documents */ ],
  "version": "5621b3e",
  "license": "All Rights Reserved"
}
```
- `next_page`/`prev_page`: absolute URLs or `null`; built from request params with `page` changed. Observed: params `q, orderings, page, pageSize, fetch, fetchLinks, graphQuery, after, lang` are carried over; **`routes` is dropped** (`ev/search.routes.json` next_page lacks `routes`) and `pageSize` reflects the clamped value.
- `total_pages = ceil(total_results_size / results_per_page)`.

### 4.7 Document shape
Docs example (`pages/fetch-content.md § Pages`):
```json
{
  "id": "YCiUyRUAACQAxfZK",
  "uid": "my-first-post",
  "url": "/blog/my-first-post",
  "type": "blog_post",
  "href": "https://example-prismic-repo.cdn.prismic.io/api/v2/...",
  "tags": ["Tag 1", "Tag 2"],
  "first_publication_date": "2021-02-14T03:22:26+0000",
  "last_publication_date": "2022-07-09T00:36:18+0000",
  "slugs": ["my-first-post"],
  "linked_documents": [],
  "lang": "en-us",
  "alternate_languages": [],
  "data": { }
}
```
- `alternate_languages[]`: `{id, uid?, type, lang}`. `slugs` (deprecated; first is current) and `linked_documents` (deprecated) still emitted (`[]` observed).
- Live key order: `id, uid, url, type, href, tags, first_publication_date, last_publication_date, slugs, linked_documents, lang, alternate_languages, data` (`ev/search.homepage.json`).
- `uid` is present as `null` for types without UID (live homepage doc), contradicting "Only present if the page type has a UID field" **[DISCREPANCY]**. `url` is `null` without routes.
- Dates format `YYYY-MM-DDTHH:mm:ss+0000`.
- `href` = API URL selecting this doc: `<search>?ref=<ref>&q=[[:d = at(document.id, "<id>") ]]` (encoded) (`ev/search.homepage.json`).
- Slices in `data.slices` (or a custom slice-zone key): `{id: "<slice_type>$<uuid>", slice_type, variation, version, primary, items}` (`pages/fetch-content.md § Slices`); live also `slice_label` (`ev/field-shapes.observed.md`).
- Rich text blocks may carry `"direction": "ltr"` (live) in addition to docs' `rtl`.

Linked document (content relationship / link to Document) shape, live (`ev/search.fetchlinks.json`):
```json
{
  "id": "ZTKpSxIAAFoDxsxw",
  "type": "blog_author",
  "tags": [],
  "lang": "en-eu",
  "slug": "samuel-horn-af-rantzien",
  "first_publication_date": "2023-11-06T18:12:22+0000",
  "last_publication_date": "2025-08-22T11:23:58+0000",
  "uid": "samuel-horn-af-rantzien",
  "data": { "name": [ { "type": "heading1", "text": "Samuel Horn af Rantzien", "spans": [], "direction": "ltr" } ] },
  "link_type": "Document",
  "key": "64752771-0269-4d89-8b6a-98bf2d1b33e7",
  "isBroken": false
}
```
- Empty link: `{"link_type":"Document"}` (or `"Any"`). `url` key appears on linked docs only when a route matches (live: blog links have `url`, author links have none, `ev/search.routes.json`). `data` appears only when selected via fetchLinks/graphQuery/model field selection. `key` (uuid) present on links in fields and repeatable links. Broken links: `type: "broken"`, `isBroken: true`, no route url unless `brokenRoute` (`pages/content-api.md § brokenRoute`).

### 4.8 Selective and deep fetching

**fetch (deprecated)** (`§ fetch`): `fetch=product.title` or `fetch=[product.title,product.description]` → `data` contains only those fields (live `fetch=blog.title`, `ev/search.ordering.json`). Metadata unchanged.

**fetchLinks** (`§ fetchLinks`): populate `data` of linked docs.
```
fetchLinks := item | "[" item ("," item)* "]"
item       := linkedType "." field
            | linkedType "." group "." field
            | linkedType ".body"            (slice zone; legacy name)
```
Cannot retrieve: rich text beyond its first element, any field inside a slice (only the whole slice zone). Applies to every link/CR to a doc of `linkedType`, at any depth of the parent doc (live: links inside slices and groups populated, `ev/search.fetchlinks.json`).

**graphQuery** (`§ graphQuery`, `pages/fields/content-relationship.md § GraphQuery (Legacy)`): GraphQL-like selection, encoded, subject to the 2048-char URL limit (whitespace may be minimized).
```
graphQuery := "{" typeSel+ "}"
typeSel    := typeId "{" sel* "}"
sel        := fieldId
            | fieldId "{" sel* "}"                    (group / slice zone / link)
            | "..." typeId "Fields"                    (spread: all fields of that type)
            | "..." "on" typeId "{" sel* "}"           (union branch for linked doc type)
            | "..." "on" sliceType "{" sliceSel* "}"   (slice branch)
sliceSel   := "variation" | "primary" "{" sel* "}" | "items" "{" sel* "}" | "..." sliceType "Fields"
```
Semantics: top level picks a page type; nested selects groups/slice zones (arrays); unions select per linked type or per slice type; `...xFields` spreads all fields. Selections of linked docs populate their `data`. Live `{ blog { uid title } }` → `data` contains only `title` (`uid` is metadata) (`ev/search.graphquery.json`). Marked legacy in favour of model-level field selection.

**Model-level field selection** (`pages/fields/content-relationship.md § Add a content relationship to a content model`): when a CR field is restricted to a type, the model chooses which fields of the linked doc appear in `data`, up to 2 nested levels (blog → author → profession), slice zones excluded. "When a selected field is deleted, it's automatically removed from the API response." Example response nests `profession` inside `author.data` (`§ API response`). No query param needed.

### 4.9 Other params
- `lang` (`§ lang`): default master locale; `*` returns all locales (live `lang=*` keeps param in `next_page`, `ev/search.lang-all.json`).
- `integrationFieldsRef`: selects integration-field data version; omit → maybe stale data.
- `routes` / `brokenRoute`: see §6.

### 4.10 Errors and status codes
Live:
| Case | HTTP | Body | Source |
|---|---|---|---|
| Missing `ref` | 400 [INFERENCE] | `{"type":"api_validation_error","message":"Please specify ref"}` | `ev/search.no-ref.json` |
| Unknown ref | 404 | `{"type":"api_notfound_error","message":"Ref not found. Ensure you have the correct ref and try again. Master ref is: atX5SBEAACkAzXoH"}` | `ev/search.bad-ref.json` |
| Bad filter | 400 | `api_parsing_error` + `pos` (above) | `ev/search.bad-predicate.json` |
| Bad/missing token, private repo | 401 | `{"error":"Invalid access token"}` | `ev/api-root.wroom-401.json` |
Client error classes (`pages/fetch-content.md § Errors`): `NotFoundError` (empty result for single getters), `ForbiddenError`, `ParsingError`, `PreviewTokenExpiredError`, `RefExpiredError`, `RefNotFoundError`, `RepositoryNotFoundError`, `PrismicError`. The client parses `Master ref is: <ref>` from 404/410 messages and retries (`contracts §0.6`). Bad ref is checked before bad token (`ev/protected-endpoints.txt`: bad ref + bad token → 404).

### 4.11 Caching
- CDN host is CloudFront; "Queries that use the CDN are automatically cached" and are not rate limited (`§ Limits`). Because every URL embeds the ref, cache keys are immutable per ref; `/api/v2` is `no-store`.
- Live headers on uncached host: `x-ratelimit-limit: 200`, `x-ratelimit-remaining`, `x-ratelimit-reset`.

### 4.12 Requirements (Content API)
- **REQ-API-016 (P0)** Implement `/api/v2/documents/search` with all params in §4.2, `q` multi-valued, `pageSize` default 20 clamped to 100, `page` default 1.
- **REQ-API-017 (P0)** Missing ref → `api_validation_error`; unknown or purged ref → 404 `api_notfound_error` with message ending exactly `Master ref is: <masterRef>`; expired ref → 410 with the same suffix.
- **REQ-API-018 (P0)** Filter parser accepting the grammar in §4.3 incl. whitespace, `[[...]]` and `[...]` forms, `:d = ` bindings, double/single-quoted strings, numbers, arrays; errors as `api_parsing_error` with `message` and `pos{line,column,id,location}`.
- **REQ-API-019 (P0)** Implement all 28 filters with the exact semantics, inclusivity and argument coercions of §4.3 (weekday/month names in 3 casings and numbers; dates as `YYYY-MM-DD`, ISO with offset, or epoch ms).
- **REQ-API-020 (P0)** Enforce the path/filter compatibility matrix; incompatible combinations → `api_parsing_error` [INFERENCE on exact error].
- **REQ-API-021 (P0)** `at`/`not` on `document.tags` with array = all-of / none-of; `any` = any-of; `in` preserves array order; `has`/`missing` restrict to the type in the path; CR filters compare the linked document id.
- **REQ-API-022 (P1)** `fulltext`: AND of terms, case-insensitive, stemming, coverage of rich text/title/key text/select/UID incl. groups and slices, excluding image alt; relevance ranking boosting headings; usable on `document` or a single field.
- **REQ-API-023 (P1)** `similar(id, max)` using term-document-frequency (max = doc-frequency cap); result excludes the source doc [INFERENCE].
- **REQ-API-024 (P1)** `geopoint.near` with km radius, sorted by distance.
- **REQ-API-025 (P0)** `orderings` grammar `[path( desc| asc)?(,...)*]` on `my.T.field` and `document.first_publication_date|last_publication_date`; ascending default; stable deterministic default order without orderings (proposal: `last_publication_date desc`? see open questions; at minimum stable by id).
- **REQ-API-026 (P0)** `after=<id>` cursor semantics over the current ordering, combined with `page`/`pageSize` as observed.
- **REQ-API-027 (P0)** Envelope keys and order of §4.6 including `version` and `license`; `next_page`/`prev_page` absolute URLs carrying the request params (omit `routes`, as observed).
- **REQ-API-028 (P0)** Document shape of §4.7, including `uid:null`, `url:null`, deprecated `slugs` and `linked_documents`, `href` with the `[[:d = at(document.id, "...") ]]` query, `+0000` timestamps, `alternate_languages`.
- **REQ-API-029 (P0)** Linked-document stubs on Document links/CRs: `id, type, tags, lang, slug, first_publication_date, last_publication_date, uid?, url?, data?, link_type, key?, isBroken`; broken → `type:"broken"`, `isBroken:true`, `url` = `brokenRoute` when given.
- **REQ-API-030 (P0)** `fetchLinks` grammar and limitations of §4.8, applied at every nesting depth.
- **REQ-API-031 (P1)** `graphQuery` parser/evaluator per §4.8 (selection, groups, slice unions with `primary`/`items`/`variation`, linked-doc unions, `...typeFields` spreads), applied to `data` only; metadata always returned.
- **REQ-API-032 (P0)** Model-level CR field selection (up to 2 levels, no slice zones) automatically fills linked `data`; removed fields disappear.
- **REQ-API-033 (P2)** Deprecated `fetch` param.
- **REQ-API-034 (P0)** `lang` default = master locale; `*` = all locales; unknown locale → empty results [INFERENCE].
- **REQ-API-035 (P1)** `integrationFieldsRef` param selects the integration catalog snapshot; when omitted, use latest.
- **REQ-API-036 (P0)** Reject URLs >2048 chars (414 [INFERENCE]); per-repo 200 uncached req/s limit returning 429 **with `Retry-After`** (`contracts §0.7`) and `x-ratelimit-*` headers.
- **REQ-API-037 (P0)** Ref-keyed responses are immutable and cacheable (long `cache-control`), `/api/v2` is `no-store`; a CDN in front must vary on full query string.
- **REQ-API-038 (P2)** Usage metering per repository (calls, bandwidth) to emulate plan quotas and a usage dashboard.
- **REQ-API-039 (P2)** API Explorer UI at `/builder/explorer` (repo-aware filter suggestions).

---

## 5. GraphQL API

### What
Read-only GraphQL endpoint with selective and deep fetching (`pages/graphql-technical-reference.md`).

### Contract
- Endpoint `https://<repo>.cdn.prismic.io/graphql`; explorer (GraphiQL-like, ctrl+space autocomplete) at `https://<repo>.prismic.io/graphql`.
- Transport: GET with `?query=` (Apollo `useGETForQueries: true`, graphql-request `method: "get"`); headers `Prismic-Ref: <ref>` and `Authorization` (access token) added by `client.graphQLFetch` (`pages/technical-reference/prismicio-client/v7.md § graphQLFetch()`). Live GET with `Prismic-Ref` works, response headers include `x-ratelimit-limit: 200`, `x-local-cache: MISS`, `access-control-allow-origin: *` (`ev/graphql.headers.txt`).
- Live response (`ev/graphql.sample.json`):
```json
{"data":{"allBlogs":{"totalCount":258,"edges":[{"node":{"_meta":{"uid":"what-is-serverless-building-a-fast-website","id":"ZO8HtREAACwARj6K","type":"blog","lang":"en-eu"}}}]}}}
```
- Root fields (`§ Root fields`): `_allDocuments` (all); `all{Type_id}s` = type API id with first letter capitalized + `s` (`allBlog_posts`, live `allBlogs`); `{type_id}(uid:, lang:)` single.
- Connection fields (`§ Pagination fields`): `pageInfo{hasPreviousPage hasNextPage startCursor endCursor}`, `edges{cursor node}`, `totalCount`. Args `first` (≤100), `last`, `after`, `before`.
- Content fields (`§ Content fields`): Timestamp, Date, Color, Number, Key Text, Select, Title, Rich Text, Image, Embed, Geopoint, Boolean selected as scalars (JSON); groups with sub-selection; Link / Media / CR via unions.
- `_meta` (`§ Metadata fields`): `id uid type tags lang firstPublicationDate lastPublicationDate alternateLanguages`.
- Filter args (`§ Arguments`): `fulltext: String` (rich text, title, key text, uid, select; case-insensitive), `uid`, `uid_in: [String]`, `id`, `id_in`, `lang` (`"*"` presumably allowed [INFERENCE]), `tags`, `tags_in`, `firstPublicationDate_after|_before`, `lastPublicationDate_after|_before` (format `"2022-05-12T15:47:11+0000"`).
- `where` (top-level content fields only, no slice fields; "accepts a single key-value pair"): `<field>` (exact), `<number>_gt`, `<number>_lt`, `<number>_range: [lo, hi]`, `<date>_before`, `<date>_after`, `<geopoint>_near: {lat, lng, dist}`.
- `similar`: object with a document id and `max` (doc-frequency cap) [field names undocumented; INFERENCE `{documentId, max}`].
- `sortBy`: `<field>_ASC|_DESC`, where field is `meta_firstPublicationDate`, `meta_lastPublicationDate` or a top-level rich text, title, key text, select, date, timestamp or number field.
- Unions (`§ Unions`):
  - Slices: inside `body`: `... on {Type}Body{Slice}` (e.g. `PageBodyPlaylist`) exposing `label`, `type`, `primary{...}`, `fields{...}` (repeatable zone, deprecated).
  - Content relationship: `... on _Document { __typename _meta{...} }` or `... on <LinkedType> {...}`.
  - Links: `... on _ExternalLink {url}`, media `... on _ImageLink` (and file link) with link properties.
- Docs typo: `lastPublication_before` should be `lastPublicationDate_before`.

### Requirements
- **REQ-API-040 (P1)** Serve `/graphql` (GET `query`, `variables`, `operationName`; POST optional) reading `Prismic-Ref` header (fallback: master ref [INFERENCE]) and access token in `Authorization`.
- **REQ-API-041 (P1)** Generate the schema per repository from custom types: root fields `_allDocuments`, `all<Cap(type)>s`, `<type>(uid, lang)`; Relay connections with `totalCount`, `first` ≤ 100.
- **REQ-API-042 (P1)** Implement filter args, `where` suffixes, `similar`, `sortBy` enum, `_meta` fields and unions (`<Type>Body<Slice>`, `_Document`, `_ExternalLink`, `_ImageLink`, `_FileLink`) exactly as named above; regenerate schema on model change.
- **REQ-API-043 (P2)** GraphQL explorer UI at `https://<repo>.<host>/graphql`.
- **REQ-API-044 (P2)** Shared slices (variations) in GraphQL: naming undocumented; see open questions.

---

## 6. Route resolver (`routes`, `brokenRoute`) and link resolution

### What
Server-side computation of each document's `url` from client-supplied rules, sent on every request (`pages/routes.md`; `pages/content-api.md § routes`).

### Contract
- Param `routes=<JSON array>` (encoded), e.g. `routes=[{"type":"page","path":"/:uid"}]`. Without `routes`, `url` is `null`. Live `routes` with `{"type":"blog","path":"/blog/:uid"}` gives `"url":"/blog/nextjs-table-of-contents-tutorial"` and the same on nested blog links (`ev/search.routes.json`).
- Route object (`pages/routes.md § Route resolver properties`):

| Property | Type | Meaning |
|---|---|---|
| `type` | string | page type API id |
| `path` | string | path template with keywords |
| `resolvers` | Record<string,string> | keyword → CR field API id (dot path for nesting) |
| `uid` | string | scope to the one doc with this UID |
| `lang` | string | scope to docs in this locale |

- Keywords (`§ Path keywords`; `pages/content-api.md § routes`):
  - `:uid` page UID.
  - `:lang` locale code (e.g. `fr-fr`).
  - `:lang?` locale code only when not the master locale, else the segment is omitted (`/:lang?/blog/:uid` → `/blog/x` in master, `/fr-fr/blog/x` otherwise; `pages/locales.md`).
  - `:<resolverName>` / `:<resolverName>?` = UID of the doc linked via the resolver's CR field; `?` omits the segment when the CR is empty.
- Resolvers: `{"parent":"parent","grandparent":"parent.parent"}` with path `/:grandparent?/:parent?/:uid` → `/about-us/our-team/jane-doe`; "Up to two levels of nesting is supported" (`§ Parent-child nested URLs`).
- Scoped routes: `{"type":"page","uid":"my-special-page","path":"/foo"}`; `{"type":"page","lang":"fr-fr","path":"/fr/:uid"}` (`§ Override a specific UID`, `§ Modify a locale code`).
- Broken links (linked doc archived or deleted) get no URL; `brokenRoute=/404` fills `url` on broken link/CR fields (`§ Broken routes`; `pages/content-api.md § brokenRoute`).
- Routes are configured in `prismic.config.json` `routes` (CLI adds a default route per page type at `type create --format page`) (`pages/routes.md § Define route resolvers`, `pages/content-modeling.md`).
- Link resolver functions are client-side only (`asLink`), fall back to route resolvers (`§ Link resolver`).
- `url` is computed for the top-level docs, `alternate_languages`? (not observed) and every Document link at any depth, including rich text hyperlink spans (`ev/search.routes.json` `.data.slices.3.primary.content.5.spans.0.data.url`).

### Requirements
- **REQ-API-045 (P0)** Parse `routes` JSON; for each document/link of type T choose the matching route (type match; `uid`/`lang` constraints must match when present) and render the path; set `url` (top-level `null` if none matches; on links omit `url` when none matches, as observed).
- **REQ-API-046 (P0)** Keywords `:uid`, `:lang`, `:lang?`, custom resolver keywords with optional `?`; optional empty segments collapse without double slashes; required keyword with no value → no URL [INFERENCE].
- **REQ-API-047 (P0)** Resolver paths `field` and `field.field` (max 2 levels) following CR fields of the routed doc (and of its linked doc); resolution uses the same ref as the query.
- **REQ-API-048 (P1)** Precedence: specific (`uid` and/or `lang` scoped) routes win over generic ones for the same type; otherwise first in array [INFERENCE, see open questions].
- **REQ-API-049 (P0)** `brokenRoute` applied to links whose target is archived/deleted/unpublished in the queried ref.
- **REQ-API-050 (P1)** Validate route JSON; invalid → `api_validation_error` 400 [INFERENCE].

---

## 7. Types API (`customtypes.prismic.io`)

### What
CRUD for custom/page types and shared slices as JSON models (`pages/custom-types-api.md`; `pages/technologies/custom-types-api.md` is byte-identical apart from the source URL).

### Contract
Base `https://customtypes.prismic.io`; headers `repository`, `Authorization: Bearer <write token>`, `Content-Type: application/json` on POST (`§ Authentication`, curl examples).

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/customtypes` | — | 200 JSON array of all custom types | — |
| GET | `/customtypes/{customTypeId}` | — | 200 custom type object | (404 [INFERENCE]) |
| POST | `/customtypes/insert` | custom type | **201 Created** | **409** id exists |
| POST | `/customtypes/update` | custom type | **204 No Content** | **422** id does not exist |
| DELETE | `/customtypes/{customTypeId}` | — | 204 | — |
| GET | `/slices` | — | 200 array of shared slices | — |
| GET | `/slices/{sliceId}` | — | 200 slice object | — |
| POST | `/slices/insert` | shared slice | 201 | 409 |
| POST | `/slices/update` | shared slice | 204 | 422 |
| DELETE | `/slices/{sliceId}` | — | 204 | — |

- One object per POST; id read from the body; no bulk edits or bulk deletes (`§ Add custom types (POST requests)`, `§ Remove custom types`).
- Custom type object (`§ Active custom types`):
```json
{
  "id":"page",
  "label":"Page",
  "repeatable":true,
  "json":{ "Page":{ "uid":{ "type":"UID", "config":{ "label":"UID", "placeholder":"example-unique-identifier" } } } },
  "status":true
}
```
  `json` maps tab names to field maps; `status:false` = disabled type (hidden from editors). A `format` (`"page"|"custom"`) exists per the MCP `list_custom_types` tool ("id, label, and format", `pages/mcp.md § Discovery`) and CLI `--format page` [INFERENCE: JSON key `format`].
- Shared slice object (`§ Insert a new Shared slice`):
```json
{
  "id": "image_gallery",
  "type": "SharedSlice",
  "name": "ImageGallery",
  "description": "ImageGallery",
  "variations": [
    {
      "id": "default",
      "name": "Default",
      "docURL": "...",
      "version": "sktwi1xtmkfgx8626",
      "description": "Text",
      "primary": {
        "text": { "type": "StructuredText", "config": { "label": "Text", "placeholder": "Text with rich formatting", "allowTargetBlank": false, "multi": "paragraph" } }
      },
      "items": {},
      "imageUrl": "https://images.prismic.io/tutorial-series/shared-slices/image_gallery/preview.png"
    }
  ]
}
```
- `variations[].version` ends up as the `version` of slice instances in content (live `"version":"sktwi1xtmkfgx8626"`, `ev/field-shapes.observed.md`).
- No-token request: 403 `AccessDeniedException` (`ev/protected-endpoints.txt`).
- Shared slices may require feature activation on old repos (`§ All shared slices`).

### Requirements
- **REQ-WAPI-004 (P0)** Implement the 10 routes with the exact status codes (201/409, 204/422, 204 delete) and the JSON shapes above; `GET` lists return arrays.
- **REQ-WAPI-005 (P0)** Persist `status`, `repeatable`, `label`, `json` tabs, `format`; disabled types remain stored and visible via API.
- **REQ-WAPI-006 (P0)** Model changes immediately affect Content API (`types` map in `/api/v2`), GraphQL schema, CR field selection and Migration API validation.
- **REQ-WAPI-007 (P1)** Deleting a type with documents: behaviour undocumented (content "removed" from API, `pages/environments.md § FAQs` says renaming = remove + add); keep documents but hide them [INFERENCE].
- **REQ-WAPI-008 (P1)** Validate model JSON (field types `UID`, `StructuredText`, ...; details in field REA) returning 400 with a message.

---

## 8. Migration API (`migration.prismic.io`)

### What
Create/update one draft page per request, staged in the repository's **migration release** (`pages/migration-api-technical-reference.md`). Legacy path vs AI migration (`pages/migration/programmatic.md`).

### Contract
- Headers: `Authorization` (write token, Bearer), `repository` (`§ Headers`).
- `POST https://migration.prismic.io/documents` — create. Required: `title`, `type`, `uid` (if type has UID), `lang`, `data`, `alternate_language_id` (when creating a localized version of a singleton). Optional `tags`.
- `PUT https://migration.prismic.io/documents/:id/` — update. Required `uid` (if on type), `data`; optional `title`, `tags`; `type`, `lang`, `alternate_language_id` ignored. **Omitting `tags` on PUT deletes existing tags.**
- Response: POST returns the new page `id` ("We recommend saving the `id` from the POST response") — full body undocumented.
- Limits: one page per request; **1 request/second/repository** (`§ Limits`). The client serialises writes with 1500 ms gaps and honors `Retry-After` on 429 (`contracts §0.7`).
- Pages are created as drafts in a "Migration Release" (Migration Releases tab). Publishing via UI or `client.publishMigrationRelease()` which returns `{ totalItems: number }` and is processed asynchronously (`pages/technical-reference/prismicio-client/v7.md § publishMigrationRelease()`); the HTTP route is undocumented. Migration release capacity 1,000 pages (`pages/migration/programmatic.md § Script setup`).
- Input format = Content API document format; extra properties are ignored, so a Content API doc can be posted back (`§ Usage`).
- Full example body: see `pages/migration-api-technical-reference.md § Example request body` (title, uid, type, lang, tags, alternate_language_id, data with every field type incl. `slices` and a second slice zone). Key excerpts:
```json
{
  "title": "Example page", "uid": "example-page", "type": "example_type", "lang": "en-US",
  "tags": ["Red", "Yellow", "Blue"], "alternate_language_id": "ZRFHsxIAAFYAsY--",
  "data": {
    "example_image_2": { "id": "ZMgV5hAAAEADVsPS", "alt": "Example alt text", "copyright": "Example copyright info",
      "dimensions": { "width": 800, "height": 200 }, "edit": { "x": 2, "y": 28, "zoom": 3, "background": "#ffffff" },
      "mobile": { "id": "ZMgV5hAAAEADVsPS", "alt": "this is some alt text", "copyright": "some copyright info" } },
    "example_page_link": { "link_type": "Document", "id": "ZMI65RQAADkECUFM" },
    "example_geopoint": { "latitude": "-9", "longitude": "-160" },
    "slices": [ { "variation": "default", "primary": { "example_number": 11 }, "slice_type": "example_slice_type_1" } ]
  }
}
```
- Per-field validation (`§ Data`):
  - Boolean `null|boolean` (null → model default); Color `null|"#hex"`; Date `null|"YYYY-MM-DD"`; Timestamp `null|"YYYY-MM-DDTHH:MM:SS+0000"`; Number `null|number` within model min/max; Key text string; Select `null|string` in options (null → default); Integration `string|number` item id; Embed `{embed_url?}` (other keys ignored); Geopoint `{}` or `{latitude,longitude}` as numeric strings in [-90,90]/[-180,180]; Group array of field objects.
  - Image `{id (required, existing media id), alt, copyright, dimensions{width,height} (ignored if thumbnail size configured), edit{x,y,zoom,background}}` plus thumbnail keys with the same shape. Background default transparent for PNG, `#ffffff` otherwise.
  - Link `{link_type: "Document"|"Web"|"Media", id (Document/Media; doc may be unpublished), url (Web, absolute), target ("_blank" only), text}`; CR = Document link.
  - Rich text blocks types `paragraph, o-list-item, list-item, heading1..6, preformatted, embed, image`; text blocks `{text (required), spans[{start,end,type:"em"|"strong"|"hyperlink",+link props}], direction:"rtl"}`; embed `{oembed:{embed_url}}`; image block = image field. Spans may overlap. Block types restricted by field config (error example below).
  - Slice zone arrays; slice `{slice_type (req), variation (req, must exist), id? ("<slice_type>$<uuidv4>", unique, generated if omitted), slice_label? (default null), primary, items (deprecated)}`. Default slice zone key `slices`.
- Errors: JSON array of `{property, value?, error}`:
```json
[{"property":"data.richtext.2.type","value":"heading2","error":"Invalid block type. Supported block types are: paragraph, embed"}]
```
```json
[{"property":"title","error":"The value must be a string"}]
```
  HTTP status not documented (400/422 [INFERENCE]). No-token: 403 `MissingAuthenticationTokenException` (`ev/protected-endpoints.txt`).
- Alternate-language links can only be set at creation (`pages/migration/programmatic.md § Create alternate language documents`).
- Client-side conveniences that need no server support: asset dedup by source, lazy CR resolution, `createDocumentFromPrismic` (`pages/migration/programmatic.md`). `@prismicio/migrate` `htmlAsRichText()` converts HTML client-side.

**[DISCREPANCY]** Releases hold "up to 200 pages" (`pages/releases.md`) vs migration release / MCP release "up to 1,000 pages" (`pages/migration/programmatic.md`, `pages/migration.md § Migrate your content`).

### Requirements
- **REQ-WAPI-009 (P0)** `POST /documents` and `PUT /documents/:id/` (trailing slash tolerated) with the required/optional/ignored property rules above; POST returns at least `{ "id": "<docId>" }` (plus `title`, `type`, `lang` [INFERENCE]).
- **REQ-WAPI-010 (P0)** Full per-field validation and coercion of §8, errors as `[{property, value?, error}]` with dotted `property` paths.
- **REQ-WAPI-011 (P0)** Writes land as draft versions inside a per-repository migration release (auto-created, separate list in UI); PUT on a doc creates/overwrites its migration-release version.
- **REQ-WAPI-012 (P0)** Publish-migration-release endpoint returning `{totalItems}` and publishing asynchronously (emits the normal publish webhooks).
- **REQ-WAPI-013 (P1)** Per-repo write rate limit (1 req/s documented) returning 429 with `Retry-After`.
- **REQ-WAPI-014 (P1)** UID uniqueness per type+lang, UID required iff model has UID, `alternate_language_id` creates translation linkage.
- **REQ-WAPI-015 (P1)** Migration release capacity 1,000 docs; normal release 200.

---

## 9. Asset API (`asset-api.prismic.io`)

### What
Manage media library assets (`pages/asset-api-technical-reference.md`).

### Contract
- Headers: `repository` (req), `authorization: Bearer <write token>` (req), `origin` (optional).
- `GET /assets?assetType=all|image&limit=100&cursor=<assetId>&keyword=<text>` — keyword searches `title`, `filename`, `alt`, `notes`, `credits`. Item example:
```json
{
   "id":"Zestwpsz31z-H2JI",
   "url":"https://prismic-io.imgix.net/yourrepo/yourpng.png?auto=format,compress",
   "filename":"example file name.png",
   "size":157432,
   "width":2960,
   "height":1318,
   "last_modified":1709911490751,
   "kind":"image",
   "extension":"png",
   "notes":"notes text",
   "credits":"credits text",
   "alt":"alt text",
   "created_at":1709911490751
}
```
  The list envelope is not documented [INFERENCE: `{ total, items: [...], cursor }`].
- `POST /assets` — `multipart/form-data` with `file`, optional `notes`, `credits`, `alt`; response = asset object.
- `PATCH /assets/{asset-id}` — JSON `{notes, credits, alt}`, each ≤ 500 characters.
- `DELETE /assets/{asset-id}` — deleting assets used in published pages yields broken files.
- Asset tags exist (`migration.createAsset(..., {tags})`, `pages/migration/programmatic.md § Create assets`); tag endpoints undocumented.
- Limits: one asset per request; "one per second" (docs) vs live headers `x-ratelimit-limit-second: 10`, `ratelimit-remaining`, `ratelimit-reset` (`ev/protected-endpoints.txt`) **[DISCREPANCY]**.
- Delivery: images served by imgix (`images.prismic.io`), honoring `auto=format` (AVIF negotiation), `w`, `h`, `fit=crop`, `fm`, `q`, `rect`, `blur` (`ev/image-cdn-probe.txt`); asset URL host in the docs example is `prismic-io.imgix.net`.

### Requirements
- **REQ-WAPI-016 (P0)** GET/POST/PATCH/DELETE `/assets` per above; asset object keys exactly as the example; `id` usable as `id` in Migration API image/media fields and visible in Content API image `id`.
- **REQ-WAPI-017 (P0)** Cursor pagination (`cursor` = last asset id), `limit`, `assetType` (`all`, `image`, plus file/video kinds [INFERENCE]), keyword search.
- **REQ-WAPI-018 (P0)** Image CDN supporting imgix-compatible params (`auto=format,compress`, `w`, `h`, `fit`, `fm`, `q`, `rect`, `blur`, ...) at URLs returned in `url`.
- **REQ-WAPI-019 (P1)** Metadata limits 500 chars; per-repo rate limit with `ratelimit-*`/`x-ratelimit-*-second` headers and 429 + `Retry-After`.
- **REQ-WAPI-020 (P2)** Asset tags API (used by `@prismicio/client` migrations).

---

## 10. Integration Fields API

### What
Third-party catalogs feeding Integration fields; data appears in the Content API from the item's `blob` (`pages/fields/integration.md`).

### Contract
- Pull (Prismic → your endpoint, every 30 min): `GET <endpoint>?page=<n>` expecting
```ts
type Payload = { results_size: number; results: Array<{ id: string; title: string; description: string; blob: object; image_url?: string; last_update?: number }> };
```
  ≤ 50 items per page; `results_size` = total. Optional Basic auth: `Authorization: Basic base64("<token>:")`.
- Push API: `https://if-api.prismic.io/if/write/<repo>--<catalog>` with `Authorization: Bearer <catalog token>`:
  - `POST <endpoint>` body = item array (create or update).
  - `POST <endpoint>/deleteItems` body = array of ids.
  - `POST <endpoint>/reset` empty body = delete all (irreversible).
- Catalog tokens created/revoked per catalog in Settings → Integration Fields.
- Content API value = `blob`, e.g. `{"id": 6562914664611, "handle": "organic-toast-golden", ...}`; `id` not exposed unless in blob. Versioned by `integrationFieldsRef` (§4.9). Shopify sync (`read_products` scope).
- Catalogs are shared between environments (`pages/environments.md`).

### Requirements
- **REQ-WAPI-021 (P1)** Push API with the three routes and Bearer catalog tokens; pull scheduler (30 min) with pagination and Basic auth.
- **REQ-WAPI-022 (P1)** Every catalog change produces a new `integrationFieldsRef` exposed by `/api/v2`.
- **REQ-WAPI-023 (P2)** Shopify product sync.

---

## 11. Previews

### What
Previews come in two forms (`pages/previews.md`): **live previews** (slice thumbnails in the Page Builder rendered by the site's `/slice-simulator`) and **full-website previews** (draft content across the site via a preview ref, with the Prismic toolbar and shareable links).

### Contract: configuration
- Repository stores **preview URLs** (one per website address, each with a name), e.g. `https://example.com/api/preview`; CLI `npx prismic preview add <url> [--name Development]`, `preview remove`; UI Settings → Previews (`pages/previews.md § Set up previews`, `pages/nextjs.md § Preview draft content`).
- Repository stores exactly **one slice simulator URL** (each change replaces it): `npx prismic preview set-simulator <url>`; also Page Builder "Live preview settings" (`pages/slice-machine.md`).
- Framework routes: Next.js `/api/preview` (start) and `/api/exit-preview` (end); Nuxt `/preview`; SvelteKit `/api/preview` (`pages/nextjs.md`, `pages/sveltekit.md`, `pages/slice-machine.md § Preview routes`).

### Contract: full-website preview flow (step by step)
Docs summary (`pages/previews.md § How full-website previews work`) merged with SDK params (`pages/prismic-client-v6-migration-guide.md`, `pages/technical-reference/prismicio-client/v7.md § resolvePreviewURL()`) and toolbar code (`ev/toolbar.prismic.js`):

1. Editor clicks **Preview the page** (or a release's **Preview** button, choosing a preview environment, `pages/releases.md § Preview all changes`) in the Page Builder.
2. Prismic creates a temporary preview session and a **preview ref** (token) covering the editor's draft/release state.
3. Prismic sets the preview cookie and opens `<previewURL>?token=<previewRef>&documentId=<docId>` (param names `token`, `documentId`).
4. The site's preview route calls `client.resolvePreviewURL({ linkResolver?, defaultURL: "/" })`, which reads `token`/`documentId`, queries the Content API for `documentId` using `ref=<token>` and the configured `routes`, and returns the doc `url` (or `defaultURL`). Framework kits store the ref in the `io.prismic.preview` cookie (Next.js draft mode) and redirect there.
5. On every subsequent request the client (`enableAutoPreviews`) reads the cookie and sends its value as `ref` (`contracts §0.5`: the raw cookie value, possibly a JSON blob, is passed as `ref`).
6. The toolbar script detects the session and shows the toolbar (pages in preview, edit links, share link, exit).
7. Editor saves more drafts → session ref changes → toolbar updates the cookie and reloads (see below). Exit → cookie cleared, `prismicPreviewEnd`, reload; Next.js `/api/exit-preview` disables draft mode.
8. "The preview session remains active until closed or expired"; expired → `PreviewTokenExpiredError` in client.

**[DISCREPANCY]** `pages/previews.md` says Prismic sets a "`preview.prismic.io` cookie"; the toolbar code manages a cookie named **`io.prismic.preview`** (and `io.prismic.preview.updated`) on the website's own domain (`ev/toolbar.prismic.js`).

### Contract: toolbar (from `ev/toolbar.prismic.js`)
- Loader: `<script async defer src="https://static.cdn.prismic.io/prismic.js?new=true&repo=<repo>">`. `repo` may be a name (→ `<repo>.prismic.io`) or a full host (`.cdn.` stripped; any `host[:port]` accepted; `.test` hosts use the page protocol, else `https:`). An old `toolbar.v4.js` path returns S3 AccessDenied (`ev/toolbar.v4.js`).
- Modes by `window.name`: top window = `regular`; `prismic:embedded-preview` = embedded push mode; `prismic:embedded-preview:poll` = embedded poll mode (Page Builder side-by-side preview).
- Bridge: hidden iframe `https://<repoHost>/prismic-toolbar/5e015029/iframe.html`; on load the page posts `{type:"prismic-toolbar:connect"}` with a `MessageChannel` port; iframe answers `{type:"prismic-toolbar:ready"}` (15 s timeout). RPC messages `{id, method, params}` → `{id, result}` or `{id, error}`; methods `getState()` (→ `{isAuthenticated, preview?: {ref, ...}}`), `ping(ref)` (→ `{ref|null}`), `closeSession()`, `share(url)`.
- UI assets: `https://prismic.io/prismic-toolbar/5e015029/toolbar.js` (`window.__prismicToolbar.mountToolbar({session, repositoryHost})`) and `embedded-preview.js` (`setupEmbeddedPreview`).
- Polling: `ping` every 3 s while visible; `null` → session ended, remove own cookie entry.
- Cookie `io.prismic.preview` (path `/`; `SameSite=None; Secure` when framed on https/localhost, else `SameSite=Lax`): either a plain ref string, or JSON `{"_tracker":"<8 random alnum>", "<repoHost>": {"preview": "<ref>"}, ...}` keyed per repository host. Cookie `io.prismic.preview.updated` = JSON `{version:2, repository, ref, at}` used to coordinate tabs (10-minute validity).
- Window `CustomEvent`s (cancelable, `detail: {ref}`): `prismicPreviewStart` (followed by `prismicPreviewUpdate`), `prismicPreviewUpdate`, `prismicPreviewEnd`; if not `preventDefault()`ed the page reloads.
- Share: `share(url)` returns a shareable link; links "are temporary and expire" and work without a Prismic account (`pages/previews.md § Share previews`).

### Contract: live previews
`pages/previews.md § How live previews work`: Page Builder converts the edited content to Content API format in real time → sends via `window.postMessage()` through an iframe bridge → each slice iframe loads `<simulatorURL>` (`/slice-simulator`) → the route keeps state "as a compressed URL parameter" → site components render. Mock data for the simulator is described in `pages/glossary.md` ("JSON that imitates content from the Prismic API").

### Requirements
- **REQ-PRV-001 (P0)** Preview session service: mint a short-lived preview ref representing (master + current drafts of the session's documents) or (master + a release), accepted by `/documents/search` and `/graphql` as `ref`; expired refs → error mapped to `PreviewTokenExpiredError` (410 or 404 with `api_*` type [INFERENCE]).
- **REQ-PRV-002 (P0)** Redirect the editor to `<previewURL>?token=<ref>&documentId=<id>`; preview URL chosen from the repository's named list.
- **REQ-PRV-003 (P0)** Accept as `ref` any of: a plain ref, a preview token, or the raw JSON cookie blob `{"_tracker":..., "<host>":{"preview":"<ref>"}}` (possibly URL-encoded) (`contracts §0.5`).
- **REQ-PRV-004 (P0)** Ship a toolbar loader compatible with `prismic.js?new=true&repo=<host>` that points to the clone's host (the loader already accepts full hostnames), plus the iframe endpoint `/prismic-toolbar/<build>/iframe.html` implementing the MessageChannel protocol (`connect/ready`, `getState`, `ping`, `closeSession`, `share`) and the cookie/event semantics above.
- **REQ-PRV-005 (P1)** Toolbar UI: list of documents in the preview, open-in-editor links, shareable link, exit button; bottom-left placement.
- **REQ-PRV-006 (P1)** Shareable preview links: unauthenticated, expiring, set the preview cookie for the visitor and redirect.
- **REQ-PRV-007 (P1)** Release previews from the release list ("Preview" button, choose preview environment).
- **REQ-PRV-008 (P0)** Repository settings API for preview URLs (CRUD, named) and the single simulator URL, consumed by the CLI `preview add|remove|set-simulator` (user-login auth only).
- **REQ-PRV-009 (P1)** Live previews: Page Builder posts content in Content API format to an iframe of `<simulatorURL>` via `postMessage` compatible with `@prismicio/*` `SliceSimulator` components (protocol detail belongs to SDK REA; must be matched exactly).
- **REQ-PRV-010 (P1)** Embedded preview modes (`prismic:embedded-preview`, `:poll`) for the Page Builder's in-app preview pane.
- **REQ-PRV-011 (P2)** `io.prismic.preview.updated` multi-tab coordination cookie.

---

## 12. Webhooks

### What
HTTP `POST` to a configured URL "when a page is published or edited" (`pages/webhooks.md`).

### Contract: configuration
- CLI: `npx prismic webhook create <url> [--name <name>] [--secret <secret>] [--trigger <t>]...`; default = all triggers. Settings → Webhooks UI (`pages/webhooks.md § Create a webhook`; `--name`, `--secret` from `pages/with-lokalise.md` step 3).
- Trigger identifiers documented in examples: `documentsPublished`, `documentsUnpublished`, `releasesUpdated`. [INFERENCE] remaining identifiers for the documented events: `releasesCreated`, `releasesDeleted`, `tagsCreated`, `tagsDeleted`.
- Events (`§ Events`): page published/unpublished; release created/edited/deleted; tag created/deleted; plus a manual **test trigger** ("Trigger it" button).
- Delivery: non-`200` responses are retried "every 10 minutes up to 5 times"; a webhook "failing five times consecutively" is automatically disabled (`§ Failed requests are retried`).
- Logs: recent triggers on the Webhooks page; "See the logs" / Logs tab with all events of the past 30 days (`§ Recent triggers are logged`).
- Secret is sent **in the JSON body** (`secret`), not as a header; receivers compare `payload.secret` (`pages/with-lokalise.md`).
- Webhooks are not cloned into environments (`pages/environments.md`).

### Contract: payload schema (`§ Payload`)
| Property | Type | Notes |
|---|---|---|
| `type` | `"api-update"` \| `"test-trigger"` | |
| `secret` | string \| null | configured secret, default `null` |
| `masterRef` | string | new master ref |
| `domain` | string | repository name |
| `apiUrl` | string | `https://<repo>.prismic.io/api` (note: no `/v2`, non-CDN host) |
| `releases` | object | `addition[]`, `update[]`, `deletion[]` of `{id, ref, label, scheduledAt?, documents[]}` |
| `tags` | object | `addition[]`, `deletion[]` of `{id}` |
| `documents` | string[] | changed page ids |
| `masks`, `experiments` | `{}` | present in all examples, undocumented (legacy) |
| `bookmarks`, `collection` | object | deprecated legacy |

### Payload per trigger (copied from `pages/webhooks.md § Example payloads`)

**Page published** (`documentsPublished`):
```json
{
  "type": "api-update",
  "masterRef": "X6qn-RIAACMAVge1",
  "releases": {},
  "masks": {},
  "tags": {},
  "experiments": {},
  "documents": ["X6LcjhAAAB8AUJwb"],
  "domain": "your-repo-name",
  "apiUrl": "https://your-repo-name.prismic.io/api",
  "secret": null
}
```

**Page unpublished** (`documentsUnpublished`) — identical structure ("looks identical to when a page is published"):
```json
{
  "type": "api-update",
  "masterRef": "X66c6xIAACEAZ8LK",
  "releases": {},
  "masks": {},
  "tags": {},
  "experiments": {},
  "documents": ["X3b_1hIAACMA-YWk"],
  "domain": "your-repo-name",
  "apiUrl": "https://your-repo-name.prismic.io/api",
  "secret": null
}
```

**Release created** (`releasesCreated`) — as published in the docs (note: invalid JSON with a trailing comma and an extra `}`, and no `masterRef`):
```json
{
    "type": "api-update",
    "releases": {
      "addition": [
        {
          "id": "X66oBhIAACMAaDeo",
          "ref": "X66oBhIAABMAaDep~X66c6xIAACEAZ8LK",
          "label": "release4",
          "documents": [
             "X3Lb_VGRfEAUJlg",
          ]
        }
      ]
    },
    "masks": {},
    "tags": {},
    "experiments": {},
    "documents": [],
    "domain": "your-repo-name",
    "apiUrl": "https://your-repo-name.prismic.io/api",
    "secret": null
  }
}
```
Creating a release from inside a page emits an `update` instead of an `addition` (created then immediately updated).

**Release updated** (`releasesUpdated`) — fires on schedule changes, and when pages are added/edited in the release (the release `ref` changes each time; used by the Lokalise integration):
```json
{
  "type": "api-update",
  "releases": {
    "update": [
      {
        "id": "X5G-wBIAACYAfrlX",
        "ref": "X5G-zxIAABIAfrmd~X6qyuRIAACIAVjA7",
        "label": "webhookstest",
        "scheduledAt": 1605135600000,
        "documents": ["X6Lb_xAAAFTVUJlg"]
      }
    ]
  },
  "masks": {},
  "tags": {},
  "experiments": {},
  "documents": [],
  "domain": "your-repo-name",
  "apiUrl": "https://your-repo-name.prismic.io/api",
  "secret": null
}
```

**Release deleted** (`releasesDeleted`) — also sent when a release is **published**:
```json
{
  "type": "api-update",
  "masterRef": "XaBPIxEAABkAe5n8",
  "releases": {
    "deletion": [
      {
        "id": "XZ9MwBEAABkAdylL",
        "ref": "XZ9NKBEAAA8Adysd~XaBN7BEAABkAe5Sg",
        "label": "test",
        "scheduledAt": 1572523200000,
        "documents": ["X6Lb_xAAACEAUJlg"]
      }
    ]
  },
  "bookmarks": {},
  "masks": {},
  "collection": {},
  "tags": {},
  "experiments": {},
  "domain": "your-repo-name",
  "apiUrl": "https://your-repo-name.prismic.io/api",
  "secret": null
}
```

**Tag added** (`tagsCreated`) — only the first time a page using a new tag is published; `documents` holds that page:
```json
{
  "type": "api-update",
  "masterRef": "X6A5sxIAACkAvjzh",
  "releases": {},
  "masks": {},
  "tags": { "addition": [ { "id": "testtag" } ] },
  "experiments": {},
  "documents": ["XxhMhBMAACAAWMp6"],
  "domain": "your-repo-name",
  "apiUrl": "https://your-repo-name.prismic.io/api",
  "secret": null
}
```

**Tag deleted** (`tagsDeleted`) — when the tag is removed from all pages that used it:
```json
{
  "type": "api-update",
  "masterRef": "X6A8CRIAACcAvkbK",
  "releases": {},
  "masks": {},
  "tags": { "deletion": [ { "id": "old blogs" } ] },
  "experiments": {},
  "documents": ["XxhMhBMAACAAWMp6"],
  "domain": "your-repo-name",
  "apiUrl": "https://your-repo-name.prismic.io/api",
  "secret": null
}
```

**Test trigger**:
```json
{
  "type": "test-trigger",
  "domain": "your-repo-name",
  "apiUrl": "https://your-repo-name.prismic.io/api",
  "secret": null
}
```

**[DISCREPANCY]** Docs say "Seven events can trigger a webhook call" and list 7 examples, of which one is the test trigger: so 6 real events + test. The created/updated examples lack `masterRef`; the deleted example lacks `documents`. The table calls `tags.addition` "list of changes made to tags" for both arrays.

### Requirements
- **REQ-WH-001 (P0)** Webhook registry per repository: `{url, name, secret?, triggers[], enabled}` with CRUD via settings API (used by CLI `webhook create|list|...` with user login) and UI.
- **REQ-WH-002 (P0)** Trigger `documentsPublished`: on every publish (single page, release publish, scheduled publish, migration release publish), POST `api-update` with new `masterRef` and published doc ids in `documents`.
- **REQ-WH-003 (P0)** Trigger `documentsUnpublished`: on archive/unpublish, same shape; ids in `documents`.
- **REQ-WH-004 (P1)** Trigger `releasesCreated`: `releases.addition[{id, ref, label, documents}]`; creation-from-page path emits `update` instead.
- **REQ-WH-005 (P1)** Trigger `releasesUpdated`: on schedule change and on any page add/edit inside the release, `releases.update[{id, ref, label, scheduledAt?, documents}]`.
- **REQ-WH-006 (P1)** Trigger `releasesDeleted`: on release deletion AND release publication, `releases.deletion[...]` plus `masterRef`.
- **REQ-WH-007 (P1)** Triggers `tagsCreated` / `tagsDeleted`: first publication of a page with a new tag / removal of a tag from its last page; `tags.addition|deletion[{id}]` and `documents`.
- **REQ-WH-008 (P0)** Envelope always includes `type, domain, apiUrl, secret` and, for `api-update`, `masterRef, releases, masks:{}, tags, experiments:{}, documents` (emit `masterRef` and `documents` on every api-update for consistency; legacy `bookmarks`/`collection` optional). `apiUrl` = clone's `https://<repo>.<host>/api`.
- **REQ-WH-009 (P0)** Test trigger endpoint/button sending the `test-trigger` payload.
- **REQ-WH-010 (P0)** Delivery semantics: `Content-Type: application/json` POST; success only on HTTP 200 (exact, per docs); retry every 10 minutes up to 5 times; auto-disable after 5 consecutive failures; notify admins [INFERENCE].
- **REQ-WH-011 (P1)** Delivery log retained 30 days, per webhook and global, viewable in UI.
- **REQ-WH-012 (P2)** Optional HMAC signature header as a clone extension (not in Prismic; body `secret` remains for compatibility).

---

## 13. Environments

### What
Paid add-on (Platinum/Enterprise): clone a repository into a separate repository for model changes (`pages/environments.md`).

### Contract
- Created by owner/admin in Settings → Environments with **Name** (determines URL/domain, e.g. `example-prismic-repo-staging`) and a base environment to clone.
- Cloned: content models (page types, slices, custom types), pages, media files. Not cloned: users (permissions shared), integration catalogs (shared), webhooks.
- Asynchronous sync; accessible once synced. **Resync** overwrites all environment content and models from the base.
- Each environment is a full repository domain with its own APIs; client switches by repository name (env var `NEXT_PUBLIC_PRISMIC_ENVIRONMENT` / `NUXT_PUBLIC_PRISMIC_ENVIRONMENT` / `PUBLIC_PRISMIC_ENVIRONMENT`, written to `.env.local` by `prismic env set`).
- CLI: `prismic env list | set <domain> | active | unset`; `--repo <domain>` targets one command; `pull`/`push` act on the active environment.
- Prismic MCP has a per-environment activation setting; new environments inherit "off" from production and take minutes to get ready (`pages/mcp.md § Activate Prismic MCP`).
- Guidance: not for staging content; renaming API ids = remove + add (content loss).

### Requirements
- **REQ-ENV-001 (P1)** Environment = child repository linked to a parent with its own domain `<parent>-<slug>`; listed via an API consumed by `prismic env list`.
- **REQ-ENV-002 (P1)** Clone job copying models, all document versions (published/drafts [INFERENCE]), and media (new asset ids or shared storage), excluding webhooks; users/roles and integration catalogs are shared by reference.
- **REQ-ENV-003 (P1)** Resync job overwriting environment models and content from the base; status/progress visible.
- **REQ-ENV-004 (P1)** Admin/owner-only management; feature flag per plan.
- **REQ-ENV-005 (P2)** Per-environment MCP activation inheriting production's state.

---

## 14. Prismic CLI (`npx prismic`)

### What
Command-line tool for repositories, settings, tokens, models and docs (`pages/cli.md`). It is a client of Prismic's (mostly undocumented) management APIs plus the Types API.

### Contract
- Auth: `prismic login` (browser login), `logout`, `whoami`; non-interactive `PRISMIC_TOKEN=<write token>`; settings-modifying commands refuse write tokens.
- Commands and every subcommand/flag seen across the docs mirror:

| Command | Subcommands / flags seen | Source |
|---|---|---|
| `docs` | `list`, `view <slug>` (e.g. `nextjs`, `slices`, `migration`) | `pages/ai.md`, `pages/migration.md` |
| `repo` | `view`, `set-api-access private` (create also) | `pages/cli.md`, `pages/fetch-content.md` |
| `locale` | `list`, `add fr-fr [--name]`, `remove fr-fr` | grep across pages |
| `preview` | `add <url> [--name]`, `remove`, `set-simulator <url>` | `pages/previews.md`, `pages/nextjs.md` |
| `token` | `create`, `create --write`, `create --allow-releases` | `pages/api-authentication.md`, `pages/with-lokalise.md` |
| `webhook` | `create <url> [--name] [--secret] [--trigger ...]` | `pages/webhooks.md`, `pages/with-lokalise.md` |
| `env` | `list`, `set <domain>`, `active`, `unset` | `pages/environments.md` |
| `init` | `--repo <name>` (installs packages, client, preview routes; enables Type Builder on Legacy repos) | `pages/cli.md` |
| `pull` / `push` | models Prismic ↔ local (`customtypes/`, slices), generates TS types and component stubs | `pages/cli.md` |
| `gen` | `gen setup` (client file, simulator route, preview/revalidate routes) | `pages/nextjs.md` |
| `type` | `create "<Label>" [--format page] [--single]` (adds default route to `prismic.config.json`) | `pages/content-modeling.md` |
| `slice` | `create`, `add-variation`, `edit-variation`, `connect <slice> --to <type>`, `list --legacy`, `upgrade-legacy <slice> --from <type>` | grep across pages |
| `field` | `add <kind> <id> --to-type <t> | --to-slice <s>` (kinds: text, rich-text, select, number, timestamp, table, link, content-relationship, ...; `--custom-type`, `--field`, `--tag`) | `pages/fields/content-relationship.md` |
- Project config `prismic.config.json` `{repositoryName, routes[]}` (`pages/routes.md`).
- Agent skill `npx skills add --global --yes prismicio/skills`.

### Requirements
- **REQ-DEV-001 (P0)** Management API (user session or write token per REQ-WAPI-003) covering: repository create/view/api-access; locales list/add/remove (+ master); preview URLs & simulator URL; access/write token create/list/revoke with scopes; webhooks CRUD; environments list. Shape to be derived from the CLI package (not in docs).
- **REQ-DEV-002 (P0)** Types API compatibility (§7) so `pull`/`push` work against the clone via an endpoint override.
- **REQ-DEV-003 (P1)** Either fork the CLI with configurable hosts or provide a compatible CLI (`prismic` binary) with the same commands/flags; support `PRISMIC_TOKEN`.
- **REQ-DEV-004 (P1)** Browser-based CLI login flow (device/redirect) issuing a user token.
- **REQ-DEV-005 (P2)** `docs list/view` backed by a markdown docs index the clone hosts.

---

## 15. Prismic MCP server

### What
Remote MCP server letting AI assistants read and write content (`pages/mcp.md`).

### Contract
- URL `https://mcp.prismic.io/mcp`, HTTP transport (`claude mcp add --transport http ...`, `codex mcp add prismic --url ...`).
- Auth: OAuth sign-in with the Prismic account (Auth0 tenant `prismic-auth.eu.auth0.com`; logout `https://prismic-auth.eu.auth0.com/v2/logout`), access limited to the user's repositories; or `Authorization: Bearer <write token>` for non-interactive use. Vercel Connect registers an OAuth client (dynamic client registration [INFERENCE]); sign-ins expire after 90 days (`pages/ai.md § Use the MCP server in your app`).
- Per-repository activation (on by default for new repos; admin/owner only; "prepare your repository so the MCP server can search" = indexing, minutes or longer); deactivation is immediate; reactivation re-indexes from scratch. Error states "not activated" / "activating".
- Tools:

| Group | Tool | Behaviour |
|---|---|---|
| Discovery | `list_repositories` | repos the user can access |
| | `list_custom_types` | id, label, format |
| | `list_shared_slices` | with variation names |
| | `list_locales` | |
| | `list_releases` | newest first |
| | `list_document_versions` | drafts, published, archived, release versions |
| Read | `search_documents` | keywords + filters (custom type, locale, status, tags); metadata only |
| | `search_assets` | keyword over filename, alt, notes, credits; previews |
| | `get_document` | metadata + full content; specific version or release |
| | `get_custom_type` | full model + empty content template |
| | `get_shared_slice` | model + empty variation bodies |
| Write | `create_release` | empty release, returns id |
| | `create_document` | in a release; missing fields filled with model defaults |
| | `update_document` | full content into a release, branched from a base version |
| | `upload_asset` | fetch from URL, upload, return CDN URL |
| | `publish_release` | requires Publisher (Manager) role; irreversible; migration releases cannot be published via MCP |
- All writes go to releases; no unpublish/undo.

### Requirements
- **REQ-DEV-006 (P1)** Streamable-HTTP MCP endpoint `/mcp` exposing the 16 tools with the semantics above.
- **REQ-DEV-007 (P1)** OAuth 2.1 authorization server metadata + dynamic client registration for MCP clients, plus Bearer write-token auth.
- **REQ-DEV-008 (P1)** Role checks (Publisher for `publish_release`) and per-space permissions (`pages/releases.md § Publish across multiple spaces`).
- **REQ-DEV-009 (P1)** Per-repo MCP activation toggle and search index build (keyword search over documents and assets).
- **REQ-DEV-010 (P2)** Document version history API (`list_document_versions`) shared with the editor.

---

## 16. AI tooling

### What
Agent skill + CLI for building, MCP for content (`pages/ai.md`). Migration with AI (`pages/migration.md`): export → model via CLI (routes matching old URLs) → import via MCP into releases (≤1,000 pages each), idempotent reruns, assets uploaded once.

### Requirements
- **REQ-DEV-011 (P2)** Publish an agent skill pointing to the clone's CLI/MCP/docs.
- **REQ-DEV-012 (P2)** MCP writes idempotent by (type, uid, lang) to support rerunnable imports [INFERENCE from "Reruns safely, without duplicating content"].

---

## 17. Discrepancy register

| # | Topic | Statement A | Statement B / evidence |
|---|---|---|---|
| D1 | Preview cookie name | `preview.prismic.io` (`pages/previews.md`) | `io.prismic.preview` (`ev/toolbar.prismic.js`) |
| D2 | `scheduledAt` type | "string" (`pages/repository-api-technical-reference.md` table) | number ms (same page example, webhooks) |
| D3 | Release ref separator | "separated by a hash symbol" | `~` in all examples |
| D4 | `uid` presence | "Only present if the page type has a UID field" (`pages/fetch-content.md`) | `"uid": null` present (`ev/search.homepage.json`) |
| D5 | Languages | `{id,name}` (docs) | `{id,name,is_master}` (`ev/api-root.prismic-main.json`) |
| D6 | `brokenRoute` | documented param | not in `forms.everything` |
| D7 | Asset API rate | 1 req/s (docs) | `x-ratelimit-limit-second: 10` (`ev/protected-endpoints.txt`) |
| D8 | Release size | 200 pages (`pages/releases.md`) | 1,000 pages (migration release, MCP) |
| D9 | Tags API scope | published + releases | also drafts (same page) |
| D10 | Webhook event count | "Seven events" | 6 events + test trigger; create example invalid JSON, inconsistent keys |
| D11 | `next_page` | — | drops `routes` param (`ev/search.routes.json`) |
| D12 | Docs URL typo | `/api/v2/search/documents` in JS example (`pages/content-api.md § Encoding`) | real path `/api/v2/documents/search` |
| D13 | Integration `fetchLinks` / `oauth_initate` / `lastPublication_before` | typos in docs | correct names `oauth_initiate`, `lastPublicationDate_before` |
| D14 | Migration example locale `en-US` | Content API locales lowercase (`en-us`) | case-insensitivity of `lang` [INFERENCE] |

---

## 18. Open questions / ambiguities

1. Default result order of `/documents/search` without `orderings` (not chronological in evidence). Need a capture comparing with document creation order.
2. Exact HTTP status codes for `api_validation_error` (missing ref), expired refs (410?), expired preview tokens, malformed `routes`, URL > 2048 chars.
3. Route precedence when several routes match one type (array order vs. specificity of `uid`/`lang`); behaviour of a required `:uid`/resolver keyword with no value; whether `alternate_languages` entries get `url`.
4. `after` + `page` interplay: evidence shows `next_page` keeping both, and `total_results_size` unchanged; is `page=2&after=X` offsetting twice?
5. `at`/`not` with tag arrays: confirm all-of/none-of vs any-of semantics; `not` on CR and missing values.
6. `similar` algorithm details and whether the source doc is excluded; `similar` across types.
7. GraphQL: `similar` argument field names, naming of shared-slice unions/variations (docs only show legacy `{Type}Body{Slice}`), `Authorization` header scheme (`Token` vs `Bearer`), POST support, `_FileLink` union.
8. Migration API: full POST/PUT response bodies, error HTTP codes, the publish-migration-release HTTP route, and whether PUT works on published docs outside the migration release.
9. Asset API: list envelope, `assetType` enum, tag endpoints, max upload size, accepted mime types.
10. Webhook delivery headers (Content-Type, User-Agent), timeout, whether redirects are followed, and exact trigger identifiers beyond the three documented.
11. Preview session API: how the editor obtains the preview ref, ref format of preview tokens (URL-like tokens in old SDKs), session lifetime, share-link URL format.
12. Live-preview (`/slice-simulator`) postMessage protocol and URL-param compression format (in SDK REA scope).
13. Management/settings APIs used by the CLI (`user-service.prismic.io`, `auth.prismic.io`) are entirely undocumented; must be reverse-engineered from the `prismic` CLI package.
14. Release-ref visibility: does a master-only access token get 404 or 401 for a release ref?
15. Whether `lang` matching is case-insensitive (`en-US` in Migration example vs `en-us` elsewhere).
16. `integrationFieldsRef` format and presence in `/api/v2` when no catalog exists (`null` vs absent).
17. Tags API 404 for brand-new repositories: still current behaviour?
