import type { KV } from './kv';

import type { Entity } from './types';

export type MutationKind = 'create' | 'update' | 'delete';
export type MutationStatus = 'pending' | 'conflict' | 'rejected';
export type ServerState = { version: number; deleted: boolean; title?: string; fields?: Record<string, unknown> };

export interface Mutation {
  key: string;            // storage key; lexicographic order == creation order
  opId: string;           // idempotency key sent to the server
  userId: string;         // the account that made the change; never sent under another session
  entity: Entity;
  kind: MutationKind;
  entityId: string;
  workspaceId: string;
  baseVersion: number | null;
  payload: Record<string, unknown>;
  status: MutationStatus;
  attempts: number;
  serverState?: ServerState;
  error?: string;
  createdAt: number;
}
export type Draft = Pick<Mutation, 'entity' | 'kind' | 'entityId' | 'workspaceId' | 'baseVersion' | 'payload'>;

/**
 * One storage record PER mutation. Enqueue = a single write of a brand-new key, so it can never clobber
 * (or be clobbered by) a concurrent flush. The old design rewrote the whole array and could lose changes.
 */
export class Outbox {
  private counter = 0;
  constructor(
    private kv: KV, readonly userId: string,
    private newId: () => string = () => crypto.randomUUID(),
    private now: () => number = Date.now,
  ) {}

  private nextKey() {
    this.counter = (this.counter + 1) % 1_000_000;
    return `m:${String(this.now()).padStart(13, '0')}-${String(this.counter).padStart(6, '0')}-${this.newId().slice(0, 8)}`;
  }
  async enqueue(d: Draft): Promise<Mutation> {
    const m: Mutation = { ...d, key: this.nextKey(), opId: this.newId(), userId: this.userId, status: 'pending', attempts: 0, createdAt: this.now() };
    await this.kv.set(m.key, m);
    return m;
  }
  freshOpId() { return this.newId(); }
  async list(): Promise<Mutation[]> { return (await this.kv.entries<Mutation>('m:')).map(([, v]) => v); }
  put(m: Mutation) { return this.kv.set(m.key, m); }
  remove(key: string) { return this.kv.del(key); }
}
