import { createHash, randomBytes } from "node:crypto";
import { hash as argonHash } from "@node-rs/argon2";
import { newId } from "@smaltic/model";
import type { Sql } from "../db/index.js";

export const REPO_NAME_RE = /^[a-zA-Z0-9][-a-zA-Z0-9]{2,}[a-zA-Z0-9]$/;

export class InvalidRepositoryName extends Error {
  constructor(name: string) {
    super(`Invalid repository name: ${name}`);
    this.name = "InvalidRepositoryName";
  }
}
export class RepositoryExists extends Error {
  constructor(name: string) {
    super(`Repository already exists: ${name}`);
    this.name = "RepositoryExists";
  }
}

export type Visibility = "public" | "private" | "open";
export type TokenKind = "access" | "write";
export type TokenScope = "master" | "master+releases";

export interface Repo {
  id: string;
  name: string;
  displayName: string;
  visibility: Visibility;
  createdAt: Date;
}
export interface Locale {
  code: string;
  name: string;
  position: number;
  isMaster: boolean;
}
export interface Token {
  id: string;
  repoId: string;
  kind: TokenKind;
  name: string;
  scope: TokenScope;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(n: number): string {
  let out = "";
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < 248 && out.length < n) out += BASE62[b % 62];
    }
  }
  return out;
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function toRepo(r: any): Repo {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    visibility: r.api_visibility,
    createdAt: r.created_at,
  };
}

export class RepositoryService {
  constructor(private sql: Sql) {}

  async create(input: {
    name: string;
    displayName?: string;
    masterLocale: { code: string; name: string };
    visibility?: Visibility;
  }): Promise<Repo> {
    if (!REPO_NAME_RE.test(input.name)) throw new InvalidRepositoryName(input.name);
    const id = newId();
    try {
      return await this.sql.begin(async (tx) => {
        const [row] = await tx`
          insert into repositories (id, name, display_name, api_visibility)
          values (${id}, ${input.name}, ${input.displayName ?? input.name}, ${input.visibility ?? "public"})
          returning *`;
        await tx`insert into locales (repo_id, code, name, position, is_master)
          values (${id}, ${input.masterLocale.code}, ${input.masterLocale.name}, 0, true)`;
        return toRepo(row);
      });
    } catch (e: any) {
      if (e?.code === "23505") throw new RepositoryExists(input.name);
      throw e;
    }
  }

  async getByName(name: string): Promise<Repo | null> {
    const [row] = await this.sql`select * from repositories where name = ${name}`;
    return row ? toRepo(row) : null;
  }

  async listLocales(repoId: string): Promise<Locale[]> {
    const rows = await this.sql`select code, name, position, is_master from locales
      where repo_id = ${repoId} order by is_master desc, position, code`;
    return rows.map((r) => ({ code: r.code, name: r.name, position: r.position, isMaster: r.is_master }));
  }

  async addLocale(repoId: string, input: { code: string; name: string }): Promise<Locale> {
    const [row] = await this.sql`
      insert into locales (repo_id, code, name, position, is_master)
      values (${repoId}, ${input.code}, ${input.name},
        (select coalesce(max(position), 0) + 1 from locales where repo_id = ${repoId}), false)
      returning code, name, position, is_master`;
    return { code: row!.code, name: row!.name, position: row!.position, isMaster: row!.is_master };
  }

  async createToken(
    repoId: string,
    kind: TokenKind,
    name: string,
    scope: TokenScope = "master",
  ): Promise<{ id: string; token: string }> {
    const id = newId();
    const token = `rf_${kind}_${base62(32)}`;
    await this.sql`insert into api_tokens (id, repo_id, kind, name, token_hash, scope)
      values (${id}, ${repoId}, ${kind}, ${name}, ${sha256(token)}, ${scope})`;
    return { id, token };
  }

  async verifyToken(repoId: string, kind: TokenKind, token: string): Promise<Token | null> {
    const [r] = await this.sql`select * from api_tokens
      where token_hash = ${sha256(token)} and repo_id = ${repoId} and kind = ${kind} and revoked_at is null`;
    return r ? { id: r.id, repoId: r.repo_id, kind: r.kind, name: r.name, scope: r.scope } : null;
  }

  async revokeToken(id: string): Promise<void> {
    await this.sql`update api_tokens set revoked_at = now() where id = ${id} and revoked_at is null`;
  }
}

export class UserService {
  constructor(private sql: Sql) {}

  async create(input: { email: string; password: string; name?: string }): Promise<{ id: string; email: string }> {
    const id = newId();
    const passwordHash = await argonHash(input.password, { algorithm: 2 }); // argon2id
    await this.sql`insert into users (id, email, name, password_hash)
      values (${id}, ${input.email.toLowerCase()}, ${input.name ?? ""}, ${passwordHash})`;
    return { id, email: input.email.toLowerCase() };
  }
}
