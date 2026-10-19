# Smaltic roadmap: plans and parity coverage

The spec (`docs/superpowers/specs/2026-10-19-smaltic-design.md`) covers several independent subsystems, so it is
built as a sequence of plans. Each plan ships working, tested software on its own. A plan is written in
detail only when the plans it depends on are merged, because it consumes their real interfaces.
Requirement IDs are taken from `docs/research/parity-matrix.md`.

| # | Plan | Delivers (testable on its own) | Main REQ groups | Depends on |
|---|---|---|---|---|
| 1 | **Core server and read/write APIs** (`2026-10-19-plan-1-core-api.md`) | Headless server. Models are pushed with the official custom-types client, content is imported with the official WriteClient, and everything is read back with the official `@prismicio/client`, including releases and preview refs | REQ-API (REST, tags, repository), REQ-WAPI (types, migration, basic assets), REQ-MOD, REQ-FLD, REQ-SDK (client parts), REQ-PRV (tokens), REQ-ENV-base | — |
| 2 | **Media and image CDN** | Full Asset API (list, search, bulk delete, tags), imgix-compatible transforms with a cache, S3 driver, external-image import during migration | REQ-MED, REQ-WAPI (asset), REQ-SDK (image helpers) | 1 |
| 3 | **GraphQL API** | Schema generated from the models, `allX`/`x` queries, `_meta`, slice unions, filters, sorting, pagination, `Prismic-Ref` header and preview refs | REQ-API (GraphQL), REQ-SDK (graphQLFetch) | 1 |
| 4 | **Studio I: shell, admin, Type Builder** | Web app with login, repository dashboard, users and roles (incl. per-locale contributor), tokens, API visibility, locales, preview configs, webhooks settings and the Type Builder (types, shared slices, variations, every field config) | REQ-ADM, REQ-MOD (builder), REQ-L10N (settings) | 1 |
| 5 | **Studio II: Page Builder** | Document list, search and filters, editor for every field type, slice zone with library, copy/paste and variations, autosave drafts, history with diff and restore, publish/archive/delete, releases and scheduling UI, translations, media library UI, live preview and slice simulator bridge | REQ-ED, REQ-MED (UI), REQ-L10N, REQ-PRV (UI) | 1, 2, 4 |
| 6 | **Platform services** | Preview toolbar bridge (`/prismic.js`, `/prismic-toolbar/<v>/iframe.html`) compatible with the official toolbar, webhooks with retry, auto-disable and logs, release scheduler, integration fields (pull and push catalogs), environments (clone/resync), CLI-compatible model sync, OIDC SSO, Docker images, Helm-free compose deployment, backup/restore docs | REQ-PRV, REQ-WH, REQ-ENV, REQ-DEV, REQ-ADM (SSO) | 1, 4 |
| 7 | **Compat hardening** | The full compat matrix from `rea/04` run against real Next.js, Nuxt and SvelteKit starters in CI, a shape diff against production evidence, and load tests | REQ-SDK (all), `wontdo` decisions recorded | 1–6 |

Out of scope for every plan (see `docs/research/REA.md` §8): billing and plans, quotas and Spend Manager,
Unsplash, and hosted AI features. Each of these is marked `wontdo` with its reason in the parity matrix.
