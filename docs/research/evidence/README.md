# Live evidence captured from prismic.io (2026-10-19)

All files were captured with `curl` against Prismic's production infrastructure using the public
repository `prismic-main` (the repository that powers prismic.io itself). Nothing here required credentials.

| File | What it proves |
|---|---|
| `api-root.prismic-main.json` + `.headers.txt` | `GET https://<repo>.cdn.prismic.io/api/v2` returns refs (master ref id), types map, languages, `forms.everything` (the full list of accepted search params: ref, q, lang, page, pageSize, after, fetch, fetchLinks, graphQuery, orderings, referer, routes, access_token, integrationFieldsRef), tags, oauth URLs, license, version. Served via CloudFront, `x-prismic-version: 6`, `access-control-allow-origin: *`. |
| `api-root.wroom-401.json` | Private repositories answer `401 {"error":"Invalid access token"}`. |
| `search.*.json` | `GET /api/v2/documents/search` result envelope (page, results_per_page, results_size, total_results_size, total_pages, next_page, prev_page, results, version, license) and the document envelope (id, uid, url, type, href, tags, first/last_publication_date `YYYY-MM-DDTHH:mm:ss+0000`, slugs, linked_documents, lang, alternate_languages, data). |
| `search.fetch*.json`, `search.graphquery.json`, `search.routes.json`, `search.after.json`, `search.similar.json`, `search.fulltext.json`, `search.number-date.json`, `search.lang-all.json`, `search.ordering.json` | Each query feature working live. `pageSize=101` is clamped to 100 (`search.pagesize-101.json`). |
| `search.bad-predicate.json` | Parse errors: `{"type":"api_parsing_error","message":"unrecognized attribute 'foo' ..."}` (HTTP 400). |
| `search.bad-ref.json` | Unknown ref: `{"type":"api_notfound_error","message":"Ref not found. ... Master ref is: <ref>"}` (HTTP 404). |
| `search.no-ref.json` | Missing ref: `{"type":"api_validation_error","message":"Please specify ref"}`. |
| `tags.json` | `GET /api/tags` returns a flat JSON array of strings. |
| `graphql.sample.json` + headers | `GET /graphql?query=...` with `Prismic-Ref` header; generated root fields like `allBlogs(first:)` with `totalCount`, `edges.node._meta {uid id type lang}`. |
| `field-shapes.observed.md` | One real sample of every field shape found in ~8 MB of production content: rich text blocks & spans, image (dimensions/alt/copyright/url/id/edit), links (Web, Document with `isBroken`, Media `kind:file`, empty `Any`), embed (oEmbed), table (`head.rows[].cells[]` with keys), shared slice (`id: "<slice_type>$<uuid>"`, `slice_type`, `slice_label`, `variation`, `version`, `primary`, `items`). |
| `protected-endpoints.txt` | Auth-protected services and their hosts: `customtypes.prismic.io` (Custom Types API), `migration.prismic.io` (Migration API), `asset-api.prismic.io` (Asset API, rate limit 10 req/s), `auth.prismic.io/login`, `user-service.prismic.io`. All AWS API Gateway; all need a `repository` header + bearer token. |
| `image-cdn-probe.txt` | `images.prismic.io` is imgix (`server: imgix`, `x-imgix-id`): `auto=format` negotiates AVIF, `w/h/fit=crop`, `fm=webp&q=`, `rect=`, `blur=` all honored. |
| `toolbar.prismic.js` | Preview toolbar loader: reads `repo` from its own `src`, accepts a full hostname (so it can point at a non-prismic.io host), mounts an iframe and talks via `MessageChannel` (`prismic-toolbar:connect` / `:ready`, methods getState/ping/closeSession/share), manages the `io.prismic.preview` cookie and fires `prismicPreviewStart`/`prismicPreviewUpdate`/`prismicPreviewEnd` window events. |
| `search.ordering-double-bracket.json` | Resolves REQ-SWP-001: `orderings=[[document.first_publication_date desc]]` is **rejected** live with HTTP 400 `api_parsing_error` (`']' expected but '[' found ... col:2`). Smaltic must reject it the same way. |

## Publication note (2026-10-19)
This repository is public. To avoid redistributing Prismic's copyrighted content and code, the committed
captures are **sanitized** with `tools/sanitize-evidence.py`: every key, id, ref, date, number, field/slice type,
URL and error message is kept byte-for-byte; prose (rich-text `text`, titles, alt text, captions…) is replaced by
same-length placeholder text so rich-text span offsets stay valid. `field-shapes.observed.md` is regenerated from the
sanitized files (`tools/extract-field-shapes.py`). `search.pagesize-101.json` keeps its envelope and first 2 results
(the full id order is listed in `_smaltic_note`). The raw captures and the toolbar scripts (`toolbar.prismic.js`)
are kept only locally in the git-ignored `evidence/raw/`; re-capture them with the curl commands described above.
