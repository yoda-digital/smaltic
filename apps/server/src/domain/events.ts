import { EventEmitter } from "node:events";

export interface PublishedDoc {
  id: string;
  versionId: string;
}

/** Domain events emitted by DocumentService after commit. Consumed in-process (webhooks, cache, scheduler). */
export interface DomainEventMap {
  "documents.created": { repoId: string; actor: string | null; id: string; versionId: string };
  "documents.updated": { repoId: string; actor: string | null; id: string; versionId: string };
  "documents.published": { repoId: string; actor: string | null; ref: string; seq: string; documents: PublishedDoc[] };
  "documents.unpublished": { repoId: string; actor: string | null; ref: string; seq: string; ids: string[] };
  "documents.deleted": { repoId: string; actor: string | null; ids: string[] };
  "release.created": { repoId: string; actor: string | null; releaseId: string; ref: string };
  "release.updated": { repoId: string; actor: string | null; releaseId: string };
  "release.published": {
    repoId: string;
    actor: string | null;
    releaseId: string;
    ref: string;
    seq: string;
    documents: PublishedDoc[];
  };
  "release.deleted": { repoId: string; actor: string | null; releaseId: string };
}
export type DomainEventName = keyof DomainEventMap;

/**
 * Typed wrapper over EventEmitter. A throwing listener never fails the mutation that emitted
 * (the write is already committed); its error goes to `onError`.
 */
export class DomainEvents {
  private ee = new EventEmitter();
  constructor(private onError: (err: unknown, name: DomainEventName) => void = (err, name) => console.error(`[smaltic] listener for ${name} failed`, err)) {
    this.ee.setMaxListeners(0);
  }

  on<K extends DomainEventName>(name: K, fn: (payload: DomainEventMap[K]) => void): this {
    this.ee.on(name, fn);
    return this;
  }

  off<K extends DomainEventName>(name: K, fn: (payload: DomainEventMap[K]) => void): this {
    this.ee.off(name, fn);
    return this;
  }

  emit<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): void {
    for (const fn of this.ee.listeners(name)) {
      try {
        (fn as (p: DomainEventMap[K]) => void)(payload);
      } catch (err) {
        this.onError(err, name);
      }
    }
  }
}
