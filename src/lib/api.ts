import type { SupabaseClient } from '@supabase/supabase-js';
import type { KV } from './kv';
import { ENTITIES, emptyData, type Data, type Entity, type Workspace } from './types';

const COLUMNS: Record<Entity, string> = {
  tasks: 'id,workspace_id,version,title,priority,due,done,project_id,milestone_id',
  goals: 'id,workspace_id,version,title,description,status,target_date',
  projects: 'id,workspace_id,version,title,goal_id,status,target_date',
  milestones: 'id,workspace_id,version,title,project_id,due,done',
};
export async function fetchAll(supabase: SupabaseClient, ws: string): Promise<Data> {
  const parts = await Promise.all(ENTITIES.map(async e => {
    const { data, error } = await supabase.from(e).select(COLUMNS[e]).eq('workspace_id', ws).is('deleted_at', null).order('created_at', { ascending: false });
    if (error) throw error;
    return [e, data ?? []] as const;
  }));
  return Object.fromEntries(parts) as unknown as Data;   // all-or-nothing: a partial fetch is never cached
}
export async function loadCache(kv: KV, ws: string): Promise<Data> {
  const out = emptyData();
  for (const e of ENTITIES) (out as any)[e] = (await kv.get<any[]>(`data:${ws}:${e}`)) ?? [];
  return out;
}
export async function saveCache(kv: KV, ws: string, d: Data) { for (const e of ENTITIES) await kv.set(`data:${ws}:${e}`, d[e]); }
export const loadWorkspaces = async (kv: KV) => (await kv.get<Workspace[]>('workspaces')) ?? [];
export const saveWorkspaces = (kv: KV, w: Workspace[]) => kv.set('workspaces', w);
