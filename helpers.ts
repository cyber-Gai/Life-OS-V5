import { memoryKV, type KV } from '../../src/lib/kv';
import { Outbox, type Mutation } from '../../src/lib/outbox';
import { RetryableError, createSyncEngine, localMutex, type ApplyResult, type Exclusive, type Transport } from '../../src/lib/sync';

type Row = Record<string, any> & { version: number; deleted: boolean; ws: string };

/** In-memory server with the SAME rules as public.apply_mutation (see supabase/migrations/0003). Rows are keyed by id only (tests use one entity). */
export class FakeServer implements Transport {
  tasks = new Map<string, Row>();
  ops = new Map<string, ApplyResult>();
  calls: string[] = [];
  offline = false;
  gate: Promise<void> | null = null;
  reject: ((m: Mutation) => string | null) | null = null;

  async apply(m: Mutation): Promise<ApplyResult> {
    this.calls.push(m.opId);
    if (this.gate) await this.gate;
    if (this.offline) throw new RetryableError('offline');
    const prev = this.ops.get(m.opId);
    if (prev) return { ...prev, replayed: true } as ApplyResult;
    const why = this.reject?.(m);
    const r: ApplyResult = why ? { status: 'rejected', reason: why } : this.run(m);
    this.ops.set(m.opId, r);
    return r;
  }
  private run(m: Mutation): ApplyResult {
    const t = this.tasks.get(m.entityId);
    if (m.kind === 'create') {
      if (t && t.ws !== m.workspaceId) return { status: 'rejected', reason: 'id unavailable' };
      if (!t) this.tasks.set(m.entityId, { version: 1, deleted: false, ws: m.workspaceId, ...m.payload });
      return { status: 'applied', version: this.tasks.get(m.entityId)!.version };
    }
    if (!t || t.ws !== m.workspaceId) return { status: 'rejected', reason: 'not found' };
    const srv = { version: t.version, deleted: t.deleted, title: t.title, fields: Object.fromEntries(Object.keys(m.payload).map(k => [k, t[k]])) };
    if (m.kind === 'delete' && t.deleted) return { status: 'applied', version: t.version, noop: true };
    if (t.deleted) return { status: 'conflict', server: { ...srv, fields: {} } };
    if (t.version === m.baseVersion) {
      if (m.kind === 'update') Object.assign(t, m.payload); else t.deleted = true;
      t.version++;
      return { status: 'applied', version: t.version };
    }
    if (m.kind === 'update' && Object.entries(m.payload).every(([k, v]) => t[k] === v)) return { status: 'applied', version: t.version, noop: true };
    return { status: 'conflict', server: srv };
  }
  /** Simulate another device editing the task. */
  externalToggle(id: string, done: boolean) { const t = this.tasks.get(id)!; t.done = done; t.version++; }
  externalDelete(id: string) { const t = this.tasks.get(id)!; t.deleted = true; t.version++; }
}

let n = 0;
export const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

export function setup(opts: { kv?: KV; user?: string; server?: FakeServer; exclusive?: Exclusive; onChange?: () => void } = {}) {
  const kv = opts.kv ?? memoryKV();
  const user = opts.user ?? 'user-a';
  const server = opts.server ?? new FakeServer();
  const outbox = new Outbox(kv, user, uuid);
  const engine = createSyncEngine({ outbox, transport: server, runExclusive: opts.exclusive ?? localMutex(), onChange: opts.onChange });
  const WS = 'ws-1';
  const create = (id: string, title = id) => engine.submit({ entity: 'tasks', kind: 'create', entityId: id, workspaceId: WS, baseVersion: null, payload: { title, priority: 'Medium', done: false } });
  const toggle = (id: string, done: boolean, base: number) => engine.submit({ entity: 'tasks', kind: 'update', entityId: id, workspaceId: WS, baseVersion: base, payload: { done } });
  const del = (id: string, base: number) => engine.submit({ entity: 'tasks', kind: 'delete', entityId: id, workspaceId: WS, baseVersion: base, payload: {} });
  return { kv, server, outbox, engine, create, toggle, del, WS, user };
}
