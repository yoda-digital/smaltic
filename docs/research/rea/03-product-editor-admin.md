# 03 — Product, Editor & Admin Requirements (Prismic, as of 2026-10-19)

Scope: product / Page Builder (editor) / publishing / media / localization / repository administration, users & roles, billing & plans, environments (UI side), integrations, migration, plus web-only facts (pricing, changelog, 2026 Type Builder + CLI changes). APIs, field models and SDK references are covered by other reports and are referenced here only where the editor behaviour depends on them.

Citation conventions:
- `pages/<file>.md § <heading>` = local mirror at `docs/research/prismic-docs-mirror/pages/` (first line of each file holds the source URL; fetched 2026-10-19).
- Full URLs = web pages fetched 2026-10-19 (pricing, updates/changelog, blog, GitHub, npm).
- "(inferred)" marks conclusions not stated verbatim by a source.

Requirement IDs: `REQ-ED-*` editor/publishing, `REQ-ADM-*` settings/users/roles/billing, `REQ-MED-*` media, `REQ-L10N-*` locales. Priority: P0 core / P1 important / P2 nice.

---

## 0. Context: what changed in 2026 (Type Builder + Prismic CLI replace Slice Machine)

**What.** In 2026 Prismic replaced its two modeling tools, Slice Machine (a local app run inside the website project) and the Legacy (custom type) Builder (hosted drag-and-drop JSON editor), with (a) the **Type Builder**, a cloud modeling UI inside the repository, and (b) the **Prismic CLI** (`npx prismic`, npm package `prismic`), a code-first, agent-oriented tool that pulls/pushes models, generates TypeScript types and component files, and manages repository settings (locales, previews, tokens, webhooks, environments). Content writing by AI goes through the hosted **Prismic MCP server**.

**How it works / timeline.**
- 2026-02-20: `prismicio/cli` repo created (Apache-2.0); current release v1.24.0 on 2026-10-15 (GitHub API, `gh api repos/prismicio/cli`).
- 2026-05-22: blog "build a Prismic website with AI": "Prismic is now AI-native thanks to the Prismic CLI and skills" (https://prismic.io/blog/build-prismic-website-with-ai).
- 2026-06-08: Prismic CLI and Prismic MCP shipped (https://prismic.io/updates/cli, https://prismic.io/updates/mcp). "The Prismic CLI replaces the old prismic/prismic-mcp-server for AI-assisted slice coding." The old `prismicio/prismic-mcp-server` repo is archived.
- 2026-07-20: blog "How building with Prismic is changing, for you and your agents" (Benjamin Martin): "Slice Machine is no longer our recommended way to build"; "Slice Machine continues to exist; it just won't be maintained anymore"; "The new Type Builder UI does not have a labels editor"; Type Builder visible only to Admins; integration fields shown but not editable there (https://prismic.io/blog/how-building-with-prismic-is-changing).
- The phrase the coordinator asked about is an editor's note on an older post: "Today, you model slices with the Prismic CLI and Type Builder" (https://prismic.io/blog/how-we-built-the-prismic-blog, located via web search; post itself predates 2026 and describes Slice Machine).
- 2026-09/10: CLI v1.22.0 (2026-10-01) "turn on the Type Builder in `prismic init`" and `prismic slice upgrade-legacy`; v1.23.0 (2026-10-10) `prismic dev` (experimental: edit local models visually in the Type Builder, backed by a temporary model "release") (https://github.com/prismicio/cli/blob/main/CHANGELOG.md).
- `prismicio/slice-machine` repo is archived; npm `slice-machine-ui@2.21.6` (2026-09-18) and `@slicemachine/adapter-*` carry the deprecation message "Slice Machine is replaced by the Prismic CLI and the Type Builder. Existing projects are still supported." (npm registry).
- Docs: "Slice Machine is deprecated. … Existing projects still work. New projects must use the Type Builder." (`pages/slice-machine.md` § top caution). Legacy Builder: "no longer maintained and is only intended for older projects" (`pages/legacy-builder.md` § top caution). Glossary still says the Legacy Builder "will be deprecated in the future" (`pages/glossary.md` § Legacy Custom Type Builder) — the docs are inconsistent.
- Migration paths: Slice Machine → `npx prismic init` "Replaces `slicemachine.config.json` with `prismic.config.json`. Pulls models … Uninstalls Slice Machine and your project's adapter." (`pages/slice-machine.md` § Migrate to the Type Builder). Legacy Builder → `npx prismic init --repo <name>` (requires Administrator, Next/Nuxt/SvelteKit project), then `prismic slice list --legacy` / `prismic slice upgrade-legacy <slice> --from <type>` per legacy (type-embedded) slice, then `prismic push`; "Deploy your website at the same time as the push. After the push, the Content API returns the new content shape for every document as soon as anyone publishes." (`pages/legacy-builder.md` § Migrate to the Type Builder).
- Type Builder access: "open your repository in Prismic and click on the **Switch to type builder** button. The sidebar lists three categories: **Page types**, **Custom types**, and **Slices**" ; "Changes made in the Type Builder are saved directly to your Prismic repository." (`pages/type-builder.md` § Access the Type Builder, § Features). Includes the slice simulator "Preview" (`pages/slices.md` § How to simulate slices). Labels (rich-text custom labels) "cannot be configured in the Type Builder" (`pages/fields/rich-text.md` § Use labels). Responsive image sizes are Type-Builder-only ("not supported by the Prismic CLI", `pages/fields/image.md`).

**Requirements.**
- REQ-ADM-001 (P0) Provide a hosted, admin-only content-model editor (page types, custom types, shared slices + variations, fields) whose saves persist directly to the repository.
- REQ-ADM-002 (P1) Model source-of-truth must be syncable with a code repo: a CLI/API `pull` (remote → local files, deletes local extras) and `push` (local → remote, deletes remote extras), plus `status` diff. (Detailed CLI spec belongs to the modeling report.)
- REQ-ADM-003 (P2) Support a "dev session" in which local model edits and UI model edits are live-synced via a temporary draft (inferred from `prismic dev` source).
- REQ-ADM-004 (P2) Provide an upgrade path from legacy per-type (non-shared) slices to shared slices.

---

## 1. Accounts, dashboard and repositories

**What.** An account is a personal, always-free identity; a repository is "an isolated collection of content … pages, media, environments, translations, and settings" (`pages/glossary.md` § repository). One account can access many repositories; billing is per repository.

**How it works.**
- Sign-up with email + password or a third-party account; email verification link; then profile (display name, picture) "Other content managers will see your name and picture." (`pages/account-setup.md` § Create an account).
- Login system (2025): enforced one-time email verification, GitHub social login with account linking by same email, bot detection; "Support for more social login options is on the way" (https://prismic.io/updates/new-authentication-system). Auth backend is Auth0 (`pages/mcp.md` § Troubleshooting links `prismic-auth.eu.auth0.com/v2/logout`). No 2FA documented; a staff forum reply says 2FA "is only available through SSO login" (https://community.prismic.io/t/two-factor-authentication/8629, undated).
- Dashboard (`prismic.io/dashboard`) lists repositories, account settings, "Create a new repository" (`pages/account-setup.md` § Explore the dashboard). Pending invites also appear there (`pages/users.md` § Invite users).
- Profile page: edit name, photo, email, password (`pages/account.md` § Update your profile). Account deletion is manual via support chat after leaving/transferring all repositories (`pages/account.md` § Delete your account).
- Repository name/URL (`<repo>.prismic.io`) is permanent; display name and image editable (`pages/repository-settings.md` § General settings). Deletion: owner only, Settings > Danger Zone, type repo name to confirm, irreversible (`pages/repository-settings.md` § Delete a repository).
- Repository main nav: **Work** tab (page list), Planned (releases), Archive, Media Library, Settings (`pages/overview.md` § The page list; `pages/releases.md`; `pages/archive-pages.md`).

**Requirements.**
- REQ-ADM-005 (P0) Account model separate from repository model; one account ↔ many repositories with per-repo role.
- REQ-ADM-006 (P0) Email+password sign-up with mandatory email verification; profile with display name and avatar shown to collaborators.
- REQ-ADM-007 (P1) OAuth social login (at least GitHub) with linking by verified email.
- REQ-ADM-008 (P0) Dashboard listing accessible repositories, pending invitations, and "create repository".
- REQ-ADM-009 (P0) Immutable repository slug used as subdomain/API id; editable display name and image.
- REQ-ADM-010 (P0) Owner-only repository deletion with typed-name confirmation.
- REQ-ADM-011 (P2) Self-service account deletion (Prismic requires support; a clone can do better).
- REQ-ADM-012 (P1) TOTP 2FA for local accounts (gap in Prismic; inferred value for self-hosted).

## 2. Plans, pricing and limits

**What.** Billing is "per repository basis, not per account. Your account will always be free" (`pages/billing.md` § top). Six plans.

**How it works (https://prismic.io/pricing, yearly per-repository prices).**

| Plan | Price/mo (yearly) | Users | Locales | API calls/mo | CDN bandwidth/mo | Bandwidth overage |
|---|---|---|---|---|---|---|
| Free | $0 | 1 | 2 | 4M, no overage | 100 GB, no overage | — |
| Starter | $10 | 3 | 3 | 4M | 100 GB (overage to 500 GB) | $0.30/GB |
| Small | $25 | 7 | 4 | 4M | 100 GB (to 500 GB) | $0.30/GB |
| Medium | $150 | 25 | 5 | 5M, no overage | 500 GB (to 1 TB) | $0.30/GB |
| Platinum | $675 | Unlimited | 8 | 10M (overage to 20M on yearly) | 1 TB (to 5 TB) | $0.25/GB |
| Enterprise | Custom | Unlimited | Custom | Custom | Custom | Custom |

- All plans: unlimited documents, content types, slices, assets; releases, spaces, previews, scheduling, revision history, Visual Page Builder + live editing, Migration API, Document API, GraphQL, webhooks; "AI features (beta)" "Upon request" (pricing page).
- Integration-field SKUs: 100 included on Free–Small ("no overages"); Medium/Platinum $1 per extra 100 (caps 500 / 500 monthly–10,000 yearly). Hard cap "Each repository supports up to 100,000 catalog items" (`pages/fields/integration.md` § top).
- User roles from Medium; custom roles Enterprise; "In Small and Starter plans, all users are Administrators" (`pages/users.md` § Repository roles). Inviting users starts at Starter (`pages/users.md` § Invite users).
- Development environment: Platinum paid option "$3000/year" on yearly invoice; Enterprise includes "2 development environments" (pricing page; `pages/environments.md` § top).
- Enterprise only: SSO, backups, CSM, training, infosec/legal review, priority support (pricing page).
- Limit enforcement: "When a repository reaches its plan limits (**API Call** or **Bandwidth**), it automatically upgrades to the next plan tier"; API calls have no overages; "Free plans don't allow overages … the repository will be locked" (`pages/billing.md` § Plan limits and automatic upgrades). **Spend Manager** (Settings → Usage Dashboard, announced 2026-01-20): auto-upgrade on (default) or off: "Content delivery stops, but you're never charged more than you've agreed to"; yearly plans may switch to monthly on upgrade (https://prismic.io/updates/spend-manager; `pages/billing.md`).
- Downgrade allowed only if current usage (API/CDN, users, locales) fits the target plan; usage resets each monthly cycle (`pages/billing.md` § Downgrade your plan).
- Payments: card via Stripe-hosted portal; bank transfer for annual Platinum+/Enterprise; failed payments retried up to 8 times; annual renewals refundable within 30 days (`pages/billing.md` § Payment methods, § Keeping billing up to date, § Refunds). Billing emails go to the repository owner only (`pages/billing.md` § Change Billing Email).
- **Usage Dashboard**: API requests, CDN bandwidth, integration-field requests with colour-coded status, date filter, CSV export (Timestamp, Type, Quantity, Source, Referrer); data lags up to 24 h (`pages/billing.md` § Usage dashboard). Usage notification emails (2025-03-14) and in-app usage banners (2025-02-28) (https://prismic.io/updates).

**Requirements (self-hosted clone).**
- REQ-ADM-013 (P1) Configurable per-repository quotas (users, locales, environments, integration items) enforced at invite/locale-add/catalog time; plan tiers become admin-set limits (inferred adaptation).
- REQ-ADM-014 (P1) Usage metering of API requests and CDN/asset bandwidth per repository with a dashboard, date filter and CSV export.
- REQ-ADM-015 (P2) Threshold notifications (in-app banner + email) and a "hard limit: stop delivery vs. continue" policy switch.
- REQ-ADM-016 (P2) Billing/Stripe integration is out of scope for self-hosted core; keep a pluggable hook (inferred).

## 3. Users, roles, SSO

**What.** Repository-level roles plus optional per-space/per-locale custom roles.

**How it works.**
- Invite by email with a role (Settings > Users); invite email + dashboard pending invite; remove button (`pages/users.md` § Manage users).
- Repository roles (`pages/users.md` § Repository roles):
  - **Writer**: "Create and edit pages and releases".
  - **Publisher**: Writer + "Publish and delete pages and releases".
  - **Administrator**: Publisher + create/edit page types and slices, edit settings, manage user roles, manage custom roles per locale in spaces (Enterprise), billing.
  - **Repository Owner** (one): Admin + transfer ownership + delete repository.
  - **Contributor** (Enterprise): how Writers/Publishers appear when custom roles are active; real permissions live in Space settings > User roles.
  - MCP docs call the publisher role "Publisher (Manager)" (`pages/mcp.md` § Write); legacy name "Manager" (pricing page lists Medium "User roles").
  - Create-pages mentions "Read-only users can view pages but cannot edit or publish them" (`pages/create-pages.md` § Save a draft).
- Custom roles (Enterprise add-on, 2025-03-18): per space (and per locale within a space) assign Read-only / Writer / Publisher to individuals or "Everyone in the repository"; "By default, all the users are grouped together with the read-only role"; Admins/Owner bypass restrictions (`pages/users.md` § Custom roles; `pages/organize-pages.md` § Per-space user permissions; https://prismic.io/updates/custom-roles).
- Publishing a release spanning spaces needs Publisher in every space involved (`pages/releases.md` § Publish across multiple spaces).
- Ownership transfer: free plan via email acceptance; paid plans immediate; billing stays on the repo (`pages/users.md` § Transfer ownership).
- SSO (Enterprise): OAuth2 IdPs "including Google, Okta, Microsoft Entra ID, and Auth0", set up via support (`pages/users.md` § SSO). GitHub repo `prismicio/self-service-sso` exists (2025) (GitHub org listing).
- Admin-only surfaces: Type Builder, Settings (webhooks, API keys, locales), environments, integration fields, MCP toggle (`pages/onboard-content-managers.md` § Give users appropriate roles; `pages/environments.md`; `pages/mcp.md` § Activate).

**Requirements.**
- REQ-ADM-017 (P0) Roles Owner(1)/Administrator/Publisher/Writer/Read-only with the permission matrix above enforced in UI and API.
- REQ-ADM-018 (P0) Email invitations with role, pending state, revoke, remove member.
- REQ-ADM-019 (P1) Ownership transfer (accept flow) with exactly one owner invariant.
- REQ-ADM-020 (P1) Per-space and per-space×locale role overrides (Read-only/Writer/Publisher) with "everyone" default; admins exempt.
- REQ-ADM-021 (P1) Release publish authorization = Publisher on every space touched by the release.
- REQ-ADM-022 (P1) SSO via OIDC/OAuth2 (Google, Okta, Entra ID, generic). Enterprise-only in Prismic, but core for self-hosting.
- REQ-ADM-023 (P2) Audit log of role/settings changes (not documented by Prismic; inferred need).

## 4. Repository settings (admin UI)

**What / How.** Settings panel sections (`pages/repository-settings.md`):
- General: Repository (display name/image), Users, Plans & Billing, Usage Dashboard.
- Environments (Platinum add-on / Enterprise).
- Configuration: **API & Security** (API access level + access tokens + write tokens), **Previews**, **Integration Fields**, **Translations & Locales**, **Webhooks**; plus **Prismic MCP** toggle (`pages/mcp.md` § Activate Prismic MCP) and Danger Zone.
- API access levels (`pages/fetch-content.md` § Content visibility, CLI `repo set-api-access private|public|open`): Open API (published + releases public), "Public API for Master only" (default; releases need token), Private API (all need token). Access tokens for reads; tokens may be created with release access (`npx prismic token create --allow-releases`, `pages/with-lokalise.md`); write tokens are "an administrator credential" for Types/Asset/Migration APIs, CLI and MCP (`pages/repository-settings.md` § Write tokens; `pages/cli.md`).
- Webhooks UI: list, create (URL, name, secret, triggers documentsPublished/Unpublished, releasesCreated/Updated, tagsCreated/Deleted), "Trigger it" test button, per-webhook logs and a Logs tab covering 30 days, auto-disable after five consecutive failures; retry every 10 min up to 5 times (`pages/webhooks.md` § Events, § Recent triggers are logged; CLI `src/commands/webhook-create.ts`). Payload spec is in the API report.
- Previews UI: list of named preview URLs (one per website address), single slice-simulator URL; also editable from any document via "**...**" → **Live preview settings** (`pages/previews.md` § Set up previews; `pages/nextjs.md` § Live previews in the Page Builder).
- API Explorer at `/builder/explorer` (visual query builder, client snippets, shareable links, orderings) (https://prismic.io/updates/api-explorer; `pages/glossary.md` § API Explorer). GraphQL explorer at `/graphql` is "deprecated … legacy use" (`pages/glossary.md` § GraphQL API).

**Requirements.**
- REQ-ADM-024 (P0) Settings area restricted to Administrators/Owner.
- REQ-ADM-025 (P0) API visibility switch with the three levels above; read access tokens (master-only vs master+releases) and write tokens, create/list/revoke.
- REQ-ADM-026 (P0) Webhook management UI: CRUD, per-trigger checkboxes, optional secret, enable/disable, test trigger, delivery log (30 days), retry policy, auto-disable.
- REQ-ADM-027 (P0) Preview configuration UI: multiple named preview URLs + one slice-simulator URL.
- REQ-ADM-028 (P1) Built-in API explorer for the content API.
- REQ-ADM-029 (P1) Integration-field catalog admin (pull endpoint with optional Basic token, push catalog with bearer tokens, Shopify); details in API report.
- REQ-ADM-030 (P2) Per-repository toggle for AI/MCP access.

## 5. Environments (UI side)

**What.** "Environments allow you to modify content models without affecting production content." An environment "clones content from your production repository into a new repository": models, pages, media; **not** users (shared), integration catalogs (shared), webhooks (`pages/environments.md` § top).

**How it works.** Settings > Environments (owner/admin): Name (also determines URL) + base environment to clone → "Create a new environment" → async sync; usable when synced. **Resync** button overwrites "all existing development content and its models". CLI `env list|set|active|unset`; `env set` writes `NEXT_PUBLIC_PRISMIC_ENVIRONMENT` / `NUXT_PUBLIC_…` / `PUBLIC_PRISMIC_ENVIRONMENT` into `.env.local`; `pull`/`push` target the active env. Not meant for staging content: "content writers stay on the production repository" and use releases + previews (`pages/environments.md` § How to create, § Local development, § Resync, § FAQs). MCP has a separate per-environment toggle (`pages/mcp.md` § Activate).

**Requirements.**
- REQ-ADM-031 (P1) Create an environment by cloning a base repository (models, documents, media) into a sibling repository whose slug derives from its name; share users and integration catalogs; exclude webhooks.
- REQ-ADM-032 (P1) Async clone/resync job with progress state; resync is destructive overwrite from base.
- REQ-ADM-033 (P1) Environment selector in the UI and environment-addressable APIs/CLI.

## 6. Page list, search, spaces, tags (organize)

**What.** The **Work** tab is the page list; plus spaces, tags, filters, bulk actions (`pages/organize-pages.md`).

**How it works.**
- List shows display name, page type, status; statuses **Draft** ("Unpublished changes exist"), **Live**, **Archived**; sorted by most recently modified (`pages/organize-pages.md` § Navigate the dashboard, § Search for pages).
- Filters: type, language (locale switcher top-left / left sidebar), status (draft/published/release/archived), tags (match all selected), author (published or saved the page) (`pages/organize-pages.md` § Search; https://prismic.io/updates/new-search).
- Search ranks page names (exact > prefix > contains > fuzzy) then UID; ties by recency; same ordering in the link-field picker; full body text not documented as searched (https://prismic.io/updates/new-search). Page list rebuilt for speed 2024-11-04 (https://prismic.io/updates/new-page-list).
- **Display name**: default from content ("usually the first heading"); editable inline at top-left of editor (`pages/organize-pages.md` § Page display name). Migration API `title` sets it (`pages/migration-api-technical-reference.md`).
- **Spaces**: group pages by page type in the sidebar; default "Main Space"; admin creates, names, assigns types; "A page type can belong to one space at a time"; media library is repository-wide (`pages/organize-pages.md` § Spaces). Available to all repositories (https://prismic.io/updates/spaces).
- **Tags**: free-text, typed in the Tags bar at top of the middle panel, Enter to add, applied on save (`pages/organize-pages.md` § Add tags to pages). Tags API lists tags from published + release + draft pages (`pages/tags-api-technical-reference.md`).
- **Bulk actions** from the list: Publish, Archive, Delete (archived only), Copy to another locale ("Duplicate into other locales or releases") (`pages/organize-pages.md` § Bulk actions).

**Requirements.**
- REQ-ED-001 (P0) Page list with columns display name/type/status/locale/updated, default sort by last modified, pagination/virtual scroll.
- REQ-ED-002 (P0) Filters: type, locale, status (draft, live, in-release, archived), tags (AND), author.
- REQ-ED-003 (P0) Title/UID search with ranking exact > prefix > contains > fuzzy, recency tiebreak; reuse in link pickers.
- REQ-ED-004 (P0) Editable per-page display name with automatic default from first heading/text.
- REQ-ED-005 (P1) Spaces: admin-defined groups of page types (each type in ≤1 space), default space, sidebar navigation.
- REQ-ED-006 (P0) Page tags: add/remove free-text tags in editor; tags list endpoint.
- REQ-ED-007 (P1) Bulk publish / archive / delete-archived / copy-to-locale on multi-selection.
- REQ-ED-008 (P2) Full-text body search in the page list (Prismic gap; inferred).

## 7. Page Builder (document editor)

**What.** "The Page Builder is an interactive interface with fields and controls to build pages" (`pages/create-pages.md` § Page Builder).

**How it works.**
- Layout: **left sidebar** live slice previews; **middle** fields incl. slice fields; **right sidebar** version + localization info (`pages/create-pages.md` § Page Builder). Editor enlarged 2024-04-24 (https://prismic.io/updates/largerpb).
- Create: "Create a new page" (top-right of list) → choose page type dialog (types defined by developer) → editor; static-zone fields at top; tabs at top of editor (e.g. "SEO & Metadata") (`pages/create-pages.md` § Create a page; `pages/nextjs.md` § SEO lists `meta_title`, `meta_description`, `meta_image` auto-added to page types; `pages/content-modeling.md` § Page types "includes … SEO and … UID fields by default"). Single types: only one document may exist (`pages/content-modeling.md`).
- UID: auto-filled from content when empty; lowercase, no spaces, only `-`/`_` specials; unique per type+locale; previous UIDs retained as aliases until reused (`pages/page-fields.md` § UID field; `pages/fields/uid.md`).
- Slices: "+"/**Add slice** opens picker (with developer screenshots per variation), choose variation; reorder by drag or Move Up/Down; Copy/Paste via menu or Cmd/Ctrl+C/V; Delete (`pages/create-pages.md` § Build pages with slices). Multi-select with Shift and paste "into any page where those slices are available"; paste fails if the target type lacks the slice (https://prismic.io/updates/copy-paste-slices).
- In-editor find: Cmd/Ctrl+F searches text "even if your slice is not in focus" (https://prismic.io/updates/cmd-f).
- Field UIs (`pages/page-fields.md`): boolean toggle; colour picker (hex); content relationship picker restricted to allowed type; date picker; embed (paste oEmbed URL); geopoint (coords or Google Maps URL); image (upload/library/crop, alt text); integration picker; link (page/web/media, with display text, variant, new-tab, repeatable); link to media; number; repeatable group (add/remove/reorder items); rich text toolbar (bold, italic, headings, lists, links, images, embeds; the subset is configured by the developer); select dropdown; table (add/remove rows/cols, formatted cells); text; timestamp. Empty image fields are drop zones (changelog 2025-02-10); link search flags archived/deleted targets as broken (changelog 2025-02-18) (https://prismic.io/updates/changelog).
- Save model: "With autosave enabled, changes save automatically … **Saved** indicator"; "Without autosave, click **Save** … The editor shows **Unsaved draft** until you save" (`pages/create-pages.md` § Save a draft). Autosave is waitlist / "In progress" (https://prismic.io/updates/autosave). "Drafts are only visible to you and other editors" (`pages/begin-creating.md` § Save a draft).
- Role gating: Save/Publish unavailable per role (`pages/create-pages.md` § Save a draft).
- Collaboration: **Status indicator** (2025-06-05) "shows you who's currently editing a document" (https://prismic.io/updates/status-indicator). Real-time co-editing "In progress"; Commenting "Next" (https://prismic.io/updates). Toolbar v5 (2026-10-15) source contains comment-pin and avatar overlays in the embedded preview ("Powers the Page Builder's live previews: in-place updates, comments, and slice selection") (https://github.com/prismicio/prismic-toolbar README; commits 2026-10-08..16); comments are being built (inferred). No document locking documented.
- Live editing: per-slice live thumbnails rendered by the site's `/slice-simulator` route in iframes, content sent via `postMessage` (`pages/previews.md` § How live previews work); toolbar v5 adds slice highlight/labels, synced slice selection and scrolling (prismic-toolbar commits 2026-10-06/08) (inferred: visual on-page editing surface). Pricing lists "Visual Page Builder and live editing" on all plans.
- AI in editor (beta/waitlist): SEO metadata assistant (titles/descriptions, char-count validation) (https://prismic.io/updates/seo-metadata-assistant); Translate with AI (§10).

**Requirements.**
- REQ-ED-009 (P0) Three-pane editor: slice list with live thumbnails / field form with tabs / side panel for versions, locale, release.
- REQ-ED-010 (P0) Create page from type picker; enforce single-type uniqueness per locale.
- REQ-ED-011 (P0) Form controls for every field type listed, honouring model config (allowed rich-text blocks, select options, CR type filter, link restrictions, image responsive views, min/max).
- REQ-ED-012 (P0) Slice zone ops: add (with variation + screenshot picker), reorder (drag + menu), duplicate, delete, switch variation.
- REQ-ED-013 (P1) Clipboard copy/paste of one or many slices across pages of types that allow them.
- REQ-ED-014 (P0) Explicit Save producing a draft version; draft states visible in list.
- REQ-ED-015 (P1) Autosave with Saved indicator (repository-level toggle).
- REQ-ED-016 (P0) UID auto-generation from content + validation + uniqueness per type×locale + old-UID aliasing.
- REQ-ED-017 (P1) Presence indicator showing who is editing a document.
- REQ-ED-018 (P2) Real-time co-editing (CRDT) and inline comments with notifications (Prismic roadmap).
- REQ-ED-019 (P1) In-editor find (Ctrl/Cmd+F) across all fields.
- REQ-ED-020 (P1) Broken-link flagging in link/CR fields when targets are archived/deleted.
- REQ-ED-021 (P2) AI SEO metadata suggestions.

## 8. Previews (editor side)

**How it works.** "Preview the page" (bottom-right) → choose a configured preview (e.g. Production) → new tab; Prismic issues a temporary ref and sets the preview cookie (named `io.prismic.preview` in `@prismicio/client` `src/cookie.ts`; docs text says "`preview.prismic.io` cookie"); site's preview route resolves `token` + `documentId` query params to the page URL (`pages/previews.md` § How full-website previews work; `prismic-client/src/Client.ts` `resolvePreviewURL`). Toolbar (bottom-left; script `https://static.cdn.prismic.io/prismic.js?new=true&repo=<repo>`) lists previewed pages, links back to the editor, "Get a shareable link" (anyone, no login; "temporary and expire"), exit button (`pages/previews.md` § Prismic toolbar, § Share previews; prismic-toolbar README). Toolbar dispatches `prismicPreviewStart/Update/End` window events. Whole releases can be previewed (`pages/releases.md` § Preview all changes).

**Requirements.**
- REQ-ED-022 (P0) Per-document preview launcher over configured preview URLs with temporary draft ref + cookie handoff.
- REQ-ED-023 (P0) Embeddable toolbar script: list previewed docs, edit link, exit, live refresh events.
- REQ-ED-024 (P1) Shareable, expiring, unauthenticated preview links.
- REQ-ED-025 (P0) Release-level preview.

## 9. Publishing lifecycle: publish, archive, delete, history, releases

**What.** A page moves through Draft → Live → (Archived) → (Deleted); releases bundle changes; history keeps every version.

**How it works.**
- **Publish**: "click **Publish** in the top-right corner"; live "within seconds"; status changes from "Draft" to "Published"; further edits stay drafts until republished (`pages/create-pages.md` § Publish a page; `pages/begin-creating.md` § Publish). Only Publishers, Administrators, Owners publish (`pages/releases.md` § Publish a release). Each publish creates a new master ref (`pages/repository-api-technical-reference.md`); "Prismic keeps the six most recent refs" (`pages/glossary.md` § ref). Model changes surface in the Content API only after at least one publish/archive (`pages/content-modeling.md` § Impact of pushing changes).
- **Archive = unpublish**: "**Unpublish** purple button … or … **Archive this page**"; archived pages excluded from the API; only manual (`pages/archive-pages.md` § Archive a page; `pages/glossary.md` § archiving). Saving an archived page returns it to **Work** as a draft; publish to restore (`pages/archive-pages.md`).
- **Delete**: only from the Archive tab, multi-select + trash; "Deleting a page is irreversible" (`pages/archive-pages.md` § Delete a page). Links to deleted/archived pages become broken (`isBroken: true`, `brokenRoute`) (`pages/routes.md` § Broken routes).
- **History**: "View History" under the title; every version with published status, author, date; diff vs previous version (red deleted / green added; arrows to step through changes; image slider compare); **Restore** reverts as unsaved draft, then Save + Publish (`pages/create-pages.md` § Page history). MCP `list_document_versions` covers "drafts, published, archived, and release versions" (`pages/mcp.md` § Discovery).
- **Releases** (`pages/releases.md`): managed in the **Planned** tab; create via "Add Release" or from the editor (Save → calendar icon next to Publish → "Create a new release" with name + optional schedule) or "Add to existing release"; create new pages directly inside a release; preview whole release; schedule date/time ("Not scheduled yet" button); publish now (confirm); delete (new pages archived, changes discarded, originals untouched); "Releases can contain up to 200 pages"; "Unpublishing pages in a release is not currently supported" (though the doc lists "Page deletions with corresponding link updates" as a use case). Release refs appear in the Repository API with `scheduledAt`; publishing a release fires a "release deleted" webhook (`pages/webhooks.md`). Newly created releases sort to top (changelog 2025-09-30). Content writers can link to pages that exist only in a release (`pages/onboard-content-managers.md` § Do a walk-through).
- **Migration releases**: Migration API / MCP writes land in a "Migration Releases" tab or a named release; publishable from UI or `publishMigrationRelease()`; MCP writes always go to a release, MCP cannot delete ("nothing is ever deleted (only archived)") and publishes only on explicit request with Publisher rights (`pages/migration-api-technical-reference.md`; `pages/mcp.md` § Write; https://prismic.io/updates/mcp). "A release holds up to 1,000 pages" (`pages/migration.md` § Import) vs 200 (`pages/releases.md`).
- **Scheduling** is release-based only (no per-page schedule documented).
- **Duplicate page**: no standalone "duplicate" action documented; duplication occurs via "Copy to another locale" (into locales or releases) (`pages/organize-pages.md` § Bulk actions) (inferred).

**Requirements.**
- REQ-ED-026 (P0) Publish action creating an immutable published version and a new global content ref; role-gated.
- REQ-ED-027 (P0) Unpublish/archive and restore-from-archive-as-draft; delete only from archive, permanent.
- REQ-ED-028 (P0) Version history per document with author/date/status, field-level diff (text, image crop compare), and restore-as-draft.
- REQ-ED-029 (P0) Releases: CRUD, add/remove documents (new or edited), per-release ref, preview, publish atomically, delete semantics as above, cap (configurable, default ≥200).
- REQ-ED-030 (P0) Scheduled release publication at a timestamp, executed server-side; webhook events on create/update/delete/publish.
- REQ-ED-031 (P1) Release-only pages linkable from other release pages.
- REQ-ED-032 (P1) Separate "migration release" bucket for API/agent writes with bulk publish.
- REQ-ED-033 (P2) Unpublish-in-release and per-page scheduling (Prismic gaps).
- REQ-ED-034 (P1) Explicit "duplicate page" action (same locale) (inferred gap).

## 10. Localization

**What.** Locales = language-region pairs (`en-us`, `fr-ca`); one master locale; localized versions of a page share fields/slices and are linked (`pages/localization.md`; `pages/locales.md`).

**How it works.**
- Settings > Translations & Locales (owner/admin): add from dropdown or **Add custom locale** (language, region, code); **Set as master** (default in Page Builder and API); remove only after deleting all pages in that locale (trash icon) (`pages/localization.md` § Add a locale, § Set the master locale, § Remove a locale). CLI `locale list|add [--name]|remove|set-master` (`pages/locales.md` § Manage locales; CLI command list). Locale counts are plan-limited (§2); "Translations and locales usage page" (2024-12-20).
- Navigation: locale dropdown inside a page jumps to that page's translation; locale dropdown on page list filters (`pages/localization.md` § Select a locale).
- **Copy to another locale**: from editor right sidebar or bulk from list; option "Copy all content" or **Translate with AI** (keeps formatting, structure, internal links; custom instructions; glossary rules applied automatically); "Each repository includes five free translations" + 5 after feedback form; unlimited via sales (`pages/localization.md` § Copy pages to another locale; https://prismic.io/updates/translate-with-ai).
- Linking: translations linked at creation (`alternate_language_id`); "Alternate language pages can only be linked to their master language documents when creating them" (`pages/migration/programmatic.md` § Create alternate language documents). API exposes `lang` and `alternate_languages` (`pages/locales.md` § Locales in the API).
- UID unique per type×locale (`pages/page-fields.md` § UID). Alt text may differ per locale (`pages/media.md` § Add alt text).
- Permissions per locale via Enterprise custom roles (§3).
- External TMS: Lokalise recipe uses a "Lokalise" release + `releasesUpdated` webhook + Migration API write-back (`pages/with-lokalise.md`, draft guide, Text/Rich Text only).

**Requirements.**
- REQ-L10N-001 (P0) Locale registry per repository with standard + custom codes, display names, one master locale, add/remove (remove blocked while pages exist).
- REQ-L10N-002 (P0) Document translation groups: each document has a locale and belongs to a group linking alternates; created via "copy to locale".
- REQ-L10N-003 (P0) Locale switcher in editor and list; master locale default everywhere.
- REQ-L10N-004 (P0) Copy-all-content to target locale (single + bulk), optionally into a release.
- REQ-L10N-005 (P1) Per-locale role restrictions (with spaces).
- REQ-L10N-006 (P2) Machine/AI translation with instructions + glossary, pluggable provider and quota.
- REQ-L10N-007 (P1) Allow relinking/unlinking translations after creation (Prismic gap; inferred).
- REQ-L10N-008 (P1) Locale-count quota enforcement (ties to REQ-ADM-013).

## 11. Media library

**What.** "Prismic's built-in asset manager for images, videos, and other files" accessible from the sidebar and from image/link/link-to-media fields; repository-wide, not space-scoped (`pages/media.md` § Media library; `pages/organize-pages.md` § Spaces).

**How it works.**
- Add: upload from computer, pick existing, or "choose a free stock photo from Unsplash"; drag multiple files for bulk upload (sequential background upload); Asset API: one asset per request, 1 req/s (`pages/media.md` § Add a file, § Bulk upload; `pages/asset-api-technical-reference.md` § Limits).
- Formats/limits: images PNG, JPEG, WEBP, GIF, JPE, JPG, ICO, JFIF up to **10 MB**; other files incl. video up to **100 MB**; video hosting discouraged (bandwidth) (`pages/media.md` § Supported formats, § Video hosting).
- Metadata: title, alt text, copyright/credits, private notes (≤500 chars each via API), tags (`pages/media.md` § Add metadata; https://prismic.io/updates/configurable-media-attributes; Asset API PATCH). Library alt text is the default for new usages; per-page/per-locale/per-view override; library edits do not propagate to existing usages (`pages/media.md` § Add alt text).
- Search/filter: by name/metadata (keyword over title, filename, alt, notes, credits — Asset API `keyword`), file type, uploader/author, tags; bulk tag; bulk delete (2024-06-07) (`pages/media.md`; https://prismic.io/updates/tagging-and-filtering; https://prismic.io/updates/filter-by-author-and-media-type; https://prismic.io/updates/bulk-delete).
- Delete: removes from library but "leaves it accessible at its direct URL. Pages that use the asset will continue using the asset"; CDN purge only via support (`pages/media.md` § Delete a file). API note: deleting assets in published pages "will result in broken files" (`pages/asset-api-technical-reference.md` § DELETE), which conflicts.
- Image editing in field: crop icon → width, height, zoom; per responsive view crops; stored as `edit {x,y,zoom,background}` (`pages/media.md` § Edit an image; `pages/migration-api-technical-reference.md` § Image). No focal-point feature documented.
- Delivery: images served via imgix with `auto=compress,format` (usually AVIF), any imgix param via URL; GIF→animated WebP (`pages/fields/image.md` § Images are automatically compressed). Bandwidth counts toward plan.
- Migration dedupes identical source files (`pages/migration/programmatic.md` § Create assets); MCP `upload_asset` fetches from URL (`pages/mcp.md`).

**Requirements.**
- REQ-MED-001 (P0) Repository-wide asset store with upload (picker + drag-drop multi), list/grid, open-from-field picker.
- REQ-MED-002 (P0) Configurable size limits (defaults 10 MB images / 100 MB other) and MIME allow-list.
- REQ-MED-003 (P0) Asset metadata: title/filename, alt, credits/copyright, notes, tags; editable singly and bulk-tag.
- REQ-MED-004 (P0) Search by keyword across filename/title/alt/notes/credits; filters by kind, uploader, tags; cursor pagination.
- REQ-MED-005 (P0) Image transform CDN (imgix-compatible URL params: w, h, fit, crop rect, auto=compress,format, etc.) with automatic modern-format negotiation.
- REQ-MED-006 (P0) In-field crop/zoom/background per responsive view, stored non-destructively.
- REQ-MED-007 (P1) Delete and bulk delete with explicit policy for in-use assets (warn + choose keep-URL vs purge) and a CDN purge capability.
- REQ-MED-008 (P1) Default alt text from library, overridable per usage/locale without back-propagation.
- REQ-MED-009 (P2) Stock-photo provider integration (Unsplash).
- REQ-MED-010 (P2) Focal-point and usage ("where used") tracking (not in Prismic; inferred).
- REQ-MED-011 (P1) Content-hash dedupe on import.

## 12. Integrations, AI & migration (product side)

**How it works.**
- Officially supported frameworks: Next.js, Nuxt, SvelteKit only; Express, Gatsby, Java, plain JS, Laravel, .NET, PHP, React-without-Next, Ruby, Vue-without-Nuxt are unsupported (some community-maintained) (`pages/unsupported-integration.md`). SvelteKit 3 support 2026-10-15 (https://prismic.io/updates).
- Integration guides: Shopify (built-in catalog via Admin API creds, collections via custom catalog), HubSpot forms (custom catalog), Cloudinary images/videos (custom catalog; Prismic still recommends built-in media) (`pages/with-shopify.md`, `pages/with-hubspot.md`, `pages/with-cloudinary.md`); Clay enrichments create AI-personalized landing pages into a "Clay Landing Pages" release via write token + base document ID (`pages/with-clay.md`); Lokalise (§10).
- AI surface: Prismic MCP (`https://mcp.prismic.io/mcp`, OAuth or write-token bearer; tools list_repositories, list_custom_types, list_shared_slices, list_locales, list_releases, list_document_versions, search_documents, search_assets, get_document, get_custom_type, get_shared_slice, create_release, create_document, update_document, upload_asset, publish_release; on by default for new repos; admin toggle) (`pages/mcp.md`); free on every plan (https://prismic.io/updates/mcp). Agent skill `prismicio/skills`. Marketing AI: SEO / ABM landing-page builders, image-to-slice (beta, 2025-03-31, now done by agents per July 2026 blog) (https://prismic.io/features/ai).
- Migration: recommended path is an AI agent (export → model with CLI → import into releases with MCP, idempotent reruns, two-pass link resolution, sample import first) (`pages/migration.md`); programmatic path via Migration/Asset APIs and `@prismicio/client` `migrate()` (≤1,000 docs per migration release, batch per locale) (`pages/migration/programmatic.md`); WordPress mapping table (`pages/from-wordpress.md`). Legacy import/export deprecated 2024-04-30 (https://prismic.io/updates).
- Support: Community forum, in-app "Fin" chat, status page `status.prismic.io` (`pages/help-center.md`).

**Requirements.**
- REQ-ADM-034 (P1) Expose an MCP server (search/read/create/update into releases, upload asset, publish release on explicit request, no delete) with per-user OAuth and token auth.
- REQ-ADM-035 (P1) Bulk import tool producing a reviewable import release, idempotent by external id, with asset dedupe and deferred link resolution.
- REQ-ADM-036 (P2) Full repository export/import (Prismic deprecated it; important for self-hosted backups; inferred).
- REQ-ED-035 (P2) "Personalized variant" generation from a base document into a release (Clay-style; inferred API pattern = create_document from template).

## 13. Open questions / ambiguities

1. Release size limit: 200 pages (`pages/releases.md`) vs "A release holds up to 1,000 pages" (`pages/migration.md`) and 1,000 per migration release (`pages/migration/programmatic.md`). Different limits for migration releases?
2. Preview cookie name: docs say `preview.prismic.io`; client source uses `io.prismic.preview`. Clone should follow the SDK value.
3. Role names: "Publisher" vs legacy "Manager" (`pages/mcp.md` "Publisher (Manager)"); Read-only exists as repository role? Users page lists only Writer/Publisher/Admin/Owner/Contributor, yet create-pages mentions Read-only users.
4. Which plans have roles: pricing says "User roles" from Medium; users page says Small/Starter are all Administrators; Free has one user. Exact Medium role set unclear.
5. Asset deletion semantics: media guide says URL keeps working; Asset API says published pages get broken files.
6. Autosave availability: docs describe it as a per-repository state, updates page says waitlist/in progress. Who toggles it?
7. Unpublishing in releases: "not currently supported" yet "Page deletions with corresponding link updates" is listed as a release use case.
8. Nested repeatable groups: docs say not allowed; `@prismicio/client` model types allow one nested level (`CustomTypeModelNestedGroupField`). (Modeling report to resolve.)
9. Type Builder availability: docs say Legacy Builder users can migrate via `prismic init` (Oct 2026); July blog said legacy users "aren't supported in the new Type Builder yet". Assume resolved by CLI v1.22.0.
10. Comments/real-time collaboration: roadmap only; toolbar v5 code has comment overlays; scope and data model unknown.
11. 2FA: not offered outside SSO per old forum post; current status undocumented.
12. Page duplication (same locale) and document locking: undocumented; assume absent.
13. Environments: does an environment count against user/locale quotas, and do media URLs differ per environment? Not documented.
14. Spend Manager labelled "In progress" while billing docs describe it as live.
