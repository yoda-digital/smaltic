export interface Config {
  databaseUrl: string;
  publicUrl?: string;
  baseDomain?: string;
  secret: string;
  dataDir: string;
  trustProxy: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://prismic:prismic@localhost:5433/prismic",
    publicUrl: env.SMALTIC_PUBLIC_URL || undefined,
    baseDomain: env.SMALTIC_BASE_DOMAIN || undefined,
    secret: env.SMALTIC_SECRET ?? "dev-secret-change-me",
    dataDir: env.SMALTIC_DATA_DIR ?? "./data",
    trustProxy: (env.SMALTIC_TRUST_PROXY ?? "true") !== "false",
  };
}
