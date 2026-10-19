export interface Config {
  databaseUrl: string;
  publicUrl?: string;
  baseDomain?: string;
  secret: string;
  dataDir: string;
  trustProxy: boolean;
  /** How long a superseded master ref stays queryable (SMALTIC_REF_TTL_SECONDS, default 3600). */
  refTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://prismic:prismic@localhost:5433/prismic",
    publicUrl: env.SMALTIC_PUBLIC_URL || undefined,
    baseDomain: env.SMALTIC_BASE_DOMAIN || undefined,
    secret: env.SMALTIC_SECRET ?? "dev-secret-change-me",
    dataDir: env.SMALTIC_DATA_DIR ?? "./data",
    trustProxy: (env.SMALTIC_TRUST_PROXY ?? "true") !== "false",
    refTtlSeconds: nonNegativeInt(env.SMALTIC_REF_TTL_SECONDS, 3600),
  };
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}
