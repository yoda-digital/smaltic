# Prismic wire contracts (implementation spec)

Derived from the official SDK sources (read-only, never executed) and live captures.

Package versions read:

| Package | Version |
|---|---|
| `@prismicio/client` | 7.22.3 |
| `@prismicio/custom-types-client` | 2.1.0 |
| `@prismicio/types-internal` | 4.8.0 |
| `@prismicio/migrate` | 0.0.2 |
| `imgix-url-builder` (dep of client) | as installed |

Citation conventions:

- `client/src/X.ts:N` means `<SDK>/@prismicio/client/src/X.ts` line N, where
  `<SDK>` = `/tmp/claude-1000/-home-ubuntu-gits-prismic-oss/d05bf397-7d0d-4e4b-ba82-66303d54a29a/scratchpad/sdk/node_modules`.
  `dist/` was spot-checked and matches `src/` (e.g. `client/dist/buildQueryURL.js:7` `x-c`, `client/dist/WriteClient.js:21-22` default hosts).
- `cti/src/...` = `@prismicio/custom-types-client/src/...`; `ti/src/...` = `@prismicio/types-internal/src/...`;
  `migrate/src/...` = `@prismicio/migrate/src/...`; `imgix/src/...` = `imgix-url-builder/src/...`.
- `ev/X` = `/home/ubuntu/gits/prismic-oss/docs/research/evidence/X` (live production captures, 2026-10-19).
- **[INFERENCE]** marks conclusions not literally stated in code or evidence.

---

## 0. Executive summary of compatibility risks

1. **Repository name is inferred from the endpoint hostname only for Prismic hosts.**
   `getRepositoryName` accepts hostnames ending in `prismic.io`, `wroom.io`, `dev-tools-wroom.com`,
   `marketing-tools-wroom.com`, `platform-wroom.com`, `wroom.test` and returns the first DNS label
   (`client/src/getRepositoryName.ts:11-32`). For any other host the `Client` constructor only
   `console.warn`s (`client/src/Client.ts:236-244`) but the `repositoryName` getter then **throws**
   (`client/src/Client.ts:321-331`). The `WriteClient` sends `repository: this.repositoryName` on every
   write (`client/src/WriteClient.ts:811`) so a write client created from a custom URL is unusable.
   The supported pattern is `createClient("my-repo", { documentAPIEndpoint: "https://cms.example.com/api/v2" })`
   (`client/src/Client.ts:245-249`). Repository names must match `/^[a-zA-Z0-9][-a-zA-Z0-9]{2,}[a-zA-Z0-9]$/`
   (min 4 chars) (`client/src/isRepositoryName.ts:8-10`).
2. The Content API has no other hostname validation. Any valid URL is accepted as endpoint
   (`client/src/isRepositoryEndpoint.ts:9-17`). Only in `NODE_ENV=development` does the client throw for
   `*.prismic.io` URLs whose path is not `/api/v2` (`client/src/Client.ts:282-291`) and warn for non-CDN
   `*.prismic.io` (`:292-300`); neither triggers for a custom domain.
3. **Hard-coded Prismic hosts** that need explicit overrides by users: `getRepositoryEndpoint`
   (`https://<repo>.cdn.prismic.io/api/v2`, `client/src/getRepositoryEndpoint.ts:18-30`),
   `getGraphQLEndpoint` (`https://<repo>.cdn.prismic.io/graphql`, `client/src/getGraphQLEndpoint.ts:11-23`),
   `getToolbarSrc` (`https://static.cdn.prismic.io/prismic.js?new=true&repo=<repo>`,
   `client/src/getToolbarSrc.ts:35-47`), WriteClient `https://asset-api.prismic.io/` and
   `https://migration.prismic.io/` (`client/src/WriteClient.ts:167-168`, overridable `:192-198`),
   custom types `https://customtypes.prismic.io` (`cti/src/client.ts:21`, overridable `:154`).
4. **`getTags()` follows `forms.tags.action` as an absolute URL** from the `/api/v2` response
   (`client/src/Client.ts:987-1003`): the clone must emit its own host there.
5. **Preview cookie is passed raw as `ref`** (`client/src/lib/getPreviewCookie.ts:13-29`,
   `client/src/Client.ts:1260-1271`). The current toolbar writes a JSON cookie
   (`ev/toolbar.prismic.js`, see 1.11). The server must accept a ref that is a plain ref id, a preview
   token, or a (partially URL-encoded) JSON cookie blob.
6. **Ref-retry relies on error message text**: on 404 `api_notfound_error` / 410 the client parses
   `/master ref is: (?<ref>.*)$/i` from `message` and retries up to 3 attempts
   (`client/src/Client.ts:1300-1324`, `:30`).
7. **Writes are serialised client-side**: every request carrying a body is queued per hostname with a
   1500 ms gap between completions (`client/src/lib/request.ts:126-132`, `client/src/lib/pLimit.ts:31-99`).
   429 handling: `Number(response.headers.get("retry-after"))`; an absent header gives `Number(null) === 0`
   so the retry happens **immediately**, the 1500 ms default is only used for non-numeric values
   (`client/src/lib/request.ts:155-162`). The clone should always send `Retry-After` on 429.
8. **`x-api-key` is not used anywhere** in client 7.22.3 (grep of `src` and `dist/*.d.ts` returned nothing).
   Auth to Asset/Migration APIs is `authorization: Bearer <writeToken>` + `repository: <name>`.
9. `dangerouslyGetAll` paginates by **`page` number from the response body**, not by following
   `next_page` (`client/src/Client.ts:457-462`); `next_page` only needs to be non-null when more pages exist.
10. Migration master locale = **`repository.languages[0].id`**, not the `is_master` entry
    (`client/src/WriteClient.ts:372-373`): put the master language first.

---
## 1. `@prismicio/client` Content API contract

### 1.1 Endpoint construction

| Input to `createClient(nameOrEndpoint, config)` | `documentAPIEndpoint` | `repositoryName` | Source |
|---|---|---|---|
| repo name `"my-repo"` | `config.documentAPIEndpoint` or `https://my-repo.cdn.prismic.io/api/v2` | `"my-repo"` | `client/src/Client.ts:245-249` |
| full URL | `config.documentAPIEndpoint` or the URL | first hostname label if host is a Prismic host, else unset + warning | `client/src/Client.ts:236-244` |

- `createClient` = `new Client(...)` (`client/src/createClient.ts:33-36`).
- `getRepositoryEndpoint(name)` throws `PrismicError` on invalid names (`client/src/getRepositoryEndpoint.ts:18-30`).
- Invalid URL in `documentAPIEndpoint` -> throws (`client/src/Client.ts:266-272`); both URL arg and different `documentAPIEndpoint` -> warn only (`:273-281`).
- A `fetch` implementation is mandatory (`client/src/Client.ts:251-264`).
- `config.ref` (string or function) is applied via `queryContentFromRef` (`client/src/Client.ts:311-313`).
- Search URL = `new URL("documents/search", endpoint + "/")` (trailing slash added if missing) (`client/src/buildQueryURL.ts:291-294`). So endpoint `https://cms.example.com/api/v2` -> `https://cms.example.com/api/v2/documents/search`. The endpoint path is free-form.

### 1.2 HTTP layer common to all client requests

`client/src/lib/request.ts`:

- Requests **with a body** are throttled per `url.hostname` through a single-concurrency queue with `interval: 1500` ms between the end of one job and the start of the next (`:8`, `:126-132`; queue semantics `client/src/lib/pLimit.ts:31-99`).
- Requests **without a body** are de-duplicated by full URL string + `AbortSignal` (concurrent identical GETs share one response, body buffered) (`:134-150`, `:87-106`).
- Status 429 -> sleep `retry-after` seconds (or 1500 ms if the header is non-numeric; 0 ms if absent, see summary item 7) and retry indefinitely (`:155-162`).
- `Client.#request` merges `config.fetchOptions`, per-call `fetchOptions`, headers from both, and signal (`client/src/Client.ts:1368-1382`). The Content API client sends no auth header; the access token travels as the `access_token` query parameter.

### 1.3 Requests made by `Client`

| Method | HTTP | URL | Notes | Source |
|---|---|---|---|---|
| `getRepository` | GET | `documentAPIEndpoint` (+ `?access_token=` if token) | cached 5000 ms in-instance; 404 -> `RepositoryNotFoundError` (body not read) | `client/src/Client.ts:802-834`, TTL `:28` |
| `get`, `getFirst`, `getBy*`, `getAll*`, `dangerouslyGetAll` | GET | `<endpoint>/documents/search?...` | see 1.5 | `client/src/Client.ts:1286-1328` |
| `getTags` | GET | `repository.forms.tags.action` (+ `?access_token=`) | expects JSON `string[]`; on missing form or non-2xx falls back to `repository.tags` | `client/src/Client.ts:987-1003` |
| `graphQLFetch` | as given by caller (normally GET) | caller-supplied URL | see 1.12 | `client/src/Client.ts:1204-1241` |
| `resolvePreviewURL` | GET | search, via `getByID` | see 1.11 | `client/src/Client.ts:1064-1117` |

Before **every** search the client needs the repository document (for the master ref unless a ref is supplied, and for `integrationFieldsRef` unless supplied) (`client/src/Client.ts:1017-1049`, `:1260-1280`). So `/api/v2` is on the hot path; it is cached for 5 s per client instance.

### 1.4 Repository (`GET /api/v2`) response shape

Type `Repository` (`client/src/types/api/repository.ts:9-60`):

```jsonc
{
  "refs": [Ref],                         // required; client reads it in getRefs
  "integrationFieldsRef": "string|null",
  "languages": [{ "id": "en-us", "name": "English - United States", "is_master": true }], // :63-72
  "types": { "<customTypeId>": "<label>" },
  "tags": ["string"],                    // deprecated fallback for getTags
  "forms": { "<name>": Form },           // :80-99 Form = {method:"GET",enctype,action,name?,rel?,fields:{<k>:{type:"String"|"Integer",multiple:boolean,default?:string}}}
  "oauth_initiate": "string",
  "oauth_token": "string",
  "version": "string",
  "license": "string",
  "experiments": {},                     // deprecated, live: {"draft":[],"running":[]}
  "bookmarks": {}                        // deprecated
}
```

`Ref` (`client/src/types/api/ref.ts:6-26`): `{ id: string, ref: string, label: string, isMasterRef: boolean, scheduledAt?: string }`.

Live sample (`ev/api-root.prismic-main.json`): `refs:[{"id":"master","ref":"atX5SBEAACkAzXoH","label":"Master","isMasterRef":true}]`, `forms.everything` (method GET, enctype `application/x-www-form-urlencoded`, action `https://prismic-main.cdn.prismic.io/api/v2/documents/search`, fields `ref`, `q` (multiple:true), `lang`, `page` (Integer, default "1"), `pageSize` (Integer, default "20"), `after`, `fetch`, `fetchLinks`, `graphQuery`, `orderings`, `referer`, `routes`, `access_token`, `integrationFieldsRef`), `forms.tags` (action `https://prismic-main.cdn.prismic.io/api/tags`, field `access_token`), `oauth_initiate: https://<repo>.prismic.io/auth`, `oauth_token: https://<repo>.prismic.io/auth/token`, `version:"482083b"`, `license:"All Rights Reserved"`.
Response headers (`ev/api-root.headers.txt`): `content-type: application/json`, `x-prismic-version: 6`, `cache-control: max-age=0, no-store`, `access-control-allow-origin: *`.
Private repo without/with bad token: HTTP 401 `{"error":"Invalid access token"}` (`ev/api-root.wroom-401.json`).

Ref selection logic:

- **Master ref**: first `refs[]` with `isMasterRef === true`; none -> `PrismicError("Master ref could not be found.")` (`client/src/Client.ts:904-913`).
- **Releases** = all refs with `isMasterRef === false` (`:925-929`); `getReleaseByID` matches `id`, `getReleaseByLabel` matches `label` (`:941-975`); `getRefByID`/`getRefByLabel` search all refs (`:862-892`). `queryContentFromReleaseByID/Label` resolve to `release.ref` lazily per query (`:1143-1165`); `queryLatestContent` clears it (`:1129-1131`).
- **Resolution order per query** (`#getResolvedRef`, `:1260-1280`): (1) if auto-previews enabled (default `true`, `:213`) and a cookie `io.prismic.preview` exists (from `enableAutoPreviewsFromReq(req)` headers - Web `headers.get("cookie")` or Express `headers.cookie` - else `globalThis.document.cookie`), use the raw cookie value; (2) the configured ref / release; (3) master ref. An explicit `params.ref` beats all (`:1022-1028`).

### 1.5 Search request (`GET <endpoint>/documents/search`)

Built by `buildQueryURL` (`client/src/buildQueryURL.ts:288-363`) with args assembled in `Client.buildQueryURL` (`client/src/Client.ts:1040-1048`): `{...defaultParams, ...params, ref, integrationFieldsRef, routes, brokenRoute, accessToken}`; `signal`/`fetchOptions` are stripped (`:1017-1021`).

Query parameter emission order and format:

| Param | Emitted as | Source |
|---|---|---|
| `filters` (each element) | one `q` **per filter**, value `"[" + filter + "]"`; since helpers already return `[pred(...)]`, the wire value is `[[pred(...)]]` | `buildQueryURL.ts:296-310` |
| `predicates` (deprecated) | same, appended after filters | `:313-317` |
| `accessToken` | renamed `access_token` | `:226-228`, `:322` |
| `orderings` | `[f1 desc,f2]` - objects rendered `field` or `field desc`; joined with `,` (no space); string orderings passed through verbatim (so a legacy string `"[my.a desc]"` becomes `[[my.a desc]]`) | `:242-262`, `:326-344` |
| `routes` | if object/array: `JSON.stringify(array)`; if string: verbatim | `:345-349` |
| any array value (`fetch`, `fetchLinks`, ...) | joined with `,` | `:351-353` |
| everything else (`ref`, `integrationFieldsRef`, `lang`, `page`, `pageSize`, `after`, `graphQuery`, `brokenRoute`, unknown keys) | verbatim name; `undefined`/`null` omitted | `:321-354` |
| `x-c` | always `js-<client version>` e.g. `js-7.22.3` | `:8`, `:356` |
| `x-d` | `1` only when `process.env.NODE_ENV === "development"` | `:5`, `:358-360` |

Server-side parsing requirements derived from the above and evidence:

- Multiple `q` parameters must be ANDed. Each `q` is `[` + one or more `[predicate]` + `]`; whitespace after commas varies (SDK emits `", "`, live examples use `","`) (`ev/search.*.json` `next_page`). Be lenient with a single bracket level (`q=[at(...)]` from raw strings).
- Document `href` uses the older binding form `[[:d = at(document.id, "<id>") ]]` (`ev/search.homepage.json`).
- `ref` is required; missing -> `{"type":"api_validation_error","message":"Please specify ref"}` (`ev/search.no-ref.json`).
- `pageSize` > 100 is clamped to 100 (`ev/search.pagesize-101.json`: `results_per_page:100`, `next_page` carries `pageSize=100`). Default 20 (`forms.everything.fields.pageSize.default`).
- `lang=*` returns all languages (`ev/search.lang-all.json`).
- `after=<docId>` returns results after that document; response still reports `page:1` and `next_page` contains `page=2&after=...` (`ev/search.after.json`).
- `next_page` echoes `ref`, `q`, `orderings`, `page`, `pageSize`, `fetch`, `fetchLinks`, `graphQuery`, `lang`, `after` but **not** `routes` (`ev/search.routes.json`, `ev/search.ordering.json`).

### 1.6 Search response (`Query`)

`client/src/types/api/query.ts:10-34`:

```jsonc
{
  "page": 1, "results_per_page": 20, "results_size": 20,
  "total_results_size": 258, "total_pages": 13,
  "next_page": "https://.../documents/search?...&page=2" | null,
  "prev_page": null | "...",
  "results": [PrismicDocument],
  "version": "5621b3e", "license": "All Rights Reserved"   // present live, not in SDK type
}
```

Document envelope (`client/src/types/value/document.ts:7-70`; key order from `ev/search.blog.page1.json`):
`id`, `uid` (string|null), `url` (string|null; filled only with `routes` or legacy link resolver), `type`, `href` (absolute URL - **must parse with `new URL()`**, `client/src/lib/isValue.ts:150-167`), `tags` (string[]), `first_publication_date`, `last_publication_date` (format `YYYY-MM-DDTHH:mm:ss+0000`, 24 chars - `asDate` depends on length 24, `client/src/helpers/asDate.ts:24-51`), `slugs` (string[]), `linked_documents` ([]), `lang`, `alternate_languages` (`[{id, uid?, type, lang}]`, `document.ts:7-12`), `data`.

### 1.7 Error mapping (Content API)

`#throwContentAPIError` (`client/src/Client.ts:1331-1365`) - body parsed as JSON except default:

| Status | Body `type` | Thrown | Message source |
|---|---|---|---|
| 400 | any (live: `api_parsing_error`; SDK type says `parsing-error`, `client/src/errors.ts:34-45`) | `ParsingError` | `json.message` |
| 401 | any (live `{"error":"Invalid access token"}`) | `ForbiddenError` | `json.message` (undefined -> default text) |
| 404 | `api_notfound_error` | `RefNotFoundError` (extends ForbiddenError) | `json.message` |
| 404 | `api_security_error` and message `/preview token.*expired/i` | `PreviewTokenExpiredError` | |
| 404 | other | `NotFoundError` | |
| 410 | any (`api_validation_error` per type, `errors.ts:49-60`) | `RefExpiredError` (extends ForbiddenError) | |
| other (incl. 403, 500) | - | `PrismicError(undefined, url, await response.text())` | |

- `getRepository` 404 -> `RepositoryNotFoundError` regardless of body (`client/src/Client.ts:825-831`).
- `getFirst`/`getByUID`/`getByID`/`getSingle` with zero results -> `NotFoundError("No documents were returned")` (`:424-428`).
- Ref retry: for `RefNotFoundError`/`RefExpiredError`, if attempt < 3 and message matches `/master ref is: (?<ref>.*)$/i`, clear repository cache (when no explicit ref) and retry with that ref (`:1300-1324`). Live 404 body: `{"type":"api_notfound_error","message":"Ref not found. Ensure you have the correct ref and try again. Master ref is: atX5SBEAACkAzXoH"}` (`ev/search.bad-ref.json`).
- Parse error live body (`ev/search.bad-predicate.json`): `{"type":"api_parsing_error","message":"unrecognized attribute 'foo' on line:1 col:3 in query '[[foo(document.type,\"blog\")]]'\n...","pos":{"line":1,"column":3,"id":0,"location":"query"}}`.
- Error classes: `client/src/errors.ts:1-84`.

### 1.8 Filter (predicate) syntax - exact strings

Formatting (`client/src/filter.ts:7-42`): `[${name}(${path}${path && args.length ? ", " : ""}${args.join(", ")})]`.
Values: string -> `"..."` with `"` escaped as `\"`; `Date` -> epoch milliseconds; number/boolean -> `${v}`; array -> `[a, b]` (recursive, `", "` separator). The path is never quoted.

| Helper | Line | Example call | Filter string (wire `q` adds an outer `[...]`) |
|---|---|---|---|
| `at` | 85 | `at("document.type","page")` | `[at(document.type, "page")]` |
| `at` (tags array) | 85 | `at("document.tags",["a","b"])` | `[at(document.tags, ["a", "b"])]` |
| `not` | 93 | `not("my.p.flag", true)` | `[not(my.p.flag, true)]` |
| `any` | 101 | `any("document.tags",["a"])` | `[any(document.tags, ["a"])]` |
| `in` | 109 | `in("document.id",["X","Y"])` | `[in(document.id, ["X", "Y"])]` |
| `fulltext` | 121 | `fulltext("document","headless")` | `[fulltext(document, "headless")]` |
| `has` | 129 | `has("my.p.title")` | `[has(my.p.title)]` |
| `missing` | 137 | `missing("my.p.title")` | `[missing(my.p.title)]` |
| `similar` | 146 | `similar("ID", 10)` | `[similar("ID", 10)]` |
| `geopointNear` | 156-157 | `(path, 48.85, 2.35, 10)` | `[geopoint.near(path, 48.85, 2.35, 10)]` |
| `numberLessThan` | 165 | `(path, 10)` | `[number.lt(path, 10)]` |
| `numberGreaterThan` | 173 | `(path, 10)` | `[number.gt(path, 10)]` |
| `numberInRange` | 181 | `(path, 1, 5)` | `[number.inRange(path, 1, 5)]` |
| `dateAfter` | 189 | `(path, "2024-01-01")` | `[date.after(path, "2024-01-01")]` (Date/number -> epoch ms) |
| `dateBefore` | 197 | | `[date.before(path, X)]` |
| `dateBetween` | 205-208 | | `[date.between(path, A, B)]` |
| `dateDayOfMonth` | 216 | `(path, 3)` | `[date.day-of-month(path, 3)]` |
| `dateDayOfMonthAfter` | 224 | | `[date.day-of-month-after(path, N)]` |
| `dateDayOfMonthBefore` | 232 | | `[date.day-of-month-before(path, N)]` |
| `dateDayOfWeek` | 240 | `(path, "monday")` / `(path, 1)` | `[date.day-of-week(path, "monday")]` |
| `dateDayOfWeekAfter` | 248 | | `[date.day-of-week-after(path, X)]` |
| `dateDayOfWeekBefore` | 256 | | `[date.day-of-week-before(path, X)]` |
| `dateMonth` | 264 | `(path, "january")` / `(path, 1)` | `[date.month(path, "january")]` |
| `dateMonthAfter` | 272 | | `[date.month-after(path, X)]` |
| `dateMonthBefore` | 280 | | `[date.month-before(path, X)]` |
| `dateYear` | 288 | | `[date.year(path, 2024)]` |
| `dateHour` | 296 | | `[date.hour(path, 12)]` |
| `dateHourAfter` | 304 | | `[date.hour-after(path, 12)]` |
| `dateHourBefore` | 312 | | `[date.hour-before(path, 12)]` |

Exported as `filter` and deprecated alias `predicate` (`client/src/index.ts:38-40`). Paths used by the client itself: `document.id`, `document.type`, `document.tags`, `my.<type>.uid` (`client/src/Client.ts:492-790`). Live working examples: `[[date.after(document.first_publication_date,"2024-01-01")]]` (`ev/search.number-date.json`), `[[similar("ZYCIiBEAAM8Dec8o",10)]]` (`ev/search.similar.json`), `[[fulltext(document,"headless")]]` (`ev/search.fulltext.json`).

### 1.9 Query helpers behaviour

| Method | Behaviour | Source |
|---|---|---|
| `get(params)` | one search, returns body verbatim | `Client.ts:399-405` |
| `getFirst(params)` | adds `pageSize=1` unless `page` or `pageSize` given; first result or `NotFoundError` | `:417-429` |
| `getByID(id)` | `getFirst` + `at(document.id, id)` | `:488-493` |
| `getByIDs` / `getAllByIDs` | `in(document.id, ids)` | `:505-530` |
| `getByUID(type, uid)` | `getFirst` + `at(document.type, type)` + `at(my.<type>.uid, uid)` | `:542-557` |
| `getByUIDs` / `getAllByUIDs` | `at(document.type)` + `in(my.<type>.uid, uids)` | `:569-612` |
| `getSingle(type)` | `getFirst` + `at(document.type, type)` | `:624-634` |
| `getByType` / `getAllByType` | `at(document.type, type)` | `:646-679` |
| `getByTag` / `getAllByTag` | `any(document.tags, [tag])` | `:691-716` |
| `getByEveryTag` / `getAllByEveryTag` | `at(document.tags, tags)` | `:728-753` |
| `getBySomeTags` / `getAllBySomeTags` | `any(document.tags, tags)` | `:765-790` |
| `dangerouslyGetAll(params)` | `pageSize = min(limit, params.pageSize \|\| defaultParams.pageSize \|\| 100)`; loop while `next_page` truthy and fewer than `limit`, requesting `page = previous.page + 1`; sleeps 500 ms between pages unless response `x-cache` starts with `Hit` or `Date` header is >5 s older than request time | `:442-476`, constants `:27,29` |

Extra filters are appended to user `filters` (`appendFilters`, `:1386-1391`).

### 1.10 Integration fields

`integrationFieldsRef` from the repository (or param) is sent as query param `integrationFieldsRef` on every search (`client/src/Client.ts:1029-1044`) and as header `prismic-integration-field-ref` on GraphQL (`:1220-1222`). Catalog API payload types: `client/src/types/api/integration.ts:9-28` (`{results_size, results:[{id,title,description,image_url?,last_update?,blob}]}`).

### 1.11 Previews

- Cookie name: `io.prismic.preview` (`client/src/cookie.ts:2`).
- Reading (`client/src/lib/getPreviewCookie.ts:3-29`): split cookie jar on `"; "`, split each on `=`, name compared after `%3B`->`;` and `%3D`->`=`; value = rest joined with `=`, with only `%3B` decoded to `;`. **The value is used verbatim as `ref`** (`client/src/Client.ts:1267-1270`), then URL-encoded again as a query parameter.
- Cookie formats written by the current toolbar (`ev/toolbar.prismic.js`, minified, functions `A`, `O`, `y`):
  - `json` codec (normal mode): `{"_tracker":"<random>"?, "<repositoryHost>":{"preview":"<ref>"}, ...}`; written with `encodeURIComponent` then selectively decoding `# $ & + / : < = > ? @ [ ] ^ \` { | }` - so `"` stays `%22` and `,` stays `%2C`. `path=/`, `SameSite`/`Secure` depending on protocol.
  - `plain` codec (embedded-poll mode): the ref string itself.
  - `repositoryHost` comes from the toolbar `repo` query param: if it contains a dot it is used as the host as-is (custom hosts supported), else `<repo>.prismic.io`; `.cdn.` is stripped. The toolbar loads `${proto}//${host}/prismic-toolbar/5e015029/iframe.html` (`https:` unless host ends with `.test`) and dispatches `prismicPreviewStart` / `prismicPreviewUpdate` / `prismicPreviewEnd`.
  - **[INFERENCE]** The server must therefore accept as `ref`: (a) a normal ref id, (b) a preview token, (c) a JSON cookie blob (after URL-decoding `%22`/`%2C`), extracting `[<this repo host>].preview`.
- `resolvePreviewURL({linkResolver?, defaultURL, previewToken?, documentID?})` (`client/src/Client.ts:1064-1117`): reads `documentId` and `token` from `location.search` in browsers, or from `req.query.documentId/token` (Express) or `new URL(req.url,"missing-host://").searchParams` (Web). If both present: `getByID(documentID, { ref: previewToken, lang: "*" })`, i.e. `GET .../documents/search?q=[[at(document.id, "<id>")]]&pageSize=1&ref=<token>&lang=*&...`, then `asLink(document, {linkResolver})` (uses `document.url`); falls back to `defaultURL`.
- Expired preview token: 404 `{"type":"api_security_error","message":"... preview token ... expired ..."}` -> `PreviewTokenExpiredError` (`client/src/Client.ts:1347-1350`).

### 1.12 GraphQL

`getGraphQLEndpoint(repo)` = `https://<repo>.cdn.prismic.io/graphql` (`client/src/getGraphQLEndpoint.ts:11-23`). `client.graphQLFetch(input, init)` (`client/src/Client.ts:1204-1241`), a drop-in `fetch` for GraphQL clients:

- Calls `getRepository` and resolves the ref (preview cookie > configured > master).
- Headers (lower-cased, caller headers override): `prismic-ref: <ref>`, `authorization: Token <accessToken>` (if any), `prismic-integration-field-ref: <integrationFieldsRef>` (if non-null).
- Minifies `query` search param with `/(\n| )*( |{|})(\n| )*/gm` -> captured bracket/space, then sets `ref=<ref>` query param ("only used to prevent caching").
- Uses `this.fetchFn` directly (no throttle/dedupe/429 retry).
- Live: `GET /graphql?query=...` with `Prismic-Ref`, response `{"data":{"allBlogs":{"totalCount":258,"edges":[{"node":{"_meta":{"uid","id","type","lang"}}}]}}}` (`ev/graphql.sample.json`, headers `ev/graphql.headers.txt`).

### 1.13 Link and image helpers (client-side, constrain server output)

- `asLink(field|document, {linkResolver})` (`client/src/helpers/asLink.ts:120-176`): documents converted via `documentToLinkField` (`client/src/helpers/documentToLinkField.ts:15-38`: `{link_type:"Document", id, uid, type, tags, lang, url, slug: slugs[0], data?}`). `Media`/`Web` -> `field.url`; `Document` -> linkResolver result if non-null, else `field.url`, else null; `Any` -> null.
- `asLinkAttrs` (`client/src/helpers/asLinkAttrs.ts:77-113`): `target` from field, `rel="noreferrer"` for external hrefs (`isInternalURL`: starts with `/` (not `//`) or `#`, `client/src/lib/isInternalURL.ts:8-13`).
- `asImageSrc(field, imgixParams)` (`client/src/helpers/asImageSrc.ts:27-36`) -> `buildURL(field.url, params)` (`imgix/src/buildURL.ts:57-82`): `new URL(url)` (**image URLs must be absolute**), camelCase keys -> kebab-case, arrays joined with `,`, `undefined` deletes the param, existing params (e.g. `auto=compress,format`, `rect`, `w`, `h`) are preserved/overwritten, `s` moved last.
- `asImageWidthSrcSet` (`client/src/helpers/asImageWidthSrcSet.ts:63-119`): default widths `[640, 828, 1200, 2048, 3840]` (`:8`); each entry `buildURL(url,{...params, w:undefined, h:undefined, height:undefined, width})` + ` <w>w` (`imgix/src/buildWidthSrcSet.ts:62-71`) - note it sets the `width` param, not `w`. `widths:"thumbnails"` uses every non-standard key of the image object as a thumbnail (`:72-84`) - **any extra key on an image object is treated as a thumbnail view**.
- `asImagePixelDensitySrcSet` (`client/src/helpers/asImagePixelDensitySrcSet.ts:57-76`): densities `[1,2,3]`, adds `dpr=N` + ` Nx` (`imgix/src/buildPixelDensitySrcSet.ts:61-70`).
- Image CDN must honour imgix params; live `images.prismic.io` is imgix (`auto=format` -> AVIF, `w/h/fit=crop`, `fm=webp&q=`, `rect=`, `blur=`, `ev/image-cdn-probe.txt`).
- `asDate` (`client/src/helpers/asDate.ts:24-51`): length 24 -> timestamp `YYYY-MM-DDTHH:mm:ss+HHMM` rewritten to `...ss.000+HH:MM`; otherwise `new Date("YYYY-MM-DD")`.

### 1.14 `isFilled` (defines empty vs filled)

`client/src/helpers/isFilled.ts`:

| Helper | Filled when | Line |
|---|---|---|
| `richText`, `title` | non-null and (single block with non-empty `text`) or length > 0 | 53-73 |
| `image`, `imageThumbnail` | non-null and truthy `url` | 81-95 |
| `link`, `linkToMedia`, `contentRelationship` | non-null and has key `id` or `url` | 103-132 |
| `date`, `timestamp`, `color`, `number`, `select`, `table`, `integration` | `!= null` | 140-238 |
| `keyText` | truthy (so `""` is empty) | 180-184 |
| `embed` | non-null and truthy `embed_url` | 202-206 |
| `geoPoint` | non-null and has `longitude` | 214-218 |
| `repeatable`, `group`, `sliceZone` | non-null, non-empty array | 253-282 |

---
## 2. Content API field value shapes (`document.data`)

Types: `client/src/types/value/*.ts`. Live confirmation: `ev/field-shapes.observed.md`, `ev/search.*.json`.

| Field (model `type`) | Filled | Empty (SDK type) | Empty (observed live) | Source |
|---|---|---|---|---|
| Rich text / Title (`StructuredText`) | array of blocks | `[]` | `[]` | `richText.ts:241-243`, `title.ts:16-30` |
| Image (`Image`) | see 2.2 | all keys optional/null | `{}` | `image.ts:9-74` |
| Link (`Link`, any) | see 2.3 | `{link_type:"Any"}` (+ `text`, `variant`) | `{"link_type":"Any"}` or `{"link_type":"Any","key":"<uuid>"}` | `link.ts:64-69` |
| Content relationship (`Link` select=document) | see 2.3 | `{link_type:"Any"}` | `{"link_type":"Document"}` | `contentRelationship.ts:24-26` |
| Link to media (`Link` select=media) | see 2.3 | `{link_type:"Any"}` | `{"link_type":"Media"}` | `linkToMedia.ts:15-17` |
| Repeatable link (`Link` repeat=true) | `[{...link, key:"<uuid>"}, ...]` | `[]` | `[]` | `types.ts:51-57` |
| Embed (`Embed`) | oEmbed + `embed_url`, `html` | `{}` | | `embed.ts:142-150` |
| GeoPoint (`GeoPoint`) | `{latitude, longitude}` | `{}` | | `geoPoint.ts:9-14` |
| Table (`Table`) | see 2.5 | `null` | | `table.ts:10-18` |
| Group (`Group`) | `[{field: value, ...}, ...]` | `[]` | `[]`; a single empty item may appear as `{}` | `group.ts:8-24` |
| Slice zone (`Slices`/`Choice`) | array of slices | `[]` | `[]` | `sliceZone.ts:12-15` |
| Integration (`IntegrationFields`) | arbitrary object (catalog `blob`) | `null` | | `integration.ts:10-20` |
| Boolean | `true`/`false` (never null) | - | `false` | `boolean.ts:6` |
| Color | `"#rrggbb"` | `null` | `null` | `color.ts:9-11` |
| Date | `"YYYY-MM-DD"` | `null` | `"2023-12-20"` / `null` | `date.ts:9` |
| Timestamp | `"YYYY-MM-DDTHH:mm:ss+0000"` | `null` | | `timestamp.ts:8-10` |
| Number | number | `null` | | `number.ts:9-11` |
| Select | option string | `null` | `null` | `select.ts:10-13` |
| Key text (`Text`) | string | `null` or `""` | `null` | `keyText.ts:9-11` |
| UID | top-level `document.uid`, not inside `data` | - | | `document.ts:25` |
| Separator | not represented in API data **[INFERENCE]** | | | |

`EmptyObjectField = Record<string, never>` (`client/src/types/value/types.ts:21`).

### 2.1 Rich text

Block node types (`client/src/types/value/richText.ts:10-30`): `heading1`..`heading6`, `paragraph`, `preformatted`, `list-item`, `o-list-item`, `image`, `embed`. (`group-list-item`, `group-o-list-item`, `span` are client-side serializer nodes, never on the wire.)

- Text block: `{type, text, spans: Span[], direction?: "ltr"|"rtl"}` (`:42-96`). Live: `direction:"ltr"` present on most blocks; absent on some older ones.
- Spans (`:101-161`), `start`/`end` are UTF-16 offsets **[INFERENCE: JS string semantics]**:
  - `{start, end, type:"strong"}`, `{start, end, type:"em"}`
  - `{start, end, type:"label", data:{label:"inline-code"}}`
  - `{start, end, type:"hyperlink", data: FilledLinkField}` (Web `{link_type:"Web", url, target?}`; Document `{id,type,tags,lang,slug,first_publication_date,last_publication_date,uid,link_type:"Document",isBroken}` - no `key`; Media).
- Image block (`:126-143`): `{type:"image", id, url, alt, copyright, dimensions:{width,height}, edit:{x,y,zoom,background}, linkTo?}`. Live: `url` like `https://images.prismic.io/<repo>/<b64id>_<uuid>_<filename>.png?auto=compress,format&rect=0,0,2804,1504&w=2804&h=1504`.
- Embed block (`:146-149`): `{type:"embed", oembed: EmbedField}`.

### 2.2 Image

`client/src/types/value/image.ts:13-28` + thumbnails as sibling keys (`:50-74`):

```json
{ "id": "ZYL5ilMawoRaJtF4", "url": "https://.../x.png?auto=compress,format",
  "dimensions": {"width": 517, "height": 290},
  "edit": {"x": 0, "y": 0, "zoom": 1, "background": "transparent"},
  "alt": null, "copyright": null,
  "<thumbnailName>": { same 6 keys } }
```

Every key other than `url, dimensions, id, alt, copyright, edit` is a thumbnail view (`client/src/helpers/asImageWidthSrcSet.ts:72-84`). When the main image is filled, all thumbnails are filled ("The Prismic Rest API will always return thumbnail values if the base size is filled", `:82-83`). Crop URL rule (rect/w/h only when cropped/resized): `ti/src/helpers/imageContent.ts:21-48`.

### 2.3 Links

`client/src/types/value/link.ts`, `linkToMedia.ts`, `contentRelationship.ts`:

- `link_type` enum `Any|Document|Media|Web` (`link.ts:8-13`).
- Optional on every variant: `text?: string`, `variant?: string` (`link.ts:91-94`); live also `key: "<uuid v4>"` on field-level links (not on rich-text span links).
- Web: `{link_type:"Web", url, target?}` (`link.ts:76-80`); live `target:"_blank"`.
- Document (filled) (`contentRelationship.ts:29-45`): `{link_type:"Document", id, uid?, type, tags, lang, url?, slug?, isBroken?, data?}`. Live order: `id, type, tags, lang, slug, first_publication_date, last_publication_date, uid, [data], link_type, key, isBroken:false`. `data` only appears via `fetchLinks`/`graphQuery` (`ev/search.fetchlinks.json`: `data:{"name":[...]}`). `url` appears when `routes` resolve it.
- Document (broken), live: `{"id":"...","type":"broken_type","tags":[],"lang":null,"slug":"-","first_publication_date":null,"last_publication_date":null,"link_type":"Document","key":"...","isBroken":true}`.
- Media (`linkToMedia.ts:24-33`): `{link_type:"Media", id, name, kind, url, size: string, height?: string|null, width?: string|null}`. Live file: `{"link_type":"Media","kind":"file","id":"X5w0LxQAACQAYkf4","url":"https://<repo>.cdn.prismic.io/...pdf","name":"...pdf","size":"140563"}`. `kind` is `"image"` or `"file"`.
- Client detection rules: `filledContentRelationship` needs `link_type==="Document"`, `id`, `type`, `tags`, `lang` (`client/src/lib/isValue.ts:123-140`); `filledLinkToMedia` needs `id,name,kind,url,size` (`:32-48`).

### 2.4 Embed

`client/src/types/value/embed.ts:8-150`: oEmbed `type` `photo|video|link|rich`, `version`, optional `title, author_name, author_url, provider_name, provider_url, cache_age, thumbnail_url, thumbnail_width, thumbnail_height`, arbitrary extra keys, plus `embed_url` and `html` (string|null); `photo` adds `url,width,height`; `video`/`rich` add `html,width,height`. Live YouTube sample in `ev/field-shapes.observed.md` (`## embed`).

### 2.5 Table

`client/src/types/value/table.ts:10-70`: `{head?: {rows:[{key, cells:[{key, type:"header", content: RichText}]}]}, body: {rows:[{key, cells:[{key, type:"header"|"data", content: RichText}]}]}}`. Cell rich text limited to `paragraph,strong,em,hyperlink` (`ti/src/model/table.ts:17-29`). Live sample `ev/field-shapes.observed.md` (`## table`).

### 2.6 Slices

- Shared slice (`client/src/types/value/sharedSlice.ts:8-15`, `sharedSliceVariation.ts:4-13`): `{id, slice_type, slice_label: null, variation, version, primary: {...}, items: [{...}]}`. Live: `id = "<slice_type>$<uuid v4>"`, `version` is a model hash (e.g. `"sktwi1xtmkfgx8626"`) or `"initial"`, key order `variation, version, items, primary, id, slice_type, slice_label`. `primary` may contain groups (`AnySlicePrimaryField`, `types.ts:48`).
- Legacy/composite slice (`client/src/types/value/slice.ts:8-18`): `{slice_type, slice_label: string|null, id, primary, items}` (no `variation`/`version`).
- Client mapping code keys on `slice_type` (`client/src/helpers/mapSliceZone.ts:198-199`).

### 2.7 Group / nested group

Array of objects keyed by field id; nested groups allowed one level (`client/src/types/value/group.ts:8-24`; model `ti/src/model/group.ts:27-37`).

---
## 3. `@prismicio/types-internal` - model JSON (custom types and slices)

All schemas are zod/mini; `label: z.nullish(string)` on every config. `fieldset: nullish(string)` on most fields.

### 3.1 Custom type

`ti/src/model/customType.ts:14-92`:

```jsonc
{
  "id": "blog_post",                  // string
  "label": "Blog post",               // string | null | undefined
  "repeatable": true,                 // default true
  "status": true,                     // default true
  "format": "page" | "custom",        // default "custom"
  "json": { "<TabName>": { "<fieldId>": FieldModel } },
  "schema": undefined | "@prismicio/types-internal@4.5.0"   // discriminator
}
```

With `schema: "@prismicio/types-internal@4.5.0"` extra checks: a `UID` widget must have key `uid`; widget ids unique across tabs (`:35-73`). Widget keys must not contain `<` or `>` (`ti/src/common/widgetKey.ts:3-9`). Client type equivalent: `client/src/types/model/customType.ts:9-54`.

Top-level widget = `UID | Nestable | Group | Slices` (`ti/src/model/widget.ts:14-27`). "Static" form embeds full SharedSlice models in `choices`; "Dynamic" form (what the Custom Types API stores) uses `{ "type": "SharedSlice" }` refs (`ti/src/helpers/customTypeModel.ts:10-85`).

Field `type` enum (`ti/src/model/widget.ts:30-51`): `Color, Boolean, Number, Embed, GeoPoint, Date, Range, StructuredText, Select, Separator, Table, Text, Timestamp, Link, Image, IntegrationFields, UID, Group, Slices, Choice`; plus slice types `Slice`, `SharedSlice` and meta `Repeatable.Link` (`:56-61`).

### 3.2 Field configs

| `type` | `config` keys | Source |
|---|---|---|
| `Boolean` | `label`, `default_value?: boolean`, `placeholder_true?`, `placeholder_false?` (no `fieldset`) | `ti/src/model/boolean.ts:3-13` |
| `Color` | `label`, `placeholder?` | `color.ts:3-12` |
| `Date` | `label`, `placeholder?`, `default?: string` | `date.ts:3-13` |
| `Timestamp` | `label`, `placeholder?`, `default?: string` | `timestamp.ts:3-13` |
| `Number` | `label`, `placeholder?`, `min?`, `max?`, `step?` (number or numeric string -> number) | `number.ts:4-24` |
| `Range` (legacy) | same as Number | `range.ts:4-24` |
| `Select` | `label`, `placeholder?`, `default_value?: string`, `options?: string[]` (numbers/booleans coerced to strings) | `select.ts:5-28` |
| `Text` | `label`, `useAsTitle?`, `placeholder?` | `text.ts:3-13` |
| `UID` | `label`, `useAsTitle?`, `placeholder?` | `uid.ts:3-13` |
| `Embed` | `label`, `placeholder?`, `useAsTitle?` | `embed.ts:3-13` |
| `GeoPoint` | `label` | `geopoint.ts:3-11` |
| `Separator` | `label` (no `fieldset`) | `separator.ts:3-10` |
| `IntegrationFields` | `label`, `placeholder?`, `catalog?: string` | `integrationField.ts:3-13` |
| `Table` | `label` (no `fieldset`) | `table.ts:5-14` |
| `StructuredText` | `label`, `placeholder?`, `useAsTitle?`, `single?`, `multi?`, `imageConstraint?: {width?,height?}`, `labels?`, `allowTargetBlank?` | `richText.ts:92-107` |
| `Image` | `label`, `placeholder?`, `constraint?: {width?, height?}`, `thumbnails?: [{name, width?, height?}]` | `image.ts:31-55` |
| `Link` | `label`, `useAsTitle?`, `placeholder?`, `select?: "media"\|"document"\|"web"\|null` (other values -> null), `customtypes?`, `masks?` (string or string[]), `tags?` (string or string[]), `allowTargetBlank?`, `allowText?`, `repeat?`, `variants?: string[]` | `link.ts:123-141` |
| `Group` | top-level `icon?`, `description?`; config `label`, `repeat?: boolean`, `fields?: {id: Nestable \| NestedGroup}` (nested group may contain only nestables) | `group.ts:10-37` |
| `Slices` / `Choice` | `label`, `labels?: {<sliceId>: [{name, display?}]} \| null`, `choices?: {<sliceId>: SliceModel}` | `slices.ts:6-52` |

Details:

- **StructuredText `single`/`multi`**: comma-separated list of node types from `heading1..6, paragraph, preformatted, o-list-item, list-item, image, embed, hyperlink, strong, em, rtl`; unknown entries dropped; null/empty -> `"paragraph"` (`ti/src/model/richText.ts:9-47`). `single` = one block, `multi` = many **[convention]**.
- **StructuredText `labels`** normalised to `string[]` from `null`, a string, `string[]`, or legacy `{"<group>":[{name}]}` (empty-key group preferred) (`richText.ts:56-90`).
- **Image side constraint**: `"auto"`, `""`, `null` -> null; numbers rounded; strings like `"800px"` -> 800 (`image.ts:11-29`).
- **Link `customtypes`** (`link.ts:11-105`): array of strings, or (at most one) object `{id, fields: [...]}` selecting fields to fetch; field entries may be strings, `{id: groupId, fields: [string]}`, or `{id: crFieldId, customtypes: [string | {id, fields:[string | {id, fields:[string]}]}]}` (two levels). No duplicates; cannot mix string and object entries; max one object.

### 3.3 Slice models

`ti/src/model/slice.ts`:

- Legacy slice (pre-2020): any nestable or nested group (`:10-15`).
- Composite `Slice` (2020-21): `{type:"Slice", fieldset?, description?, icon?, display?, "non-repeat"?: {id: Nestable}, repeat?: {id: Nestable}, config?: {label}}` (`:18-35`). Client `display` values `list`/`grid` (`client/src/types/model/slice.ts:37-40`).
- `SharedSlice` (`:43-117`):

```jsonc
{
  "id": "hero", "type": "SharedSlice", "name": "Hero", "description"?: "...",
  "variations": [{
    "id": "default", "name": "Default", "description": "...",
    "imageUrl": "...",       // default placeholder https://images.prismic.io/slice-machine/621a5ec4-0387-4bc5-9860-2dd46cbc07cd_default_ss.png?auto=compress,format
    "docURL": "...", "version": "...", "display"?: "...",
    "primary"?: { "<id>": Nestable | Group },
    "items"?: { "<id>": Nestable }
  }],
  "legacyPaths"?: { "<string>": "<string>" },
  "schema"?: "@prismicio/types-internal@4.5.0"   // then: >=1 variation, unique variation ids
}
```

- Slice ref inside a custom type (dynamic form): `{ "type": "SharedSlice" }` (`:119-121`, `:141-146`).

### 3.4 Document content formats in types-internal

Two internal formats exist. **Neither is used by the public SDK wire calls** (the Migration API accepts the Content-API shape, section 5); they matter only for editor/storage compatibility.

#### 3.4.1 "Legacy" (storage/import) format - flat object

`ti/src/helpers/documentContent.ts:61-101` (`fromLegacy`/`toLegacy`): one flat object containing

- widget values keyed by field id,
- `"<path>_TYPE": FieldOrSliceType` for every field (needed to decode; values from `ti/src/model/widget.ts:56-61`),
- `"<path>_KEY": "<uuid v4 | v5>"` for group items / repeatable items,
- `"<...>_POSITION"` keys are ignored.

Path rules (`ti/src/content/codec/legacyContentCtx.ts:47-56`, `:75-90`; codecs `group.ts:14-78`, `slice.ts:142-243`):

- top level: `title_TYPE`
- group item fields: `<group>.<field>_TYPE`; item key: `<group>.<index>_KEY`
- slice zone: `<zone>_TYPE: "Slices"`; slice: `<zone>.<sliceName>_TYPE: "SharedSlice"|"Slice"`
- shared slice primary: `<zone>.<slice>.variations.<variation>.primary.<field>_TYPE`; items: `<zone>.<slice>.variations.<variation>.items.<field>_TYPE`
- composite slice: `<zone>.<slice>.non-repeat.<field>_TYPE`, `<zone>.<slice>.repeat.<field>_TYPE`
- default key when missing: uuid v5 of `JSON.stringify(contentPath)` in the URL namespace (`legacyContentCtx.ts:6-8`).

Legacy value shapes (`ti/src/content/legacy/*.ts`):

| Field | Legacy value | Source |
|---|---|---|
| empty | `null` or `{value:null}` | `legacy/empty.ts:3-8` |
| Text/Color/Date/Timestamp/Number/Range/Select | trimmed **string** (Number stored as string) | `legacy/field.ts:3-6`, `codec/field.ts:35-69` |
| Boolean | boolean | `legacy/boolean.ts:3` |
| UID | string | `legacy/uid.ts:4` |
| IntegrationFields | string | `legacy/integrationField.ts:3` |
| GeoPoint | `{position:{lat, lng}}` | `legacy/geopoint.ts:3-8` |
| Embed | `{embed_url, type, version?, title?, author_*?, provider_*?, cache_age?, thumbnail_*?, html?, ...}` (loose) | `legacy/embed.ts:3-21` |
| Image | `{origin:{id,url,width,height}, width, height, edit:{zoom, crop:{x,y}, background}, url?, credits?, alt?, provider?, thumbnails?:{name: view}}` | `legacy/image.ts:3-41` |
| Link | `{key?, text?, variant?, kind, ...}`; kinds: `image` `{id,url,height,width,size,name,date?}` (strings), `file` `{id,url,name,size,date?}`, `document` `{id}`, `web` `{url,target?,preview?:{title?}}`, empty `{kind:"image"\|"file"\|"media"\|"document"\|"web"}`, any `{}` | `legacy/link.ts:5-192` |
| Repeatable.Link | array of Link | `codec/repeatable.ts:9-68` |
| StructuredText | `[{type, content:{text, spans:[{type,start,end,data}]}, label?, direction?}]`; label span `data` is a **string**; hyperlink span `data` is a legacy link value; image block `{type:"image", data:{...imageView, linkTo?}, label?, direction?}`; embed block `{type:"embed", data:{...embed}}` | `legacy/richText.ts:13-193` |
| Table | `{content:[{key, type:"tableRow", content:[{key, type:"tableHeader"\|"tableCell", content: RichTextLegacy, columnWidth?}]}]}` | `legacy/table.ts:9-37` |
| Separator | anything (written as `{}`) | `legacy/separator.ts:4`, `codec/separator.ts:26-32` |
| Group | `[ {fieldId: value} \| null ]` | `legacy/group.ts:8-21` |
| Slices | `[{key:"<sliceName>$<uuid>", label?, value: SliceValue}]` - slice name = `key.split("$")[0]` | `legacy/slices.ts:6-15`, `codec/slices.ts:24` |
| Shared slice value | `{variation, primary:{}, items:[{}]}` | `legacy/slice.ts:23-27` |
| Composite slice value | `{"non-repeat"?:{}, repeat?:[{}]}` | `legacy/slice.ts:13-16` |

#### 3.4.2 Domain (`__TYPE__`) format - WidgetContent codecs

`ti/src/content/*.ts`, a tagged form used by tooling:

- `FieldContent` `{__TYPE__:"FieldContent", type:"Text"|"Color"|"Date"|"Timestamp"|"Number"|"Range"|"Select", value:string}` (`field.ts:3-64`)
- `BooleanContent` `{value}` (`boolean.ts:3-8`); `EmptyContent` `{type}` (`empty.ts:3-8`); `UIDContent` `{value}` (`uid.ts:3-8`); `IntegrationFieldsContent` `{value:string}` (`integrationField.ts:3-8`); `SeparatorContent` (`separator.ts:3-7`)
- `EmbedContent` = legacy embed + `all` raw (`embed.ts:5-10`); `GeoPointContent` (`geopoint.ts:5-9`); `ImageContent` (`image.ts:5-13`)
- `LinkContent` `{__TYPE__:"LinkContent", key, value:{__TYPE__:"ImageLink"|"FileLink"|"DocumentLink"|"ExternalLink"|"MediaLink"|"AnyLink", ...legacy, text?, variant?}}` (`link.ts:117-153`, `legacy/link.ts:14-21`)
- `RepeatableContent` `{type:"Link", value: LinkContent[]}` (`repeatable.ts:5-11`)
- `StructuredTextContent` `{value: blocks}` (`richText.ts:53-63`); `TableContent` (`table.ts:6-12`)
- `GroupContentType` `{value:[{__TYPE__:"GroupItemContent", key, value:[[fieldId, content], ...]}]}` (`group.ts:7-37`)
- `SliceContentType` (sic) `{value:[{key, name, maybeLabel?, widget}]}` (`slices.ts:49-55`), widget = `SharedSliceContent {variation, primary, items: GroupItemContent[]}` | `CompositeSliceContent {nonRepeat, repeat}` | legacy nestable/group (`slice.ts:12-39`).

Helper id rules: custom type id `serializeID` -> lowercase `[a-z0-9_]` (`ti/src/helpers/customTypeModel.ts:158-172`); repository id 4-63 chars `[a-z0-9-]` (`ti/src/helpers/repository.ts:4-23`); UID `serializeUID` (`ti/src/helpers/documentContent.ts:103-111`).

---
## 4. `@prismicio/custom-types-client` - Custom Types API

Base URL default `https://customtypes.prismic.io` (`cti/src/client.ts:21`); overridable per client (`endpoint`) or per call (`params.endpoint`) (`:26-58`, `:504`). A trailing `/customtypes` or `/customtypes/` on the endpoint is stripped for v1 compatibility (`:167-169`). URL = `new URL(path, endpoint + "/")` with relative paths `./customtypes`, etc. (`:504-508`) - the endpoint may include a path prefix.

Headers on every request (`:514-521`), user `fetchOptions.headers` may override:

```
Content-Type: application/json
repository: <repositoryName>
Authorization: Bearer <token>
```

| Method | HTTP | Path | Body | Expected success | Source |
|---|---|---|---|---|---|
| `getAllCustomTypes` | GET | `/customtypes` | - | 200 `CustomType[]` | `client.ts:199-203` |
| `getCustomTypeByID(id)` | GET | `/customtypes/{id}` | - | 200 `CustomType` | `:220-225` |
| `insertCustomType(ct)` | POST | `/customtypes/insert` | `CustomType` JSON | 201 (or 204) | `:244-255` |
| `updateCustomType(ct)` | POST | `/customtypes/update` | `CustomType` JSON | 204 (or 201) | `:274-285` |
| `removeCustomType(id)` | DELETE | `/customtypes/{id}` | - | 204 | `:300-309` |
| `getAllSharedSlices` | GET | `/slices` | - | 200 `SharedSlice[]` | `:324-328` |
| `getSharedSliceByID(id)` | GET | `/slices/{id}` | - | 200 `SharedSlice` | `:346-351` |
| `insertSharedSlice(s)` | POST | `/slices/insert` | `SharedSlice` JSON | 201/204 | `:370-381` |
| `updateSharedSlice(s)` | POST | `/slices/update` | `SharedSlice` JSON | 204/201 | `:400-411` |
| `removeSharedSlice(id)` | DELETE | `/slices/{id}` | - | 204 | `:426-435` |
| `bulkUpdate(ops)` | POST | `/bulk-update` | `{ "changes": BulkUpdateOperation[] }` | 201/204 | `:458-476` |

POST bodies are `JSON.stringify(model)` (`:96-101`). The client ignores bodies of 201/204 and returns its own input.

Bulk operations (`cti/src/bulkUpdate.ts:6-50`): `{type, id, payload}` with `type` in `CUSTOM_TYPE_INSERT`, `CUSTOM_TYPE_UPDATE`, `CUSTOM_TYPE_DELETE`, `SLICE_INSERT`, `SLICE_UPDATE`, `SLICE_DELETE`; delete payloads are `{id}`, others the full model. Diff semantics (by `id`, JSON string comparison) in `:57-121`.

Status -> error (`cti/src/client.ts:529-613`; classes `cti/src/errors.ts:20-116`):

| Status | Body read as | Error |
|---|---|---|
| 200 | JSON | (success) |
| 201, 204 | not read | (success, returns undefined) |
| 400 | text | `InvalidPayloadError(text)` |
| 401 | text | `UnauthorizedError(text)` |
| 403 | **JSON (must be valid JSON)**; if `hasExistingDocuments: true` | `BulkUpdateHasExistingDocumentsError`, else `ForbiddenError(json.message)` |
| 409 | not read | `ConflictError` (duplicate id on insert) |
| 404, 422 | not read | `NotFoundError` (404 get missing; 422 update missing) |
| anything else | - | `InvalidAPIResponse` |

Live: unauthenticated requests get 403 from API Gateway (`ev/protected-endpoints.txt`, `x-amzn-errortype: AccessDeniedException`).

---

## 5. Write / Migration / Asset APIs (`@prismicio/client` `WriteClient`, `Migration`; `@prismicio/migrate`)

### 5.1 Configuration and transport

- `createWriteClient(repositoryName, { writeToken, assetAPIEndpoint?, migrationAPIEndpoint?, ...ClientConfig })` (`client/src/createWriteClient.ts:32-35`, `client/src/WriteClient.ts:132-151`). Extends `Client`, so Content API reads (`getRepository`) use `documentAPIEndpoint` (`:372`).
- Defaults: `assetAPIEndpoint = "https://asset-api.prismic.io/"`, `migrationAPIEndpoint = "https://migration.prismic.io/"` (`:167-168`). Overrides get `"/"` **appended unconditionally** (`:192-198`) - passing a trailing slash yields `//` in paths.
- Paths are relative: `new URL("documents", migrationAPIEndpoint)` etc., so a path prefix is allowed.
- Headers on **every** write-client request (`#request`, `:800-818`), set last so they cannot be overridden: `repository: <repositoryName>`, `authorization: Bearer <writeToken>`. Plus per-call: `content-type: application/json` (JSON calls) and `x-client: prismicio-client/7.22.3` (Migration API calls only; `CLIENT_IDENTIFIER` `:33`).
- These auth headers are also sent when downloading a **foreign** asset URL during migration (`fetchForeignAsset`, `:597-610`).
- All POST/PUT/PATCH go through the per-host 1500 ms serial throttle (1.2). Live Asset API limit: `x-ratelimit-limit-second: 10` (`ev/protected-endpoints.txt`).
- No `x-api-key`, no login/auth URL in this SDK version. Evidence only: `auth.prismic.io/login` POST returns 401 with empty body on bad creds (`ev/protected-endpoints.txt`).

### 5.2 Migration API

| Call | HTTP | Path | Request body | Success | Source |
|---|---|---|---|---|---|
| `createDocument` | POST | `/documents` | `{title, type, uid?, lang, alternate_language_id?, tags?, data}` | **201** `{id, title, type, lang, uid?}` (client reads `id`) | `WriteClient.ts:712-748`, types `client/src/types/api/migration/document.ts:10-41` |
| `updateDocument` | PUT | `/documents/{id}` | `{title?, uid?, tags?, data}` | **200** (body ignored) | `:759-789`, types `document.ts:50-68` |
| `publishMigrationRelease` | POST | `/migration-release/publish` | `{}` | **202** `{totalItems: number}` | `:260-285`, `client/src/types/api/migration/release.ts:6-9` |

`undefined` keys are omitted by `JSON.stringify` (e.g. `uid: document.uid || undefined`, `:727`).

Errors (`#handleMigrationAPIError`, `:858-888`; body parsed as JSON, message = `body.message`): 400 -> `InvalidDataError`; 401 -> `ForbiddenError`; 403 -> `ForbiddenError` (message falls back to `body.Message`, API Gateway style); 404 -> `NotFoundError`; else `PrismicError`.

`migrate(migration, {reporter})` flow (`:208-489`):

1. Create every asset (5.3) sequentially.
2. `getRepository()`; master locale = `languages[0].id` (`:372-373`). Create documents without `id` (master-locale ones first) via POST with `data: {}` (`:425-433`); non-master documents get `alternate_language_id` = created id of the master-language document (`:406-423`).
3. PUT every document with resolved `data` and `title` (`:451-489`).

Document `data` sent to the Migration API = Content-API shape after resolution (`client/src/lib/resolveMigrationDocumentData.ts:185-233`):

- Content relationship -> `{link_type:"Document", id, text?, variant?}` or `{link_type:"Any"}` if unresolved (`:30-68`).
- Image -> `{id: <asset id>, url: <asset url without query> + original query, dimensions:{width: asset.width, height: asset.height}, edit (original or {x:0,y:0,zoom:1,background:"transparent"}), alt, copyright: asset.credits||null, ...thumbnails}` (`:78-124`).
- Rich-text image -> image + `type:"image"`, `linkTo?` (`:133-148`).
- Link to media -> `{id: <asset id>, link_type:"Media", text?, variant?}` or `{link_type:"Any"}` (`:157-176`).
- Arrays drop falsy entries (`:218`).
- Broken links copied from Prismic -> `{link_type:"Document", id:"_____broken_____", isBroken:true}` ("ID needs to be 16 characters long to be considered valid by the API") (`client/src/Migration.ts:362-370`).
- Also allowed by types (`client/src/types/migration/Document.ts:16-37`): embed as `{embed_url}` only (server must resolve oEmbed) (`:28-29`); shared slices without `id`, `slice_label`, `version` (`:30-31`).
- `@prismicio/migrate` `htmlAsRichText` emits rich-text image nodes with `id: ""`, external `url`, possibly undefined `dimensions` ("the migration API accepts `undefined` values for those fields") (`migrate/src/lib/hastSerializerHelpers.ts:17-71`); embeds as `{type:"embed", oembed:{version:"1.0", embed_url, html, title?, type:"rich"|"link", width?, height?}}` (`:80-113`); hyperlinks as `{link_type:"Web", url, target?}` (`:123-151`). Dimension inference from imgix params only for host `images.prismic.io` (`:35`). Entry point `migrate/src/htmlAsRichText.ts:107-117`. **The server must accept/import such external images [INFERENCE].**

### 5.3 Asset API

| Call | HTTP | Path | Request | Success | Source |
|---|---|---|---|---|---|
| `createAsset` | POST | `/assets` | `multipart/form-data`: `file` (File with filename, content-type from source), optional `notes`, `credits`, `alt` (no tags) | **200** `Asset` | `WriteClient.ts:499-544` |
| `updateAsset` | PATCH | `/assets/{id}` | JSON `{notes?, credits?, alt?, filename?, tags?: [tagId]}` | **200** `Asset` | `:553-588` |
| `getAssetTags` | GET | `/tags` | - | **200** `{items: AssetTag[]}` | `:685-699` |
| `createAssetTag` | POST | `/tags` | JSON `{name}` | **201** `AssetTag` | `:659-677` |

- If tags are requested, `createAsset` then calls `updateAsset(id, {tags})`, which resolves tag names to ids via `GET /tags` and creates missing ones (`:534-536`, `:613-648`).
- `Asset` (`client/src/types/api/asset/asset.ts:17-73`): `{id, url, created_at: number, last_modified: number, filename, extension, size: number, kind: "image"|"audio"|"document"|"video", width?, height?, notes?, credits?, alt?, tags?: AssetTag[], origin_url?, uploader_id?, search_highlight?}`. `width`/`height` are required in practice for images (used as image `dimensions`, `resolveMigrationDocumentData.ts:92-95`).
- `AssetTag` (`client/src/types/api/asset/tag.ts:6-24`): `{id, name, created_at, last_modified, uploader_id?, count?}`.
- Declared but **not called** by any SDK method in 7.22.3 (so list/delete wire formats are only typed): `GetAssetsParams {pageSize?, cursor?, assetType?: "all"|"audio"|"document"|"image"|"video", keyword?, ids?, tags?}`, `GetAssetsResult {items, total, cursor?, missing_ids?, is_opensearch_result}`, `BulkDeleteAssetsParams {ids}` (`asset.ts:80-160`).
- Client-side validation before upload: notes/credits/alt <= 500 chars; each tag 3-20 chars (`client/src/lib/validateAssetMetadata.ts:4-56`).
- Errors (`#handleAssetAPIError`, `:829-847`, message = `body.error`): 401/403 -> `ForbiddenError`; 404 -> `NotFoundError`; 400 -> `InvalidDataError`; else `PrismicError`. Body must be JSON.
- Asset filename derived when migrating from an existing Prismic URL: last path segment after the last `_` (`client/src/Migration.ts:142-146`), i.e. Prismic image URLs are `.../<repo>/<id>_<filename>`.

---

## 6. Webhooks (payload types only)

`client/src/types/webhook/*.ts`: base `{type: "api-update"|"test-trigger", domain, apiUrl, secret: string|null}` (`types.ts:11-21`); `api-update` adds `masterRef?`, `releases`, `masks`, `tags` (each `{update?, addition?, deletion?}` lists), `documents: string[]`, `experiments?` (`apiUpdate.ts:8-54`).
