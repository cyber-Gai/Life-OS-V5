import { describe, expect, it } from 'vitest';
import { overlay } from '../../src/lib/overlay';
import type { Mutation } from '../../src/lib/outbox';
import { RetryableError } from '../../src/lib/sync';
import { classify, supabaseTransport } from '../../src/lib/transport';

describe('classify', () => {
  it.each([
    [0, 'TypeError: Failed to fetch', 'offline'], [undefined, 'Load failed', 'offline'],
    [401, 'x', 'auth'], [200, 'JWT expired', 'auth'], [503, 'x', 'server'], [429, 'x', 'server'],
    [403, 'permission denied', 'permanent'], [400, 'check constraint', 'permanent'], [404, 'function not found', 'permanent'],
  ])('%s %s -> %s', (status, message, want) => expect(classify(status as any, { message })).toBe(want));
});

describe('supabaseTransport', () => {
  const m = { opId: 'o', entity: 'tasks', kind: 'create', entityId: 't', workspaceId: 'w', baseVersion: null, payload: {}, userId: 'user-a' } as unknown as Mutation;
  const client = (session: any, rpc: any = async () => ({ data: { status: 'applied', version: 1 }, error: null, status: 200 })) =>
    ({ auth: { getSession: async () => ({ data: { session } }) }, rpc }) as any;
  it('refuses to send one account\'s queued work under a different session', async () => {
    let called = false;
    const t = supabaseTransport(client({ user: { id: 'user-b' } }, async () => { called = true; return {}; }));
    await expect(t.apply(m)).rejects.toBeInstanceOf(RetryableError); expect(called).toBe(false);
  });
  it('maps server outcomes: success, permanent rejection, retryable failure', async () => {
    const ok = supabaseTransport(client({ user: { id: 'user-a' } }));
    expect(await ok.apply(m)).toMatchObject({ status: 'applied' });
    const perm = supabaseTransport(client({ user: { id: 'user-a' } }, async () => ({ data: null, status: 403, error: { message: 'row-level security' } })));
    expect(await perm.apply(m)).toMatchObject({ status: 'rejected' });
    const down = supabaseTransport(client({ user: { id: 'user-a' } }, async () => ({ data: null, status: 0, error: { message: 'TypeError: Failed to fetch' } })));
    await expect(down.apply(m)).rejects.toMatchObject({ reason: 'offline' });
    const thrown = supabaseTransport(client({ user: { id: 'user-a' } }, async () => { throw new Error('socket'); }));
    await expect(thrown.apply(m)).rejects.toMatchObject({ reason: 'offline' });
  });
});

describe('overlay', () => {
  const mk = (p: Partial<Mutation>): Mutation => ({ workspaceId: 'w', attempts: 0, userId: 'u', createdAt: 0, opId: 'o', baseVersion: 1, key: 'k', entity: 'tasks', kind: 'update', entityId: 't', payload: {}, status: 'pending', ...p } as Mutation);
  const task = { id: 't', workspace_id: 'w', title: 'x', priority: 'Medium' as const, due: null, done: false, version: 1, project_id: null, milestone_id: null };
  it('applies pending intent only; conflicted/rejected work is not shown as applied', () => {
    expect(overlay([task], [mk({ payload: { done: true } })], 'w', 'tasks')[0].done).toBe(true);
    expect(overlay([task], [mk({ payload: { done: true }, status: 'conflict' })], 'w', 'tasks')[0].done).toBe(false);
    expect(overlay([task], [mk({ kind: 'delete' })], 'w', 'tasks')).toHaveLength(0);
  });
  it('shows a pending create once with defaults filled in, even if the server copy has arrived', () => {
    const c = mk({ kind: 'create', entityId: 'n', payload: { title: 'new' }, baseVersion: null });
    const out = overlay<any>([], [c], 'w', 'tasks');
    expect(out).toHaveLength(1); expect(out[0]).toMatchObject({ title: 'new', priority: 'Medium', done: false, project_id: null, version: 1 });
    expect(overlay([{ ...task, id: 'n' }], [c], 'w', 'tasks')).toHaveLength(1);
  });
  it('is scoped to its own entity and workspace', () => {
    const g = mk({ entity: 'goals', kind: 'create', entityId: 'g1', payload: { title: 'G' }, baseVersion: null });
    expect(overlay([], [g], 'w', 'tasks')).toHaveLength(0);
    expect(overlay([], [g], 'other', 'goals')).toHaveLength(0);
    expect(overlay<any>([], [g], 'w', 'goals')[0]).toMatchObject({ title: 'G', status: 'active', target_date: null });
  });
});
