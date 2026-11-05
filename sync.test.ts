import { describe, expect, it } from 'vitest';
import { memoryKV } from '../../src/lib/kv';
import { Outbox } from '../../src/lib/outbox';
import { createSyncEngine, localMutex } from '../../src/lib/sync';
import { FakeServer, setup, uuid } from './helpers';

describe('offline queue', () => {
  it('keeps everything, in order, while offline; sends it once when back online', async () => {
    const t = setup(); t.server.offline = true;
    await t.create('t1'); await t.create('t2'); await t.toggle('t1', true, 1);
    expect((await t.engine.flush()).stopped).toBe('offline');
    expect((await t.outbox.list()).map(m => m.kind)).toEqual(['create', 'create', 'update']);
    t.server.offline = false;
    expect(await t.engine.flush()).toMatchObject({ applied: 3, conflicts: 0, rejected: 0 });
    expect(await t.outbox.list()).toHaveLength(0);
    expect(t.server.tasks.get('t1')).toMatchObject({ done: true, version: 2 });
  });
  it('toggling the same task twice offline does NOT conflict with itself (versions are chained)', async () => {
    const t = setup(); await t.create('t1'); await t.engine.flush();
    t.server.offline = true;
    await t.toggle('t1', true, 1); await t.toggle('t1', false, 1); await t.toggle('t1', true, 1); await t.engine.flush();
    t.server.offline = false;
    expect(await t.engine.flush()).toMatchObject({ applied: 3, conflicts: 0 });
    expect(t.server.tasks.get('t1')).toMatchObject({ done: true, version: 4 });
  });
  it('a permanently rejected change is parked, does not block later work, and can be retried or dropped', async () => {
    const t = setup(); t.server.reject = m => (m.payload.title === 'bad' ? 'check constraint' : null);
    await t.create('bad'); await t.create('good');
    expect(await t.engine.flush()).toMatchObject({ applied: 1, rejected: 1 });
    const left = await t.outbox.list();
    expect(left).toHaveLength(1); expect(left[0]).toMatchObject({ entityId: 'bad', status: 'rejected', error: 'check constraint' });
    expect(t.server.tasks.has('good')).toBe(true);
    t.server.reject = null; await t.engine.retryRejected(left[0].key); await t.engine.flush();
    expect(t.server.tasks.has('bad')).toBe(true); expect(await t.outbox.list()).toHaveLength(0);
    await t.create('worse'); t.server.reject = () => 'nope'; await t.engine.flush();
    await t.engine.discard((await t.outbox.list())[0].key); expect(await t.outbox.list()).toHaveLength(0);
  });
});

describe('concurrency', () => {
  it('a change enqueued WHILE a flush is running is not lost', async () => {
    const t = setup(); let release!: () => void; t.server.gate = new Promise<void>(r => (release = r));
    await t.create('first');                       // flush starts and blocks on the gate
    await t.create('second');                      // enqueued mid-flush
    release(); await t.engine.flush();
    expect([...t.server.tasks.keys()].sort()).toEqual(['first', 'second']);
    expect(await t.outbox.list()).toHaveLength(0);
  });
  it('overlapping flush() calls are single-flight: each op is sent exactly once', async () => {
    const t = setup(); t.server.offline = true; await t.create('a'); await t.create('b'); await t.engine.flush(); t.server.offline = false; t.server.calls = [];
    await Promise.all([t.engine.flush(), t.engine.flush(), t.engine.flush(), t.engine.flush()]);
    expect(t.server.calls).toHaveLength(2); expect(new Set(t.server.calls).size).toBe(2);
  });
  it('two tabs sharing one outbox and one lock never double-send', async () => {
    const kv = memoryKV(), server = new FakeServer(), lock = localMutex();
    const tabA = setup({ kv, server, exclusive: lock }), tabB = setup({ kv, server, exclusive: lock });
    server.offline = true; await tabA.create('x'); await tabA.create('y'); await tabA.engine.flush(); server.offline = false; server.calls = [];
    await Promise.all([tabA.engine.flush(), tabB.engine.flush()]);
    expect(server.calls).toHaveLength(2); expect(await tabA.outbox.list()).toHaveLength(0);
  });
  it('crash after the server applied but before the local record was removed: retry is recognised, not re-applied', async () => {
    const kv = memoryKV(), server = new FakeServer();
    const outbox = new Outbox(kv, 'user-a', uuid); let failRemove = true;
    const origRemove = outbox.remove.bind(outbox); outbox.remove = async k => { if (failRemove) { failRemove = false; throw new Error('tab killed'); } return origRemove(k); };
    const engine = createSyncEngine({ outbox, transport: server, runExclusive: localMutex() });
    await outbox.enqueue({ entity: 'tasks', kind: 'create', entityId: 't1', workspaceId: 'ws-1', baseVersion: null, payload: { title: 't1' } });
    await expect(engine.flush()).rejects.toThrow('tab killed');
    expect(await outbox.list()).toHaveLength(1);                        // still queued locally
    expect(await engine.flush()).toMatchObject({ applied: 1 });          // replay accepted
    expect(server.tasks.size).toBe(1); expect(await outbox.list()).toHaveLength(0);
  });
  it('generation changes during a flush so readers can detect a stale fetch', async () => {
    const t = setup(); const g0 = t.engine.generation; await t.create('a'); await t.engine.flush();
    expect(t.engine.generation).toBeGreaterThan(g0); expect(t.engine.busy).toBe(false);
  });
});

describe('conflict recovery', () => {
  async function conflicted() {
    const t = setup(); await t.create('t1'); await t.create('other'); await t.engine.flush();
    t.server.externalToggle('t1', true);                                // another device marks it done (v2)
    await t.toggle('t1', false, 1); await t.engine.flush();           // conflicts
    await t.toggle('t1', true, 1); await t.toggle('other', true, 1);  // later edit of the SAME task must also wait; other tasks proceed
    await t.engine.flush(); return t;
  }
  it('keeps the conflicted change (never drops it), blocks later edits of that task only, and lets other tasks sync', async () => {
    const t = await conflicted();
    const left = await t.outbox.list();
    expect(left.filter(m => m.status === 'conflict').map(m => m.entityId)).toEqual(['t1', 't1']);
    expect(left[0].serverState).toMatchObject({ version: 2, deleted: false, fields: { done: true } });
    expect(t.server.tasks.get('other')!.done).toBe(true);
    expect(t.server.tasks.get('t1')).toMatchObject({ done: true, version: 2 });
  });
  it('"keep mine" rebases onto the latest server version and applies', async () => {
    const t = await conflicted(); await t.engine.resolveConflict('tasks', 't1', 'mine'); await t.engine.flush();
    expect(await t.outbox.list()).toHaveLength(0);
    expect(t.server.tasks.get('t1')).toMatchObject({ done: true, version: 4 }); // false then true, both applied in order
  });
  it('"keep theirs" discards the local change and leaves the server untouched', async () => {
    const t = await conflicted(); await t.engine.resolveConflict('tasks', 't1', 'theirs'); await t.engine.flush();
    expect(await t.outbox.list()).toHaveLength(0);
    expect(t.server.tasks.get('t1')).toMatchObject({ done: true, version: 2 });
  });
  it('if the task was deleted elsewhere, "keep mine" cannot resurrect it', async () => {
    const t = setup(); await t.create('t1'); await t.engine.flush(); t.server.externalDelete('t1');
    await t.toggle('t1', true, 1); await t.engine.flush();
    expect((await t.outbox.list())[0]).toMatchObject({ status: 'conflict', serverState: { deleted: true } });
    await t.engine.resolveConflict('tasks', 't1', 'mine'); await t.engine.flush();
    expect(await t.outbox.list()).toHaveLength(0); expect(t.server.tasks.get('t1')!.deleted).toBe(true);
  });
  it('a stale edit that already matches the server converges without bothering the user', async () => {
    const t = setup(); await t.create('t1'); await t.engine.flush(); t.server.externalToggle('t1', true);
    await t.toggle('t1', true, 1); expect(await t.engine.flush()).toMatchObject({ applied: 1, conflicts: 0 });
  });
});

describe('account partitioning', () => {
  it("one account's outbox is invisible to another account's storage", async () => {
    const kvA = memoryKV(), kvB = memoryKV();
    const a = setup({ kv: kvA, user: 'user-a' }); a.server.offline = true; await a.create('secret');
    const b = setup({ kv: kvB, user: 'user-b' });
    expect(await b.outbox.list()).toHaveLength(0); expect(await a.outbox.list()).toHaveLength(1);
    await kvA.wipe(); expect(await a.outbox.list()).toHaveLength(0);
  });
});

describe('dependent records created offline (goal -> project -> task)', () => {
  it('are sent parent-first, so foreign keys hold', async () => {
    const t = setup(); t.server.offline = true;
    await t.create('goal'); await t.create('project'); await t.create('task'); await t.engine.flush();
    t.server.offline = false; const order: string[] = [];
    const orig = t.server.apply.bind(t.server); t.server.apply = async m => { order.push(m.entityId); return orig(m); };
    await t.engine.flush(); expect(order).toEqual(['goal', 'project', 'task']);
  });
  it('if a parent is rejected, its children are parked (not lost, not blocking unrelated work)', async () => {
    const t = setup();
    t.server.reject = m => (m.entityId === 'goal' ? 'check constraint' : m.payload.parent === 'goal' && !t.server.tasks.has('goal') ? 'foreign key' : null);
    await t.engine.submit({ entity: 'tasks', kind: 'create', entityId: 'goal', workspaceId: t.WS, baseVersion: null, payload: { title: 'g' } });
    await t.engine.submit({ entity: 'tasks', kind: 'create', entityId: 'child', workspaceId: t.WS, baseVersion: null, payload: { title: 'c', parent: 'goal' } });
    await t.create('unrelated'); await t.engine.flush();
    const left = await t.outbox.list();
    expect(left.map(m => [m.entityId, m.status])).toEqual([['goal', 'rejected'], ['child', 'rejected']]);
    expect(t.server.tasks.has('unrelated')).toBe(true);
  });
});
