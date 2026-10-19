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

export const DEV_SECRET = "dev-secret-change-me";
const MIN_SECRET_LENGTH = 32;

/**
 * SMALTIC_SECRET signs preview tokens: a guessable key lets anyone read unpublished drafts. In
 * production (NODE_ENV=production) a missing, empty, short (< 32 chars) or default secret is fatal;
 * elsewhere the dev default is used with one warning.
 */
function resolveSecret(env: NodeJS.ProcessEnv): string {
  const raw = env.SMALTIC_SECRET;
  if (env.NODE_ENV === "production") {
    if (!raw) throw new Error("SMALTIC_SECRET must be set in production (at least 32 characters)");
    if (raw === DEV_SECRET) throw new Error("SMALTIC_SECRET must not be the development default in production");
    if (raw.length < MIN_SECRET_LENGTH) throw new Error(`SMALTIC_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production`);
    return raw;
  }
  if (!raw || raw === DEV_SECRET) {
    console.warn("[smaltic] SMALTIC_SECRET is not set: using the insecure development default. Never use it in production.");
    return DEV_SECRET;
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://prismic:prismic@localhost:5433/prismic",
    publicUrl: env.SMALTIC_PUBLIC_URL || undefined,
    baseDomain: env.SMALTIC_BASE_DOMAIN || undefined,
    secret: resolveSecret(env),
    dataDir: env.SMALTIC_DATA_DIR ?? "./data",
    trustProxy: (env.SMALTIC_TRUST_PROXY ?? "true") !== "false",
    refTtlSeconds: nonNegativeInt(env.SMALTIC_REF_TTL_SECONDS, 3600),
  };
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}
