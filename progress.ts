import type { Goal, Milestone, Project, Task } from './types';

/** Deterministic planning maths (no AI): progress and health are computed, never guessed. */
export type Stats = { done: number; total: number; pct: number | null };

export function projectStats(p: Project, tasks: Task[]): Stats {
  if (p.status === 'completed') { const t = tasks.filter(x => x.project_id === p.id); return { done: t.length, total: t.length, pct: 100 }; }
  const t = tasks.filter(x => x.project_id === p.id);
  const done = t.filter(x => x.done).length;
  return { done, total: t.length, pct: t.length ? Math.round((done / t.length) * 100) : null };
}
export function milestoneStats(projectId: string, milestones: Milestone[]): Stats {
  const m = milestones.filter(x => x.project_id === projectId);
  const done = m.filter(x => x.done).length;
  return { done, total: m.length, pct: m.length ? Math.round((done / m.length) * 100) : null };
}
/** Goal progress = equal-weight mean of its projects that have measurable work. null = nothing measurable yet. */
export function goalStats(g: Goal, projects: Project[], tasks: Task[]): Stats {
  const ps = projects.filter(p => p.goal_id === g.id);
  const measured = ps.map(p => projectStats(p, tasks)).filter(s => s.pct !== null);
  const done = ps.filter(p => p.status === 'completed').length;
  if (g.status === 'completed') return { done: ps.length, total: ps.length, pct: 100 };
  return { done, total: ps.length, pct: measured.length ? Math.round(measured.reduce((a, s) => a + (s.pct as number), 0) / measured.length) : null };
}
export type Health = 'complete' | 'paused' | 'no-deadline' | 'behind' | 'at-risk' | 'on-track';
const dayMs = 86_400_000;
export const daysUntil = (target: string, today: string) => Math.round((Date.parse(target + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / dayMs);
export function health(status: Goal['status'], targetDate: string | null, pct: number | null, today: string): Health {
  if (status === 'completed' || (pct ?? 0) >= 100) return 'complete';
  if (status === 'paused') return 'paused';
  if (!targetDate) return 'no-deadline';
  const d = daysUntil(targetDate, today);
  if (d < 0) return 'behind';
  if (d <= 7 && (pct ?? 0) < 80) return 'at-risk';
  return 'on-track';
}
