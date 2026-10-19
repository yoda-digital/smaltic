import { inject } from "vitest";

/**
 * What the global setup hands to every test file. Everything here is plain data: tests talk to the
 * server over HTTP only.
 */
export interface CompatContext {
  /** `local`: server booted in-process on a throwaway database. `remote`: `COMPAT_BASE_URL`. */
  mode: "local" | "remote";
  baseUrl: string;
  repo: string;
  writeToken: string;
  /** Access token of `repo` (master scope). Optional in remote mode. */
  accessToken?: string;
  /** Seeded document ids, keyed `<type>:<uid>` (e.g. `page:home`). */
  ids: Record<string, string>;
  /** Id of the seeded image asset. */
  assetId: string;
  /** Number of seeded `bulk_item` documents. */
  bulkCount: number;

  // ---- set up only where the environment allows it (in-process: always; remote: when configured) ----
  /** A private repository and an access token for it. */
  privateRepo?: { name: string; accessToken: string };
  /** An open release labelled "Spring" and a `master+releases` access token that may read it. */
  release?: { label: string; accessToken: string };
  /** Id of a published page that was unpublished afterwards (target of a now-broken link). */
  archivedLinkSource?: string;
  /** A correctly signed preview token whose expiry is in the past. */
  expiredPreviewToken?: string;
  /** A master ref superseded by a later publication (still within the default TTL). */
  supersededRef?: string;
  /** Base URL of a server for the same database with `SMALTIC_REF_TTL_SECONDS=0`. */
  zeroTtlBaseUrl?: string;
  /** Base URL of a server for the same database with `SMALTIC_RATE_LIMIT=5`. */
  rateLimitedBaseUrl?: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    compat: CompatContext;
  }
}

export const ctx = (): CompatContext => inject("compat");

export const documentAPIEndpoint = (c: CompatContext, repo = c.repo, base = c.baseUrl) => `${base}/r/${repo}/api/v2`;
