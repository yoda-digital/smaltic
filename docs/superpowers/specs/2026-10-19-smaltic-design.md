# Smaltic — a self-hosted, Prismic-compatible headless page builder

Status: draft (architecture). The parity scope is in `docs/research/REA.md` (requirement IDs `REQ-*`).
Owner of the "how": Claude. The user skipped the design Q&A and said "just start", so every decision below
is Claude's call, labeled as such, and can be overridden.

## 1. Intent

The user wants a platform equivalent to prismic.io that they can host themselves, with full feature parity.
The parity that matters most is **wire compatibility**: a website built for Prismic
(Next.js / Nuxt / SvelteKit using the official `@prismicio/*` SDKs) should run against Smaltic by changing
only configuration (endpoint URLs), not code. On top of that, the editing experience (Page Builder,
Type Builder, media library, releases, locales, roles, previews, webhooks) must cover the same jobs.

### Goals
- G1. Content API v2, Tags API, GraphQL API: response-shape and behaviour compatible (verified by running
  the official `@prismicio/client` against Smaltic in CI).
- G2. Write side compatible: Custom Types API, Migration API, Asset API (official write client and
  `@prismicio/custom-types-client` work with overridden endpoints).
- G3. Previews compatible with the official toolbar script and `@prismicio/next|nuxt|svelte` preview flows.
- G4. A full editor ("Studio"): Page Builder with slices and live preview, Type Builder, media library,
  releases & scheduling, localization, users/roles, tokens, webhooks, environments, history.
- G5. One `docker compose up` to self-host; Postgres + local disk (or S3) are the only dependencies.

### Non-goals
- Billing, plans, quotas and Prismic's SaaS account system (we are self-hosted; usage limits are config).
- Pixel-for-pixel copy of Prismic's UI or any of its branding, logos, names or copy.
- Hosting Prismic's own proprietary code. Everything here is implemented from the public docs and the
  observable wire protocol (see `docs/research/`).

### Anti-goals (would make this a failure even if it "works")
- An API that is "Prismic-like" but where the official SDK breaks on edge cases (refs, previews, pagination,
  empty field shapes). Compat tests with the real SDK are mandatory, not optional.
- Data loss: drafts, versions and published history must never be overwritten in place.
- Presenting itself as Prismic. The name is Smaltic, and "Prismic-compatible" is used only as a description.

## 2. Architecture (Claude's call)

```
                 ┌──────────────────────── smaltic server (Node 22, Fastify) ───────────────────────┐
 Website/SDK ──▶ │ Content API /api/v2  · Tags /api/tags · GraphQL /graphql · Image CDN /img/...   │
 Editors ─────▶  │ Studio SPA (/studio) ──▶ Studio API /studio-api/*  (session cookie auth)        │
 CLI/scripts ──▶ │ Custom Types API /customtypes /slices · Migration API /migration/* · Asset API   │
 Toolbar ─────▶  │ /prismic.js loader · /prismic-toolbar/<v>/iframe.html (preview bridge)          │
                 │ Workers (same process, opt-out): scheduler (releases), webhooks, oEmbed, image  │
                 └───────────────┬───────────────────────────────────────┬──────────────────────────┘
                                 ▼                                       ▼
                            PostgreSQL 16                     Blob storage (disk | S3)
```

- **Language/runtime:** TypeScript, Node 22, pnpm monorepo.
- **Server:** Fastify 5, `postgres` (porsager) with hand-written SQL migrations, `zod` validation,
  `graphql` (graphql-js) for the GraphQL API, `sharp` for imgix-compatible image transforms.
- **Studio:** React 18 + Vite + React Router + TanStack Query; Tiptap/ProseMirror for rich text;
  dnd-kit for drag and drop. Served by the same server as static files.
- **Shared package:** `@smaltic/model` — TypeScript types + zod schemas for custom-type/slice models,
  document content, and the converters between them. Used by server and Studio.

### Repository addressing (multi-tenant)
One installation hosts many repositories. A request is bound to a repository by, in order:
1. the `repository` header (write APIs, exactly like Prismic),
2. a subdomain `<repo>.<SMALTIC_BASE_DOMAIN>` (wildcard DNS; needed for the toolbar which addresses the
   repository by host),
3. a path prefix `/r/<repo>/...` (zero-DNS fallback, e.g. `http://localhost:8080/r/blog/api/v2`).
URLs the server emits (`forms.*.action`, `next_page`, `href`, image URLs) use the same addressing form the
request arrived with, so `getTags()` and pagination keep working.
SDK usage: `createClient("blog", { documentAPIEndpoint: "https://blog.cms.example.com/api/v2" })`
(the SDK cannot infer a repository name from a non-prismic host; see api-contracts §0.1).

### Content storage model
- `documents` — one row per (document id, locale). Prismic-style 16-char ids. `group_id` links translations
  (`alternate_languages`). Holds `type`, `lang`, first/last publication dates, archived flag.
- `document_versions` — immutable snapshots: `content` (JSONB in the Content-API value shape, minus the
  computed bits), `uid`, `tags`, author, created_at, message. Never updated in place (anti-goal: data loss).
- Each document has at most one **working draft** pointer and one **live** pointer.
- `publications` — monotonically increasing sequence; each publish/unpublish/release-publish bumps it and
  mints a new **master ref** string. `live_ranges(doc, version, from_seq, to_seq)` records which version was
  live during which range, so recent historic refs remain queryable (expired after a configurable TTL →
  410 `RefExpiredError` with the "Master ref is:" message the SDK parses).
- **Releases** have their own ref; querying a release ref = master overlaid with the release's staged
  versions/unpublishes.
- **Preview refs** are signed tokens (`pv.<payload>.<hmac>`) that overlay drafts (doc preview) or a release
  (release preview) on master; they expire (404 `api_security_error`, which the SDK maps to
  `PreviewTokenExpiredError`). The server also accepts the toolbar's JSON cookie blob as `ref`.
- Full text: a `tsvector` per version computed from all text-bearing fields at write time.
- Search queries compile Prismic predicates to SQL over the JSONB of the visible version set for the ref.

### Write path invariants
- Every write goes through one domain service (`DocumentService`) used by Studio API and Migration API
  alike: validate against the custom type model → new version row → move draft pointer → audit log →
  emit domain event. Webhooks, scheduler and cache invalidation consume domain events.
- Content model edits (Type Builder / Custom Types API) are versioned too, and destructive model changes
  are rejected while documents depend on them (Prismic returns 403 `hasExistingDocuments`).

### Media
- `assets` table + blob store. The image endpoint implements the imgix parameter subset the SDKs and
  docs use (`auto=format,compress`, `w`, `h`, `fit`, `crop`, `rect`, `fm`, `q`, `dpr`, `ar`, `blur`, `sat`,
  `flip`, `rot`, `pad`, `bg`) with a disk/S3 transform cache. Image field values carry absolute URLs.

### Auth
- Studio users: email + password (argon2id), session cookie; optional OIDC SSO (P1). Roles per repository
  (per `rea/03` § users): Owner (exactly one), Administrator, Publisher, Writer, plus Contributor
  with per-space / per-locale Read-only / Writer / Publisher grants. Self-hosted: all tiers unlocked.
- API: access tokens (Content API, `access_token` param or `Authorization: Token`), write tokens
  (`Authorization: Bearer`, for Custom Types / Migration / Asset APIs). Repository API visibility:
  public / private / open (as in Prismic).

## 3. Verification strategy
- `tests/compat`: Vitest suites that boot Smaltic against a throwaway Postgres, seed via the Migration API
  using the **official** `@prismicio/client` WriteClient, then exercise every read helper, every filter,
  orderings, fetchLinks, graphQuery, routes, pagination incl. `dangerouslyGetAll`, refs/releases,
  preview tokens, GraphQL, tags, errors and retries. These map 1:1 to the REQ IDs.
- Golden-shape tests: the field value shapes captured live from prismic.io (`docs/research/evidence/`)
  are asserted against Smaltic's output for the same model.
- Studio: Playwright smoke flows (create type → create page → add slice → preview → publish → query).

## 4. Left to the builder
Library minor versions, folder layout inside each app, UI visual design (clean, original, accessible),
exact admin page arrangement, consistent with `docs/research/rea/03-product-editor-admin.md`.
