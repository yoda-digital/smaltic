import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** 16-char id from [A-Za-z0-9_-]. 64-char alphabet, so `byte & 63` is unbiased. */
export function newId(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}

/** Slice instance id: `<sliceType>$<uuidv4>`. */
export function sliceId(sliceType: string): string {
  return `${sliceType}$${randomUUID()}`;
}
