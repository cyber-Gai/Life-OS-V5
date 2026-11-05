import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { fetchAll, loadCache, loadWorkspaces, saveCache, saveWorkspaces } from './lib/api';
import { idbKV, purgeLegacyShared } from './lib/kv';
import { Outbox, type Mutation } from './lib/outbox';
import { overlay } from './lib/overlay';
import { createSyncEngine, webLocksExclusive } from './lib/sync';
import { supabaseTransport } from './lib/transport';
import { ENTITIES, emptyData, type Data, type Entity, type Workspace } from './lib/types';
import { GoalsView, TasksView, type Actions } from './views';

declare const __BUILD_ID__: string;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    purgeLegacyShared();
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (!ready) return <p style={{ padding: 20 }}>Loading…</p>;
  if (!session) return (
    <main style={{ maxWidth: 420, margin: '20vh auto', padding: 20, textAlign: 'center', fontFamily: 'system-ui' }}>
      <h1>My Life OS</h1><p>V5</p>
      <button style={{ padding: '12px 18px', fontSize: 16 }}
        onClick={() => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } })}>
        Sign in with Google
      </button>
      <p style={{ color: '#667085', fontSize: 12 }}>build {__BUILD_ID__}</p>
    </main>
  );
  // key => all state is discarded and rebuilt when the account changes
  return <Home key={session.user.id} session={session} />;
}

function Home({ session }: { session: Session }) {
  const uid = session.user.id;
  const ctx = useMemo(() => {
    const kv = idbKV(uid);                       // storage partitioned by account
    return { kv, outbox: new Outbox(kv, uid) };
  }, [uid]);
  const { kv, outbox } = ctx;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ws, setWs] = useState('');
  const [tab, setTab] = useState<'goals' | 'tasks'>('goals');
  const [data, setData] = useState<Data>(emptyData());
  const [muts, setMuts] = useState<Mutation[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [note, setNote] = useState('');
  const wsRef = useRef(''); wsRef.current = ws;
  const seq = useRef(0);

  const showLocal = useCallback(async (w: string, my?: number) => {
    const [cache, m] = await Promise.all([loadCache(kv, w), outbox.list()]);
    if (my !== undefined && my !== seq.current) return false;
    const next = emptyData();
    for (const e of ENTITIES) (next as any)[e] = overlay(cache[e] as any[], m, w, e);
    setMuts(m); setData(next); return true;
  }, [kv, outbox]);

  const engine = useMemo(() => createSyncEngine({
    outbox, transport: supabaseTransport(supabase), runExclusive: webLocksExclusive(`lifeos-sync-${uid}`),
    onChange: () => { if (wsRef.current) void showLocal(wsRef.current); },
  }), [outbox, uid, showLocal]);

  const refresh = useCallback(async (w: string) => {
    if (!w) return;
    const my = ++seq.current;                    // a newer refresh invalidates this one
    if (!(await showLocal(w, my)) || !navigator.onLine) return;
    const s = await engine.flush();
    if (my !== seq.current) return;
    if (s.stopped === 'auth') setNote('Session problem — sign in again to sync. Your changes are kept on this device.');
    else if (s.conflicts) setNote('Some changes conflict with newer edits. Review them below.');
    else setNote('');
    try {
      let server: Data, g: number, tries = 0;
      do { g = engine.generation; server = await fetchAll(supabase, w); } while ((engine.generation !== g || engine.busy) && ++tries < 3); // outbox changed mid-fetch => fetch again
      if (my !== seq.current) return;
      await saveCache(kv, w, server);
      await showLocal(w, my);
    } catch { /* keep the cached view */ }
  }, [engine, kv, showLocal]);

  useEffect(() => {
    (async () => {
      const cached = await loadWorkspaces(kv);
      if (cached.length) { setWorkspaces(cached); setWs(w => w || cached[0].id); }
      if (!navigator.onLine) return;
      const { data: list } = await supabase.rpc('ensure_default_workspaces');
      if (list) { await saveWorkspaces(kv, list as Workspace[]); setWorkspaces(list as Workspace[]); setWs(w => w || (list as Workspace[])[0]?.id || ''); }
    })();
  }, [kv]);
  useEffect(() => { void refresh(ws); }, [ws, refresh]);
  useEffect(() => {
    const on = () => { setOnline(true); void refresh(wsRef.current); }, off = () => setOnline(false);
    const vis = () => { if (document.visibilityState === 'visible') void refresh(wsRef.current); };
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) void refresh(wsRef.current); }, 30_000);
    addEventListener('online', on); addEventListener('offline', off); document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(timer); removeEventListener('online', on); removeEventListener('offline', off); document.removeEventListener('visibilitychange', vis); };
  }, [refresh]);

  const act: Actions = useMemo(() => ({
    create: (entity, payload) => engine.submit({ entity, kind: 'create', entityId: crypto.randomUUID(), workspaceId: wsRef.current, baseVersion: null, payload }),
    update: (entity, row, payload) => engine.submit({ entity, kind: 'update', entityId: row.id, workspaceId: wsRef.current, baseVersion: row.version, payload }),
    remove: (entity, row) => engine.submit({ entity, kind: 'delete', entityId: row.id, workspaceId: wsRef.current, baseVersion: row.version, payload: {} }),
  }), [engine]);

  async function signOut(wipe: boolean) {
    const unsynced = (await outbox.list()).length;
    if (unsynced) {
      const ok = confirm(wipe
        ? `${unsynced} change(s) have not synced and will be permanently lost. Clear this device anyway?`
        : `${unsynced} change(s) have not synced yet. They stay on this device and sync next time you sign in as ${session.user.email}. Sign out?`);
      if (!ok) return;
    }
    if (wipe) await kv.wipe();
    await supabase.auth.signOut();
  }

  const pending = muts.filter(m => m.status === 'pending').length;
  const conflictRefs = [...new Map(muts.filter(m => m.status === 'conflict').map(m => [`${m.entity}:${m.entityId}`, m])).values()];
  const rejected = muts.filter(m => m.status === 'rejected');
  const label = (entity: Entity, id: string) =>
    (data[entity] as { id: string; title: string }[]).find(r => r.id === id)?.title
    ?? (muts.find(m => m.entity === entity && m.entityId === id && m.payload.title)?.payload.title as string | undefined)
    ?? muts.find(m => m.entity === entity && m.entityId === id)?.serverState?.title ?? `a ${entity.slice(0, -1)}`;
  const mine = (m: Mutation) => m.kind === 'delete' ? 'delete it' : `set ${Object.entries(m.payload).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}`;

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16, fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Life OS</h1>
        <span>{online ? '🟢 online' : '🟠 offline'}{pending ? ` · ${pending} pending` : ''}</span>
        <span><button onClick={() => signOut(false)}>Sign out</button> <button onClick={() => signOut(true)} title="Sign out and erase this account's data from this device">Sign out &amp; clear device</button></span>
      </header>
      <p style={{ color: '#667085' }}>{session.user.email}</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={ws} onChange={e => setWs(e.target.value)} style={{ padding: 8 }}>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        {(['goals', 'tasks'] as const).map(t => <button key={t} onClick={() => setTab(t)} style={{ fontWeight: tab === t ? 700 : 400 }}>{t === 'goals' ? '🎯 Goals & projects' : '✅ Tasks'}</button>)}
      </div>
      {note && <p role="alert" style={{ color: '#b54708' }}>{note}</p>}

      {conflictRefs.length > 0 && <section style={{ border: '1px solid #f79009', borderRadius: 10, padding: 12, margin: '12px 0' }}>
        <b>Needs your decision</b>
        {conflictRefs.map(m => {
          const s = m.serverState;
          return <div key={`${m.entity}:${m.entityId}`} style={{ padding: '8px 0', borderTop: '1px solid #eee' }}>
            <div>“{label(m.entity, m.entityId)}” was changed elsewhere ({s?.deleted ? 'it was deleted' : `server now has ${JSON.stringify(s?.fields ?? {})}`}). Your queued change: {mine(m)}.</div>
            <button onClick={() => engine.resolveConflict(m.entity, m.entityId, 'theirs')}>Keep theirs</button>{' '}
            {!s?.deleted && <button onClick={() => engine.resolveConflict(m.entity, m.entityId, 'mine')}>Apply mine</button>}
          </div>;
        })}
      </section>}

      {rejected.length > 0 && <section style={{ border: '1px solid #d92d20', borderRadius: 10, padding: 12, margin: '12px 0' }}>
        <b>Could not be saved</b>
        {rejected.map(m => <div key={m.key} style={{ padding: '8px 0', borderTop: '1px solid #eee' }}>
          <div>{m.kind} {m.entity.slice(0, -1)} “{label(m.entity, m.entityId)}” — {m.error}</div>
          <button onClick={() => engine.retryRejected(m.key)}>Retry</button> <button onClick={() => engine.discard(m.key)}>Discard</button>
        </div>)}
      </section>}

      {ws && (tab === 'goals' ? <GoalsView data={data} act={act} /> : <TasksView data={data} act={act} />)}
      <p style={{ color: '#98a2b3', fontSize: 11 }}>build {__BUILD_ID__}</p>
    </main>
  );
}
