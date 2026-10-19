export interface Config {
  databaseUrl: string;
  publicUrl?: string;
  baseDomain?: string;
  secret: string;
  dataDir: string;
  trustProxy: boolean;
  /** How long a superseded master ref stays queryable (SMALTIC_REF_TTL_SECONDS, default 3600). */
  refTtlSeconds: number;
  /** Content API requests per second per repository (SMALTIC_RATE_LIMIT); undefined = no limit. */
  rateLimit?: number;
  /** Pino log level (SMALTIC_LOG_LEVEL, default "info"; "silent" disables logging). */
  logLevel: string;
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

/** SMALTIC_PUBLIC_URL must be an absolute http(s) URL: it pins the scheme, host and port of every emitted URL. */
function resolvePublicUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`SMALTIC_PUBLIC_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`SMALTIC_PUBLIC_URL must be an http or https URL, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

let warnedNoOrigin = false;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = resolveSecret(env);
  const publicUrl = resolvePublicUrl(env.SMALTIC_PUBLIC_URL);
  const baseDomain = env.SMALTIC_BASE_DOMAIN || undefined;
  if (env.NODE_ENV === "production" && !publicUrl && !baseDomain && !warnedNoOrigin) {
    warnedNoOrigin = true;
    console.warn(
      "[smaltic] Neither SMALTIC_PUBLIC_URL nor SMALTIC_BASE_DOMAIN is set: emitted URLs follow the client's Host and X-Forwarded-* headers. Set SMALTIC_PUBLIC_URL in production.",
    );
  }
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://prismic:prismic@localhost:5433/prismic",
    publicUrl,
    baseDomain,
    secret,
    dataDir: env.SMALTIC_DATA_DIR ?? "./data",
    trustProxy: (env.SMALTIC_TRUST_PROXY ?? "true") !== "false",
    refTtlSeconds: nonNegativeInt(env.SMALTIC_REF_TTL_SECONDS, 3600),
    rateLimit: nonNegativeInt(env.SMALTIC_RATE_LIMIT, 0) || undefined,
    logLevel: env.SMALTIC_LOG_LEVEL || "info",
  };
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}
