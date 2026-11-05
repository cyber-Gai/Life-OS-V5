import { useState } from 'react';
import { daysUntil, goalStats, health, milestoneStats, projectStats, type Health } from './lib/progress';
import type { Data, Entity, Goal, Milestone, Project, Status, Task } from './lib/types';

export type Actions = {
  create: (e: Entity, payload: Record<string, unknown>) => Promise<unknown>;
  update: (e: Entity, row: { id: string; version: number }, payload: Record<string, unknown>) => Promise<unknown>;
  remove: (e: Entity, row: { id: string; version: number }) => Promise<unknown>;
};
const today = () => new Date().toISOString().slice(0, 10);
const box: React.CSSProperties = { border: '1px solid #e6e9ef', borderRadius: 10, padding: 12, margin: '10px 0' };
const HEALTH: Record<Health, [string, string]> = {
  'on-track': ['On track', '#067647'], 'at-risk': ['At risk', '#b54708'], behind: ['Behind', '#b42318'],
  complete: ['Complete', '#067647'], paused: ['Paused', '#667085'], 'no-deadline': ['No deadline', '#667085'],
};
const Bar = ({ pct }: { pct: number | null }) => (
  <div style={{ height: 8, background: '#eef2ff', borderRadius: 99, overflow: 'hidden' }}>
    <div style={{ height: '100%', width: `${pct ?? 0}%`, background: '#4f46e5' }} />
  </div>
);
function AddRow({ placeholder, onAdd, children }: { placeholder: string; onAdd: (title: string) => void; children?: React.ReactNode }) {
  const [v, setV] = useState('');
  return (
    <form style={{ display: 'flex', gap: 6, margin: '8px 0', flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); const t = v.trim(); if (t) { onAdd(t); setV(''); } }}>
      <input value={v} onChange={e => setV(e.target.value)} placeholder={placeholder} style={{ flex: 1, minWidth: 140, padding: 8 }} />
      {children}<button>Add</button>
    </form>
  );
}

export function TasksView({ data, act }: { data: Data; act: Actions }) {
  const [project, setProject] = useState('');
  const live = new Set(data.projects.map(p => p.id));
  return (
    <section>
      <AddRow placeholder="Add a task" onAdd={title => act.create('tasks', { title, ...(project ? { project_id: project } : {}) })}>
        <select value={project} onChange={e => setProject(e.target.value)} style={{ padding: 8 }}>
          <option value="">No project</option>
          {data.projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </AddRow>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {data.tasks.map((t: Task) => (
          <li key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #e6e9ef', flexWrap: 'wrap' }}>
            <input type="checkbox" checked={t.done} onChange={() => act.update('tasks', t, { done: !t.done })} />
            <span style={{ flex: 1, textDecoration: t.done ? 'line-through' : 'none' }}>{t.title}</span>
            <select value={t.project_id && live.has(t.project_id) ? t.project_id : ''} onChange={e => act.update('tasks', t, { project_id: e.target.value || null })}>
              <option value="">No project</option>
              {data.projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            <button onClick={() => act.remove('tasks', t)} aria-label="Delete task">✕</button>
          </li>
        ))}
        {!data.tasks.length && <li style={{ color: '#667085' }}>No tasks in this workspace yet.</li>}
      </ul>
    </section>
  );
}

function ProjectCard({ p, data, act }: { p: Project; data: Data; act: Actions }) {
  const s = projectStats(p, data.tasks), ms = data.milestones.filter(m => m.project_id === p.id), mst = milestoneStats(p.id, data.milestones);
  return (
    <div style={{ ...box, background: '#fafbff' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <b style={{ flex: 1 }}>📁 {p.title}</b>
        <select value={p.status} onChange={e => act.update('projects', p, { status: e.target.value as Status })}>
          <option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option>
        </select>
        <button onClick={() => act.remove('projects', p)} aria-label="Delete project">✕</button>
      </div>
      <Bar pct={s.pct} />
      <div style={{ fontSize: 12, color: '#667085', margin: '4px 0' }}>
        {s.total ? `${s.done}/${s.total} tasks · ${s.pct}%` : 'No tasks yet — assign tasks to this project from the Tasks tab'}
        {mst.total ? ` · ${mst.done}/${mst.total} milestones` : ''}
      </div>
      {ms.map((m: Milestone) => (
        <label key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
          <input type="checkbox" checked={m.done} onChange={() => act.update('milestones', m, { done: !m.done })} />
          <span style={{ flex: 1, textDecoration: m.done ? 'line-through' : 'none' }}>🏁 {m.title}</span>
          <button type="button" onClick={() => act.remove('milestones', m)} aria-label="Delete milestone">✕</button>
        </label>
      ))}
      <AddRow placeholder="Add milestone" onAdd={title => act.create('milestones', { title, project_id: p.id })} />
    </div>
  );
}

export function GoalsView({ data, act }: { data: Data; act: Actions }) {
  const [goal, setGoal] = useState('');
  const [date, setDate] = useState('');
  const goalIds = new Set(data.goals.map(g => g.id));
  const unlinked = data.projects.filter(p => !p.goal_id || !goalIds.has(p.goal_id));
  return (
    <section>
      <AddRow placeholder="New goal — what do you want to achieve?" onAdd={title => act.create('goals', { title, ...(date ? { target_date: date } : {}) })}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ padding: 8 }} aria-label="Target date" />
      </AddRow>
      {data.goals.map((g: Goal) => {
        const st = goalStats(g, data.projects, data.tasks), h = health(g.status, g.target_date, st.pct, today()), [label, color] = HEALTH[h];
        return (
          <div key={g.id} style={box}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ flex: 1 }}>🎯 {g.title}</b>
              <span style={{ color, fontWeight: 600, fontSize: 12 }}>{label}</span>
              <select value={g.status} onChange={e => act.update('goals', g, { status: e.target.value as Status })}>
                <option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option>
              </select>
              <button onClick={() => act.remove('goals', g)} aria-label="Delete goal">✕</button>
            </div>
            <Bar pct={st.pct} />
            <div style={{ fontSize: 12, color: '#667085', margin: '4px 0' }}>
              {st.pct === null ? 'No measurable work yet — add a project and assign tasks' : `${st.pct}% complete`}
              {g.target_date ? ` · target ${g.target_date} (${daysUntil(g.target_date, today())} days)` : ''}
            </div>
            {data.projects.filter(p => p.goal_id === g.id).map(p => <ProjectCard key={p.id} p={p} data={data} act={act} />)}
            <AddRow placeholder="Add project to this goal" onAdd={title => act.create('projects', { title, goal_id: g.id })} />
          </div>
        );
      })}
      {!data.goals.length && <p style={{ color: '#667085' }}>No goals yet.</p>}
      <div style={box}>
        <b>Projects without a goal</b>
        {unlinked.map(p => (
          <div key={p.id}>
            <ProjectCard p={p} data={data} act={act} />
            {data.goals.length > 0 && (
              <select defaultValue="" onChange={e => e.target.value && act.update('projects', p, { goal_id: e.target.value })}>
                <option value="">Link to a goal…</option>
                {data.goals.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            )}
          </div>
        ))}
        <AddRow placeholder="Add standalone project" onAdd={title => act.create('projects', { title })} />
      </div>
    </section>
  );
}
