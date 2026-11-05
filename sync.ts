import type { Mutation, Outbox, ServerState } from './outbox';

export type ApplyResult =
  | { status: 'applied'; version?: number; replayed?: boolean; noop?: boolean }
  | { status: 'conflict'; server: ServerState; replayed?: boolean }
  | { status: 'rejected'; reason: string; replayed?: boolean };

/** Thrown for failures that say nothing about the mutation itself (no network, expired session, 5xx). Keep and retry later. */
export class RetryableError extends Error {
  constructor(readonly reason: 'offline' | 'auth' | 'server', message?: string) { super(message ?? reason); }
}
export interface Transport { apply(m: Mutation): Promise<ApplyResult>; }
export interface SyncSummary { applied: number; conflicts: number; rejected: number; stopped?: 'offline' | 'auth' | 'server' }
export type Exclusive = <T>(fn: () => Promise<T>) => Promise<T>;

/** In-tab mutex (fallback when the Web Locks API is unavailable). */
export function localMutex(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return fn => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
}
/** Cross-tab exclusive lock: two tabs (or a tab and a PWA window) can never flush the same outbox at once. */
export function webLocksExclusive(name: string): Exclusive {
  const nav = typeof navigator !== 'undefined' ? (navigator as any) : undefined;
  if (!nav?.locks?.request) return localMutex();
  return fn => nav.locks.request(name, { mode: 'exclusive' }, fn);
}

const ref = (m: { entity: string; entityId: string }) => `${m.entity}:${m.entityId}`;

export function createSyncEngine(opts: { outbox: Outbox; transport: Transport; runExclusive?: Exclusive; onChange?: () => void }) {
  const { outbox, transport, onChange } = opts;
  const exclusive = opts.runExclusive ?? localMutex();
  let running: Promise<SyncSummary> | null = null;
  let again = false;
  let generation = 0; // bumped at the start and end of every pass; lets readers detect "the outbox changed while I was fetching"

  const settle = async (m: Mutation, patch: Partial<Mutation>) => { Object.assign(m, patch); await outbox.put(m); };

  async function pass(): Promise<SyncSummary> {
    generation++;
    const s: SyncSummary = { applied: 0, conflicts: 0, rejected: 0 };
    try {
      const queue = await outbox.list();
      // Tasks with an unresolved conflict (from this pass OR an earlier one): their later edits wait for the user's decision.
      const blocked = new Map<string, ServerState | undefined>();
      for (const m of queue) if (m.status === 'conflict' && !blocked.has(ref(m))) blocked.set(ref(m), m.serverState);
      for (let i = 0; i < queue.length; i++) {
        const m = queue[i];
        if (m.status !== 'pending') continue;
        if (blocked.has(ref(m))) { await settle(m, { status: 'conflict', serverState: blocked.get(ref(m)) }); continue; }
        let r: ApplyResult;
        try {
          r = await transport.apply(m);
        } catch (e) {
          if (e instanceof RetryableError) { s.stopped = e.reason; break; } // keep order: nothing after this runs
          r = { status: 'rejected', reason: e instanceof Error ? e.message : String(e) }; // unexpected error must not wedge the queue
        }
        if (r.status === 'applied') {
          await outbox.remove(m.key); s.applied++;
          if (r.version != null) // chain: later edits of the same task are based on the version this one just produced
            for (let j = i + 1; j < queue.length; j++)
              if (ref(queue[j]) === ref(m) && queue[j].status === 'pending' && queue[j].baseVersion != null)
                await settle(queue[j], { baseVersion: r.version });
        } else if (r.status === 'conflict') {
          s.conflicts++; blocked.set(ref(m), r.server);
          for (let j = i; j < queue.length; j++)
            if (ref(queue[j]) === ref(m) && queue[j].status === 'pending') await settle(queue[j], { status: 'conflict', serverState: r.server });
        } else {
          s.rejected++; await settle(m, { status: 'rejected', error: r.reason });
        }
      }
    } finally { generation++; onChange?.(); }
    return s;
  }

  /** Single-flight. A call that arrives mid-flush schedules one more pass so changes enqueued meanwhile are never stranded. */
  function flush(): Promise<SyncSummary> {
    if (running) { again = true; return running; }
    running = (async () => {
      const total: SyncSummary = { applied: 0, conflicts: 0, rejected: 0 };
      try {
        do {
          again = false;
          const s = await exclusive(pass);
          total.applied += s.applied; total.conflicts += s.conflicts; total.rejected += s.rejected;
          if (s.stopped) { total.stopped = s.stopped; break; }
        } while (again);
      } finally { running = null; }
      return total;
    })();
    return running;
  }

  /** Save a change locally, then try to sync it. Resolves when the local write is durable, not when the network is done. */
  async function submit(d: Parameters<Outbox['enqueue']>[0]) { const m = await outbox.enqueue(d); onChange?.(); void flush(); return m; }

  async function resolveConflict(entity: string, entityId: string, choice: 'mine' | 'theirs') {
    await exclusive(async () => {
      const mine = (await outbox.list()).filter(m => ref(m) === `${entity}:${entityId}` && m.status === 'conflict');
      const server = mine[0]?.serverState;
      if (!mine.length) return;
      if (choice === 'theirs' || !server || server.deleted) { for (const m of mine) await outbox.remove(m.key); }
      else for (const m of mine) await settle(m, { status: 'pending', baseVersion: server.version, serverState: undefined, opId: outbox.freshOpId() }); // new op: the old id's "conflict" is on the server ledger
    });
    onChange?.(); void flush();
  }
  async function retryRejected(key: string) {
    await exclusive(async () => {
      const m = (await outbox.list()).find(x => x.key === key && x.status === 'rejected');
      if (m) await settle(m, { status: 'pending', error: undefined, attempts: m.attempts + 1, opId: outbox.freshOpId() }); // new op id: the old one's rejection is on the server's ledger
    });
    onChange?.(); void flush();
  }
  async function discard(key: string) { await exclusive(() => outbox.remove(key)); onChange?.(); }

  return { flush, submit, resolveConflict, retryRejected, discard, get generation() { return generation; }, get busy() { return running !== null; } };
}
export type SyncEngine = ReturnType<typeof createSyncEngine>;
