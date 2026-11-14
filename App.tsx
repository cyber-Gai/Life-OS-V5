import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { Task, enqueue, flush, fetchTasks, loadCache, loadOutbox, newId, overlay, saveCache } from './lib/store';

type Workspace = { id: string; name: string; kind: string };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (!ready) return <p style={{ padding: 20 }}>Loading…</p>;
  if (!session) return (
    <main style={{ maxWidth: 420, margin: '20vh auto', padding: 20, textAlign: 'center', fontFamily: 'system-ui' }}>
      <h1>My Life OS</h1><p>V5 · slice 1</p>
      <button style={{ padding: '12px 18px', fontSize: 16 }}
        onClick={() => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } })}>
        Sign in with Google
      </button>
    </main>
  );
  return <Home key={session.user.id} session={session} />;
}

function Home({ session }: { session: Session }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ws, setWs] = useState<string>('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [note, setNote] = useState('');

  const refresh = useCallback(async (w: string) => {
    if (!w) return;
    const q = await loadOutbox(session.user.id);
    setPending(q.length);
    setTasks(overlay(await loadCache(session.user.id, w), q, w));            // instant, works offline
    if (!navigator.onLine) return;
    const res = await flush(session.user.id);
    if (res.conflicts.length) setNote(`${res.conflicts.length} change(s) conflicted with a newer edit and were not applied.`);
    try {
      const server = await fetchTasks(w);
      await saveCache(session.user.id, w, server);
      const q2 = await loadOutbox(session.user.id);
      setPending(q2.length);
      setTasks(overlay(server, q2, w));
    } catch { /* stay on cached view */ }
  }, [session.user.id]);

  useEffect(() => {
    (async () => {
      const workspaceStorageKey = `ws-list:${session.user.id}`;
      const cached = localStorage.getItem(workspaceStorageKey);
      if (cached) { const l = JSON.parse(cached); setWorkspaces(l); setWs(l[0]?.id ?? ''); }
      if (navigator.onLine) {
        const { data } = await supabase.rpc('ensure_default_workspaces');
        if (data) { localStorage.setItem(workspaceStorageKey, JSON.stringify(data)); setWorkspaces(data); setWs(w => w || data[0]?.id || ''); }
      }
    })();
  }, [session.user.id]);
  useEffect(() => { refresh(ws); }, [ws, refresh]);
  useEffect(() => {
    const on = () => { setOnline(true); refresh(ws); }, off = () => setOnline(false);
    const vis = () => { if (document.visibilityState === 'visible') refresh(ws); };
    addEventListener('online', on); addEventListener('offline', off); document.addEventListener('visibilitychange', vis);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); document.removeEventListener('visibilitychange', vis); };
  }, [ws, refresh]);

  async function add(e: React.FormEvent) {
    e.preventDefault(); const t = title.trim(); if (!t || !ws) return;
    const task: Task = { id: newId(), workspace_id: ws, title: t, priority: 'Medium', due: null, done: false, version: 1 };
    await enqueue(session.user.id, { key: newId(), kind: 'create', task }); setTitle(''); refresh(ws);
  }
  async function toggle(t: Task) {
    await enqueue(session.user.id, { key: newId(), kind: 'toggle', taskId: t.id, workspaceId: ws, done: !t.done, baseVersion: t.version }); refresh(ws);
  }
  async function remove(t: Task) {
    await enqueue(session.user.id, { key: newId(), kind: 'delete', taskId: t.id, workspaceId: ws, baseVersion: t.version }); refresh(ws);
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 16, fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Life OS</h1>
        <span>{online ? '🟢 online' : '🟠 offline'}{pending ? ` · ${pending} pending` : ''}</span>
        <button onClick={() => supabase.auth.signOut()}>Sign out</button>
      </header>
      <p style={{ color: '#667085' }}>{session.user.email}</p>
      <select value={ws} onChange={e => setWs(e.target.value)} style={{ padding: 8, marginBottom: 12 }}>
        {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
      <form onSubmit={add} style={{ display: 'flex', gap: 8 }}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Add a task" style={{ flex: 1, padding: 10 }} />
        <button>Add</button>
      </form>
      {note && <p role="alert" style={{ color: '#b54708' }}>{note}</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tasks.map(t => (
          <li key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #e6e9ef' }}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
            <span style={{ flex: 1, textDecoration: t.done ? 'line-through' : 'none' }}>{t.title}</span>
            <button onClick={() => remove(t)} aria-label="Delete">✕</button>
          </li>
        ))}
        {!tasks.length && <li style={{ color: '#667085' }}>No tasks in this workspace yet.</li>}
      </ul>
    </main>
  );
}
