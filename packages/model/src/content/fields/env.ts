import type { NormalizeCtx } from '../shared.js';

/** What per-field normalizers need from the running normalization: error sink and host callbacks. */
export interface NormEnv {
  err(property: string, value: unknown, error: string): void;
  readonly ctx: NormalizeCtx;
}
