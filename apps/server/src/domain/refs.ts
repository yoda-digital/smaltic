import { newId } from "@smaltic/model";
import type { Sql } from "../db/index.js";

export interface MasterRef {
  ref: string;
  /** bigint as decimal string (postgres bigint). */
  seq: string;
}

/** Namespace for per-repo advisory locks (two-key form, separate from the migrator's single-key lock). */
const REPO_LOCK_NS = 7272;

/** Serializes publications for one repository until the surrounding transaction ends. */
export async function lockRepo(t: Sql, repoId: string): Promise<void> {
  await t`select pg_advisory_xact_lock(${REPO_LOCK_NS}::int, hashtext(${repoId}))`;
}

export type PublicationKind = "init" | "publish" | "unpublish" | "release";

/** Inserts a publication (new master ref). Caller must hold `lockRepo` so seq order equals commit order. */
export async function insertPublication(t: Sql, repoId: string, kind: PublicationKind): Promise<MasterRef & { createdAt: Date }> {
  const [row] = await t`insert into publications (repo_id, ref, kind) values (${repoId}, ${newId()}, ${kind})
    returning seq, ref, created_at`;
  return { ref: row!.ref, seq: String(row!.seq), createdAt: row!.created_at };
}

export class RefService {
  constructor(private sql: Sql) {}

  mintRef(): string {
    return newId();
  }

  /** Latest publication of the repo; the first call mints an initial master ref. */
  async currentMaster(repoId: string): Promise<MasterRef> {
    const found = await this.latest(this.sql, repoId);
    if (found) return found;
    return (await this.sql.begin(async (tx) => {
      const t = tx as unknown as Sql;
      await lockRepo(t, repoId);
      const again = await this.latest(t, repoId);
      if (again) return again;
      const { ref, seq } = await insertPublication(t, repoId, "init");
      return { ref, seq };
    })) as MasterRef;
  }

  private async latest(t: Sql, repoId: string): Promise<MasterRef | null> {
    const [row] = await t`select ref, seq from publications where repo_id = ${repoId} order by seq desc limit 1`;
    return row ? { ref: row.ref, seq: String(row.seq) } : null;
  }
}
