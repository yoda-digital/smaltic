import { createHash } from "node:crypto";
import { validateCustomType, validateSharedSlice } from "@smaltic/model";
import type { Sql } from "../db/index.js";

export class Conflict extends Error {
  constructor(public kind: Kind, public id: string) {
    super(`${kind} "${id}" already exists`);
  }
}
export class NotFound extends Error {
  constructor(public kind: Kind, public id: string) {
    super(`${kind} "${id}" not found`);
  }
}
export class HasExistingDocuments extends Error {
  constructor(public id: string) {
    super(`Custom type "${id}" has existing documents and cannot be deleted`);
  }
}
export class InvalidModel extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
  }
}

export type Kind = "custom_type" | "shared_slice";
export type Model = Record<string, unknown> & { id: string };
export type CountDocumentsOfType = (repoId: string, typeId: string) => Promise<number>;

export type BulkChange =
  | { type: "CUSTOM_TYPE_INSERT" | "CUSTOM_TYPE_UPDATE" | "SLICE_INSERT" | "SLICE_UPDATE"; id: string; payload: unknown }
  | { type: "CUSTOM_TYPE_DELETE" | "SLICE_DELETE"; id: string; payload?: unknown };

const TABLE: Record<Kind, string> = { custom_type: "custom_types", shared_slice: "shared_slices" };
const hashOf = (m: unknown) => createHash("sha256").update(JSON.stringify(m)).digest("hex");

function validate(kind: Kind, model: unknown): Model {
  const r = kind === "custom_type" ? validateCustomType(model) : validateSharedSlice(model);
  if (!r.ok) throw new InvalidModel(r.errors);
  // Persist the request exactly as received (R9), not the normalized output.
  return model as Model;
}

export class ModelService {
  constructor(
    private sql: Sql,
    private countDocumentsOfType: CountDocumentsOfType = async () => 0,
    private changedBy: string | null = null,
  ) {}

  listTypes(repoId: string) { return this.list("custom_type", repoId); }
  getType(repoId: string, id: string) { return this.get("custom_type", repoId, id); }
  insertType(repoId: string, model: unknown) { return this.tx((t) => this.insert(t, "custom_type", repoId, model)); }
  updateType(repoId: string, model: unknown) { return this.tx((t) => this.update(t, "custom_type", repoId, model)); }
  removeType(repoId: string, id: string) { return this.tx((t) => this.remove(t, "custom_type", repoId, id)); }
  listSlices(repoId: string) { return this.list("shared_slice", repoId); }
  getSlice(repoId: string, id: string) { return this.get("shared_slice", repoId, id); }
  insertSlice(repoId: string, model: unknown) { return this.tx((t) => this.insert(t, "shared_slice", repoId, model)); }
  updateSlice(repoId: string, model: unknown) { return this.tx((t) => this.update(t, "shared_slice", repoId, model)); }
  removeSlice(repoId: string, id: string) { return this.tx((t) => this.remove(t, "shared_slice", repoId, id)); }

  /** Applies all changes atomically; any failure rolls everything back. */
  async bulkUpdate(repoId: string, changes: BulkChange[]): Promise<void> {
    await this.tx(async (t) => {
      for (const c of changes) {
        const kind: Kind = c.type.startsWith("CUSTOM_TYPE") ? "custom_type" : "shared_slice";
        if (c.type.endsWith("_INSERT")) await this.insert(t, kind, repoId, c.payload);
        else if (c.type.endsWith("_UPDATE")) await this.update(t, kind, repoId, c.payload);
        else if (c.type.endsWith("_DELETE")) await this.remove(t, kind, repoId, c.id);
        else throw new InvalidModel([`unknown change type "${(c as { type: string }).type}"`]);
      }
    });
  }

  private tx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
    return this.sql.begin((t) => fn(t as unknown as Sql)) as Promise<T>;
  }

  private async list(kind: Kind, repoId: string): Promise<Model[]> {
    const rows = await this.sql.unsafe(`select model from ${TABLE[kind]} where repo_id = $1 order by id`, [repoId]);
    return rows.map((r) => r.model as Model);
  }

  private async get(kind: Kind, repoId: string, id: string): Promise<Model> {
    const rows = await this.sql.unsafe(`select model from ${TABLE[kind]} where repo_id = $1 and id = $2`, [repoId, id]);
    if (rows.length === 0) throw new NotFound(kind, id);
    return rows[0]!.model as Model;
  }

  private async history(t: Sql, kind: Kind, repoId: string, id: string, op: string, model: unknown) {
    await t`insert into model_history (repo_id, kind, id, op, model, changed_by)
      values (${repoId}, ${kind}, ${id}, ${op}, ${model === null ? null : t.json(model as never)}, ${this.changedBy})`;
  }

  private async insert(t: Sql, kind: Kind, repoId: string, input: unknown) {
    const model = validate(kind, input);
    const rows = await t.unsafe(
      `insert into ${TABLE[kind]} (repo_id, id, model, hash) values ($1,$2,$3,$4) on conflict do nothing returning id`,
      [repoId, model.id, t.json(model as never) as never, hashOf(model)],
    );
    if (rows.length === 0) throw new Conflict(kind, model.id);
    await this.history(t, kind, repoId, model.id, "insert", model);
  }

  private async update(t: Sql, kind: Kind, repoId: string, input: unknown) {
    const model = validate(kind, input);
    const rows = await t.unsafe(
      `update ${TABLE[kind]} set model = $3, hash = $4, updated_at = now() where repo_id = $1 and id = $2 returning id`,
      [repoId, model.id, t.json(model as never) as never, hashOf(model)],
    );
    if (rows.length === 0) throw new NotFound(kind, model.id);
    await this.history(t, kind, repoId, model.id, "update", model);
  }

  private async remove(t: Sql, kind: Kind, repoId: string, id: string) {
    if (kind === "custom_type" && (await this.countDocumentsOfType(repoId, id)) > 0) throw new HasExistingDocuments(id);
    const rows = await t.unsafe(`delete from ${TABLE[kind]} where repo_id = $1 and id = $2 returning model`, [repoId, id]);
    if (rows.length > 0) await this.history(t, kind, repoId, id, "delete", rows[0]!.model);
  }
}
