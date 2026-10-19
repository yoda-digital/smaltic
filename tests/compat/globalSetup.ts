import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalSetupContext } from "vitest/node";
import type { CompatContext } from "./context.js";
import { ALT_LOCALE, BULK_COUNT, LOCALE, seed, type Target } from "./seed.js";

/**
 * Two modes:
 * - default: boots the workspace server in-process (apps/server, throwaway database from
 *   `DATABASE_URL` / the compose Postgres), creates the repositories and tokens directly, then seeds
 *   over HTTP. Steps no public HTTP API covers yet (releases, unpublishing, visibility) use the
 *   server's domain services; the tests themselves only speak HTTP.
 * - `COMPAT_BASE_URL` set: runs against that server. The repository (`COMPAT_REPO`, locales en-us +
 *   fr-fr, fresh) and its tokens (`COMPAT_WRITE_TOKEN`, optional `COMPAT_ACCESS_TOKEN`) come from the
 *   `smaltic` CLI; `COMPAT_PRIVATE_REPO` + `COMPAT_PRIVATE_ACCESS_TOKEN` enable the private-repo test.
 *   Tests that need server-side setup are skipped.
 */
export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const remote = process.env.COMPAT_BASE_URL;
  if (remote) {
    const need = (k: string) => {
      const v = process.env[k];
      if (!v) throw new Error(`${k} is required when COMPAT_BASE_URL is set`);
      return v;
    };
    const target: Target = { baseUrl: remote.replace(/\/+$/, ""), repo: need("COMPAT_REPO"), writeToken: need("COMPAT_WRITE_TOKEN") };
    const { ids, assetId } = await seed(target);
    const priv = process.env.COMPAT_PRIVATE_REPO;
    const ctx: CompatContext = {
      mode: "remote",
      ...target,
      accessToken: process.env.COMPAT_ACCESS_TOKEN || undefined,
      ids,
      assetId,
      bulkCount: BULK_COUNT,
      ...(priv ? { privateRepo: { name: priv, accessToken: need("COMPAT_PRIVATE_ACCESS_TOKEN") } } : {}),
    };
    provide("compat", ctx);
    return async () => {};
  }
  return local(provide);
}

async function local(provide: GlobalSetupContext["provide"]): Promise<() => Promise<void>> {
  // Relative imports into the server workspace: the compat package does not depend on it otherwise.
  const { startServer } = await import("../../apps/server/test/helpers.js");
  const { buildApp } = await import("../../apps/server/src/app.js");
  const { RepositoryService } = await import("../../apps/server/src/domain/repositories.js");
  const { DocumentService } = await import("../../apps/server/src/domain/documents.js");
  const { RefService } = await import("../../apps/server/src/domain/refs.js");

  const dataDir = await mkdtemp(join(tmpdir(), "smaltic-compat-"));
  // The server runs in this (main) process: silence its request log and use a test secret so the output stays
  // free of the dev-default secret warning.
  process.env.SMALTIC_SECRET ??= "compat-test-secret-0123456789abcdef0123";
  const srv = await startServer({ config: { dataDir, logLevel: "silent" } });
  const closers: Array<() => Promise<unknown>> = [];
  try {
    const repos = new RepositoryService(srv.sql);
    const repo = await repos.create({ name: "compat", masterLocale: { code: LOCALE, name: "English (US)" } });
    await repos.addLocale(repo.id, { code: ALT_LOCALE, name: "French" });
    const { token: writeToken } = await repos.createToken(repo.id, "write", "compat");
    const { token: accessToken } = await repos.createToken(repo.id, "access", "compat");
    const { token: releaseToken } = await repos.createToken(repo.id, "access", "compat-releases", "master+releases");

    const priv = await repos.create({ name: "compat-private", masterLocale: { code: LOCALE, name: "English (US)" }, visibility: "private" });
    const { token: privateToken } = await repos.createToken(priv.id, "access", "compat");

    const target: Target = { baseUrl: srv.baseUrl, repo: repo.name, writeToken };
    const { ids, assetId } = await seed(target);

    // Server-side steps with no HTTP API in Plan 1.
    const docs = new DocumentService(srv.sql);
    const refs = new RefService(srv.sql, { secret: srv.app.config.secret });
    const supersededRef = (await refs.currentMaster(repo.id)).ref;
    await docs.unpublish(repo.id, null, [ids["page:old-page"]!]);
    const { id: springId } = await docs.create(repo.id, null, {
      type: "page",
      lang: LOCALE,
      uid: "spring-sale",
      tags: ["spring"],
      title: "Spring sale",
      data: { title: [{ type: "heading1", text: "Spring sale", spans: [] }] },
    });
    ids["page:spring-sale"] = springId;
    await docs.updateDraft(repo.id, null, ids["page:about"]!, {
      data: { title: [{ type: "heading1", text: "About (Spring)", spans: [] }], parent: { link_type: "Document", id: ids["page:home"]! } },
    });
    const spring = await docs.createRelease(repo.id, null, "Spring", { scheduledAt: new Date("2030-03-21T09:00:00Z") });
    await docs.addToRelease(repo.id, null, spring.id, springId);
    await docs.addToRelease(repo.id, null, spring.id, ids["page:about"]!);

    const config = srv.app.config;
    const expiredPreviewToken = refs.createPreviewToken(repo.id, "drafts", undefined, -60);

    // More servers on the same database with one setting changed.
    const variant = async (patch: Partial<typeof config>): Promise<string> => {
      const app = await buildApp({ config: { ...config, ...patch }, sql: srv.sql });
      await app.listen({ port: 0, host: "127.0.0.1" });
      closers.push(() => app.close());
      const addr = app.server.address();
      return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    };
    const rateLimitedBaseUrl = await variant({ rateLimit: 5 });
    const zeroTtlBaseUrl = await variant({ refTtlSeconds: 0 });

    const ctx: CompatContext = {
      mode: "local",
      ...target,
      accessToken,
      ids,
      assetId,
      bulkCount: BULK_COUNT,
      privateRepo: { name: priv.name, accessToken: privateToken },
      release: { label: "Spring", accessToken: releaseToken },
      archivedLinkSource: ids["page:linker"],
      expiredPreviewToken,
      rateLimitedBaseUrl,
      supersededRef,
      zeroTtlBaseUrl,
    };
    provide("compat", ctx);
  } catch (e) {
    await srv.close();
    throw e;
  }
  return async () => {
    for (const c of closers) await c();
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  };
}
