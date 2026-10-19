import type { ZodError, ZodTypeAny } from 'zod';
import { CustomTypeSchema, SharedSliceSchema, type CustomType, type Field, type SharedSlice } from './schema/customType.js';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function formatErrors(err: ZodError): string[] {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
}

function run<T>(schema: ZodTypeAny, input: unknown): ValidationResult<T> {
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data as T } : { ok: false, errors: formatErrors(r.error) };
}

export const validateCustomType = (input: unknown): ValidationResult<CustomType> => run(CustomTypeSchema, input);
export const validateSharedSlice = (input: unknown): ValidationResult<SharedSlice> => run(SharedSliceSchema, input);

/** All top-level fields of all tabs merged into one map (ids are unique across tabs). */
export function flattenFields(ct: CustomType): Map<string, Field> {
  const out = new Map<string, Field>();
  for (const tab of Object.values(ct.json)) for (const [k, f] of Object.entries(tab)) out.set(k, f);
  return out;
}
