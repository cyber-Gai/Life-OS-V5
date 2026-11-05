import { describe, expect, it } from 'vitest';
import { goalStats, health, milestoneStats, projectStats } from '../../src/lib/progress';

const T = (id: string, project_id: string | null, done: boolean) => ({ id, project_id, done }) as any;
const P = (id: string, goal_id: string | null, status = 'active') => ({ id, goal_id, status }) as any;
const G = (id: string, status = 'active') => ({ id, status }) as any;

describe('progress', () => {
  it('project progress is done/total of its tasks; no tasks means "not measurable", not 0%', () => {
    const tasks = [T('1', 'p', true), T('2', 'p', false), T('3', 'p', false), T('4', 'other', true)];
    expect(projectStats(P('p', null), tasks)).toEqual({ done: 1, total: 3, pct: 33 });
    expect(projectStats(P('empty', null), tasks)).toEqual({ done: 0, total: 0, pct: null });
    expect(projectStats(P('p', null, 'completed'), tasks).pct).toBe(100);
  });
  it('goal progress is the equal-weight mean of measurable projects; unmeasurable projects do not drag it down', () => {
    const tasks = [T('1', 'a', true), T('2', 'a', true), T('3', 'b', true), T('4', 'b', false)];
    const projects = [P('a', 'g'), P('b', 'g'), P('c', 'g'), P('x', 'other')];
    expect(goalStats(G('g'), projects, tasks).pct).toBe(75);             // (100 + 50) / 2, project c ignored
    expect(goalStats(G('g'), [P('c', 'g')], tasks).pct).toBeNull();
    expect(goalStats(G('g', 'completed'), projects, tasks).pct).toBe(100);
  });
  it('milestone stats', () => {
    const ms = [{ project_id: 'p', done: true }, { project_id: 'p', done: false }, { project_id: 'q', done: true }] as any;
    expect(milestoneStats('p', ms)).toEqual({ done: 1, total: 2, pct: 50 });
  });
});

describe('health', () => {
  const today = '2026-11-04';
  it.each([
    ['active', '2026-12-15', 40, 'on-track'], ['active', '2026-11-08', 40, 'at-risk'], ['active', '2026-11-08', 85, 'on-track'],
    ['active', '2026-11-03', 40, 'behind'], ['active', '2026-11-04', 10, 'at-risk'], ['active', null, 10, 'no-deadline'],
    ['paused', '2026-11-03', 10, 'paused'], ['completed', '2026-11-03', 10, 'complete'], ['active', '2026-11-03', 100, 'complete'],
    ['active', '2026-11-11', null, 'at-risk'], ['active', '2026-11-12', null, 'on-track'],
  ])('%s / %s / %s%% -> %s', (status, target, pct, want) => expect(health(status as any, target as any, pct as any, today)).toBe(want));
});
