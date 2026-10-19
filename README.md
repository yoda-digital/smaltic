# Smaltic

Smaltic is a self-hosted headless CMS with Prismic-compatible HTTP APIs. You point the official SDKs
(`@prismicio/client`, its WriteClient, `@prismicio/custom-types-client`) at your own server and use
them unmodified.

> Smaltic is an independent project. It is not affiliated with, endorsed by or sponsored by Prismic.
> "Prismic" is used here only to describe API compatibility.

## Project status

Smaltic is at **Plan 1 of 7** of the [roadmap](docs/superpowers/plans/2026-10-19-smaltic-roadmap.md).
Plan 1 is a headless server with no editor UI yet. What it covers:

- Content API v2: `/api/v2`, `/api/v2/documents/search` with all 28 filters, orderings, `after`,
  `fetchLinks`, `graphQuery`, `routes` and `brokenRoute`, plus the Tags API.
- Refs: master refs, historic refs, release refs and preview tokens (including the toolbar's JSON cookie value).
- Access control: public, private and open repositories, and access tokens scoped to master or to master plus releases.
- Write APIs: Custom Types API, Migration API and Asset API (upload, metadata, tags; originals are served as-is).
- A `smaltic` admin CLI to create repositories, locales, tokens and users.

Not built yet: the Studio (editor and admin UI), GraphQL, image transforms, the preview toolbar bridge,
webhooks and environments. Releases other than the migration release cannot be created over HTTP yet.
The [parity matrix](docs/research/parity-matrix.md) lists every requirement. It is `done` when passing
compat tests cover all of it and `partial` when they cover only some of it. The research is in [docs/research/REA.md](docs/research/REA.md).

## Quickstart (Docker)

You need Docker with Compose.

```sh
# 1. A secret for signing preview tokens (at least 32 characters). Keep it stable across restarts.
#    Appends to .env only if no secret is set there yet.
grep -qs '^SMALTIC_SECRET=' .env || echo "SMALTIC_SECRET=$(openssl rand -base64 48)" >> .env

# 2. Start Postgres and the server. Migrations run on startup.
docker compose up -d --build
curl -fsS localhost:8080/health        # {"status":"ok"}

# 3. Create a repository and tokens.
docker compose exec smaltic node dist/cli.js create-repo blog
docker compose exec smaltic node dist/cli.js create-token blog --kind write    # prints a write token
docker compose exec smaltic node dist/cli.js create-token blog --kind access   # prints an access token
```

Uploaded files go to `./data`. Postgres data lives in the `dbdata` volume.

If `SMALTIC_SECRET` is missing or shorter than 32 characters, the server exits at startup with a message
saying so. Compose restarts it at most 3 times (`restart: on-failure:3`) and then leaves it stopped, so
check `docker compose logs smaltic` when `/health` does not answer.

### Read content with the official client

```ts
import { createClient } from "@prismicio/client";

const client = createClient("blog", { documentAPIEndpoint: "http://localhost:8080/r/blog/api/v2" });
const page = await client.getByUID("page", "home");
```

Repositories are addressed by path, as `/r/<repo>/...`. With `SMALTIC_BASE_DOMAIN` set, subdomains
(`<repo>.<base domain>`) work too. A private repository also needs `accessToken` in the client config.

### Push models and import content

The write APIs take a `repository: <repo>` header and `Authorization: Bearer <write token>`. The official
clients send both once you give them the endpoints:

```ts
import { createWriteClient, createMigration } from "@prismicio/client";
import * as customTypes from "@prismicio/custom-types-client";

const writeToken = process.env.SMALTIC_WRITE_TOKEN!;

const typesClient = customTypes.createClient({
  endpoint: "http://localhost:8080/customtypes-api",
  repositoryName: "blog",
  token: writeToken,
});
await typesClient.insertCustomType(pageModel);

const writeClient = createWriteClient("blog", {
  writeToken,
  documentAPIEndpoint: "http://localhost:8080/r/blog/api/v2",
  migrationAPIEndpoint: "http://localhost:8080/migration-api",
  assetAPIEndpoint: "http://localhost:8080/asset-api",
});
const migration = createMigration();
migration.createDocument({ type: "page", uid: "home", lang: "en-us", tags: [], data: {} }, "Home");
await writeClient.migrate(migration);
await writeClient.publishMigrationRelease(); // makes the imported documents live
```

| API | Endpoint |
|---|---|
| Content API | `http://localhost:8080/r/<repo>/api/v2` |
| Custom Types API | `http://localhost:8080/customtypes-api` |
| Migration API | `http://localhost:8080/migration-api` |
| Asset API | `http://localhost:8080/asset-api` |
| Preview sessions | `http://localhost:8080/r/<repo>/previews/session?documentId=<id>` (write token) |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://prismic:prismic@localhost:5433/prismic` | Postgres 16 connection string |
| `SMALTIC_SECRET` | none in production | HMAC key for preview tokens. With `NODE_ENV=production` (as in the Docker image) the server refuses to start unless it has at least 32 characters. Outside production an insecure development default is used, with a warning. |
| `SMALTIC_PUBLIC_URL` | unset (compose: `http://localhost:8080`) | Public origin. Used for asset URLs stored in content and as the fallback for absolute URLs. Must be an absolute http(s) URL (startup fails otherwise). When set, only its host and port are trusted in `Host` / `X-Forwarded-Host`, and `X-Forwarded-Proto` must match its scheme; anything else falls back to this origin. In production, set it (or `SMALTIC_BASE_DOMAIN`). |
| `SMALTIC_BASE_DOMAIN` | unset | Enables `<repo>.<base domain>` routing |
| `SMALTIC_DATA_DIR` | `./data` (image: `/data`) | Where uploaded files are stored |
| `SMALTIC_TRUST_PROXY` | `true` | Honour `X-Forwarded-*` headers |
| `SMALTIC_REF_TTL_SECONDS` | `3600` | How long a superseded master ref stays queryable |
| `SMALTIC_RATE_LIMIT` | unset | Content API requests per second per repository; over the limit the server answers 429 with `Retry-After` |
| `SMALTIC_LOG_LEVEL` | `info` | Server log level (pino: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). 5xx errors are logged with the request id; clients get a generic body. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address |

## CLI

Inside the container, run it as `node dist/cli.js`. From a checkout, use `pnpm --filter @smaltic/server cli`.

```text
smaltic create-repo <name> [--locale en-us] [--locale-name English] [--visibility public|private|open]
smaltic add-locale <repo> <code> [--name Name]
smaltic create-token <repo> [--kind write|access] [--scope master|master+releases] [--name label]
smaltic create-user <email> [--password p] [--name Name]
```

## Development

A pnpm monorepo: `apps/server` (Fastify 5, Postgres 16), `packages/model` (models and content
pipeline), `tests/compat` (end-to-end suite). Node 22 and pnpm 10 are needed.

```sh
pnpm install
docker compose up -d db          # Postgres on localhost:5433, used by every test suite
pnpm -r typecheck
pnpm -r test
pnpm -r build                    # apps/server/dist, packages/model/dist
pnpm --filter @smaltic/server dev
```

### Compat suite

`tests/compat` drives the official SDKs against a Smaltic server over HTTP only. Each test name
carries the requirement IDs it covers: a bare ID (`REQ-API-007`) for full coverage, `REQ-API-007~` for partial. Requirements left for later plans are listed as `todo` tests.

By default it boots the server from the workspace on a throwaway database. To test a running server
instead (for example the Docker one), create a fresh repository with the `fr-fr` locale and pass its
tokens:

```sh
E="docker compose exec -T smaltic node dist/cli.js"
$E create-repo compat && $E add-locale compat fr-fr
$E create-repo compat-private --visibility private
COMPAT_BASE_URL=http://localhost:8080 COMPAT_REPO=compat \
COMPAT_WRITE_TOKEN=$($E create-token compat --kind write) \
COMPAT_ACCESS_TOKEN=$($E create-token compat --kind access) \
COMPAT_PRIVATE_REPO=compat-private \
COMPAT_PRIVATE_ACCESS_TOKEN=$($E create-token compat-private --kind access) \
pnpm --filter compat test
```

In this mode the tests that need server-side setup (releases, unpublishing, expired preview tokens,
rate limiting) are skipped. To refresh the parity matrix from a run:

```sh
pnpm --filter compat test:report
python3 -I docs/research/tools/build-parity-matrix.py --status-from tests/compat
```
