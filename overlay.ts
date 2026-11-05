import type { Mutation } from './outbox';
import type { Entity } from './types';

const DEFAULTS: Record<Entity, Record<string, unknown>> = {
  tasks: { priority: 'Medium', due: null, done: false, project_id: null, milestone_id: null },
  goals: { description: '', status: 'active', target_date: null },
  projects: { goal_id: null, status: 'active', target_date: null },
  milestones: { due: null, done: false },
};

/** Show local intent on top of the last-known server rows. Only PENDING work is overlaid; conflicted work is shown separately, never silently applied. */
export function overlay<T extends { id: string; version: number }>(server: T[], muts: Mutation[], ws: string, entity: Entity): T[] {
  let out = [...server];
  for (const m of muts) {
    if (m.status !== 'pending' || m.workspaceId !== ws || m.entity !== entity) continue;
    if (m.kind === 'create') {
      if (!out.some(r => r.id === m.entityId)) out.unshift({ id: m.entityId, workspace_id: ws, version: 1, ...DEFAULTS[entity], ...m.payload } as unknown as T);
    } else if (m.kind === 'update') out = out.map(r => (r.id === m.entityId ? ({ ...r, ...m.payload } as T) : r));
    else out = out.filter(r => r.id !== m.entityId);
  }
  return out;
}
