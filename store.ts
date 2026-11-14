import { get, set } from 'idb-keyval';
import { supabase } from './supabase';

export type Task = {
  id: string; workspace_id: string; title: string; priority: 'High' | 'Medium' | 'Low';
  due: string | null; done: boolean; version: number; deleted_at?: string | null;
};
export type Mutation =
  | { key: string; kind: 'create'; task: Task }
  | { key: string; kind: 'toggle'; taskId: string; workspaceId: string; done: boolean; baseVersion: number }
  | { key: string; kind: 'delete'; taskId: string; workspaceId: string; baseVersion: number };

// Partition browser storage by authenticated user so accounts never share cached data.
const qKey = (userId: string) => `outbox:${userId}`;
const cacheKey = (userId: string, ws: string) => `tasks:${userId}:${ws}`;
export const newId = () => crypto.randomUUID();

export const loadOutbox = async (userId: string): Promise<Mutation[]> => (await get(qKey(userId))) ?? [];
const saveOutbox = (userId: string, q: Mutation[]) => set(qKey(userId), q);
export const loadCache = async (userId: string, ws: string): Promise<Task[]> => (await get(cacheKey(userId, ws))) ?? [];
export const saveCache = (userId: string, ws: string, t: Task[]) => set(cacheKey(userId, ws), t);

export async function enqueue(userId: string, m: Mutation) { const q = await loadOutbox(userId); q.push(m); await saveOutbox(userId, q); }

/** Apply queued (unsynced) mutations on top of a task list so the UI shows local intent. */
export function overlay(tasks: Task[], q: Mutation[], ws: string): Task[] {
  let out = [...tasks];
  for (const m of q) {
    if (m.kind === 'create' && m.task.workspace_id === ws && !out.some(t => t.id === m.task.id)) out.unshift(m.task);
    if (m.kind === 'toggle' && m.workspaceId === ws) out = out.map(t => t.id === m.taskId ? { ...t, done: m.done } : t);
    if (m.kind === 'delete' && m.workspaceId === ws) out = out.filter(t => t.id !== m.taskId);
  }
  return out;
}

export type SyncResult = { sent: number; conflicts: string[]; stopped?: string };

/** Flush the outbox in order. Creates are idempotent (client UUID); updates are version-checked. */
export async function flush(userId: string): Promise<SyncResult> {
  const q = await loadOutbox(userId); const rest: Mutation[] = []; const conflicts: string[] = []; let sent = 0;
  for (let i = 0; i < q.length; i++) {
    const m = q[i];
    try {
      if (m.kind === 'create') {
        const { id, workspace_id, title, priority, due, done } = m.task;
        const { error } = await supabase.from('tasks').upsert(
          { id, workspace_id, title, priority, due, done }, { onConflict: 'id', ignoreDuplicates: true });
        if (error) throw error;
      } else {
        const patch = m.kind === 'toggle'
          ? { done: m.done, completed_at: m.done ? new Date().toISOString() : null }
          : { deleted_at: new Date().toISOString() };
        const { data, error } = await supabase.from('tasks').update(patch)
          .eq('id', m.taskId).eq('version', m.baseVersion).select('id');
        if (error) throw error;
        if (!data || data.length === 0) { conflicts.push(m.key); continue; } // someone changed it first: surface, don't overwrite
      }
      sent++;
    } catch (e: any) {
      // Network failure => keep this and everything after it for the next attempt.
      if (e?.message && /fetch|network|Failed/i.test(e.message)) { rest.push(...q.slice(i)); await saveOutbox(userId, rest); return { sent, conflicts, stopped: 'offline' }; }
      rest.push(...q.slice(i)); await saveOutbox(userId, rest); return { sent, conflicts, stopped: e?.message ?? 'error' };
    }
  }
  await saveOutbox(userId, rest);
  return { sent, conflicts };
}

export async function fetchTasks(ws: string): Promise<Task[]> {
  const { data, error } = await supabase.from('tasks')
    .select('id,workspace_id,title,priority,due,done,version,deleted_at')
    .eq('workspace_id', ws).is('deleted_at', null).order('due', { nullsFirst: false }).order('created_at', { ascending: false });
  if (error) throw error;
  return data as Task[];
}
