// Runs the REAL migrations (0001 then 0002) in an in-process Postgres and attacks them as different roles/users.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

const dir = new URL('../../../supabase/migrations/', import.meta.url);
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const op = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let db: PGlite;
let wsA: string, wsB: string;

// Emulates what Supabase provides: roles, auth.uid(), and its permissive default grants (so our REVOKEs are actually tested).
const prelude = `
  create role anon nologin; create role authenticated nologin;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  insert into auth.users(id) values ('${A}'), ('${B}');
`;

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  try { return await fn(); } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub','',false)`); }
}
const mutate = async (uid: string, n: number, kind: string, task: string, ws: string, base: number | null, payload: object = {}) =>
  as(uid, async () => (await db.query<{ r: any }>(
    `select public.apply_task_mutation($1::uuid,$2,$3::uuid,$4::uuid,$5::int,$6::jsonb) as r`,
    [op(n), kind, task, ws, base, JSON.stringify(payload)])).rows[0].r);
const rows = async (uid: string | null, sql: string) => as(uid, async () => (await db.query<any>(sql)).rows);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(prelude);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    // gen_random_uuid() is core in PG13+; the pgcrypto extension line is only needed on Supabase.
    await db.exec(readFileSync(new URL(f, dir), 'utf8').replace(/create extension[^;]*;/gi, ''));
  }
  await as(A, () => db.query('select * from public.ensure_default_workspaces()'));
  await as(B, () => db.query('select * from public.ensure_default_workspaces()'));
  wsA = (await rows(A, `select id from public.workspaces where kind='personal'`))[0].id;
  wsB = (await rows(B, `select id from public.workspaces where kind='personal'`))[0].id;
});

describe('bootstrap', () => {
  it('creates exactly four default workspaces per user and is idempotent', async () => {
    await as(A, () => db.query('select * from public.ensure_default_workspaces()'));
    const r = await rows(A, `select kind from public.workspaces order by kind`);
    expect(r.map(x => x.kind)).toEqual(['academic', 'mubah', 'personal', 'professional']);
  });
  it('a database-level unique index blocks duplicate defaults', async () => {
    await expect(db.query(`insert into public.workspaces(name,kind,owner_id,is_default) values ('x','personal','${A}',true)`)).rejects.toThrow();
  });
});

describe('isolation', () => {
  it('anon has no access to anything', async () => {
    for (const t of ['tasks', 'workspaces', 'memberships', 'audit_log', 'applied_ops'])
      await expect(rows(null, `select * from public.${t}`)).rejects.toThrow(/permission denied/);
    await expect(as(null, () => db.query(`select public.apply_task_mutation('${op(900)}','create','${tid(900)}','${wsA}',null,'{}')`))).rejects.toThrow(/permission denied/);
  });
  it("user B cannot see user A's workspaces, tasks or audit rows", async () => {
    expect((await mutate(A, 1, 'create', tid(1), wsA, null, { title: 'A secret' })).status).toBe('applied');
    expect(await rows(B, `select * from public.tasks`)).toHaveLength(0);
    expect(await rows(B, `select id from public.workspaces where owner_id='${A}'`)).toHaveLength(0);
    expect(await rows(B, `select * from public.audit_log where workspace_id='${wsA}'`)).toHaveLength(0);
  });
  it("user B cannot create into A's workspace (RLS), nor touch A's task", async () => {
    await expect(mutate(B, 2, 'create', tid(2), wsA, null, { title: 'planted' })).rejects.toThrow(/row-level security/);
    expect((await mutate(B, 3, 'toggle', tid(1), wsA, 1, { done: true })).status).toBe('rejected');
    expect((await mutate(B, 4, 'delete', tid(1), wsA, 1)).status).toBe('rejected');
    expect((await rows(A, `select done, version from public.tasks where id='${tid(1)}'`))[0]).toEqual({ done: false, version: 1 });
  });
  it("B cannot hijack A's task id by creating it in B's own workspace", async () => {
    expect((await mutate(B, 5, 'create', tid(1), wsB, null, { title: 'hijack' })).status).toBe('rejected');
    expect((await rows(A, `select title from public.tasks where id='${tid(1)}'`))[0].title).toBe('A secret');
  });
  it('a viewer can read but not write', async () => {
    await db.exec(`insert into public.memberships(workspace_id,user_id,role) values ('${wsA}','${B}','viewer')`);
    expect(await rows(B, `select id from public.tasks where workspace_id='${wsA}'`)).toHaveLength(1);
    await expect(mutate(B, 6, 'create', tid(6), wsA, null, { title: 'nope' })).rejects.toThrow(/row-level security/);
    expect((await mutate(B, 7, 'toggle', tid(1), wsA, 1, { done: true })).status).toBe('rejected');
    await db.exec(`update public.memberships set role='editor' where workspace_id='${wsA}' and user_id='${B}'`);
    expect((await mutate(B, 8, 'create', tid(8), wsA, null, { title: 'shared edit' })).status).toBe('applied');
    await db.exec(`delete from public.memberships where workspace_id='${wsA}' and user_id='${B}'`);
    expect(await rows(B, `select id from public.tasks where workspace_id='${wsA}'`)).toHaveLength(0);
  });
});

describe('least privilege (direct table access)', () => {
  it('clients cannot set server-owned columns on insert', async () => {
    await expect(as(A, () => db.query(`insert into public.tasks(id,workspace_id,title,version) values ('${tid(50)}','${wsA}','x',999)`))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => db.query(`insert into public.tasks(id,workspace_id,title,created_by) values ('${tid(51)}','${wsA}','x','${B}')`))).rejects.toThrow(/permission denied/);
  });
  it('clients cannot rewrite version, completed_at, created_by, workspace_id', async () => {
    for (const col of ["version=1", "completed_at=now()", `created_by='${B}'`, `workspace_id='${wsB}'`])
      await expect(as(A, () => db.query(`update public.tasks set ${col} where id='${tid(1)}'`))).rejects.toThrow(/permission denied/);
  });
  it('clients cannot DELETE, and cannot write workspaces/memberships/audit/ledger directly', async () => {
    await expect(as(A, () => db.query(`delete from public.tasks where id='${tid(1)}'`))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => db.query(`update public.workspaces set name='pwn'`))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => db.query(`insert into public.memberships(workspace_id,user_id,role) values ('${wsB}','${A}','owner')`))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => db.query(`insert into public.audit_log(workspace_id,table_name,row_id,action) values ('${wsA}','tasks','${tid(1)}','x')`))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => db.query(`update public.applied_ops set result='{}'`))).rejects.toThrow(/permission denied/);
  });
  it('even a privileged role cannot edit or delete the audit log', async () => {
    await expect(db.query(`update public.audit_log set action='forged'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from public.audit_log`)).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate public.audit_log`)).rejects.toThrow(/append-only/);
  });
  it('a direct (non-RPC) insert still gets server-owned values from the trigger', async () => {
    await as(A, () => db.query(`insert into public.tasks(id,workspace_id,title,done) values ('${tid(52)}','${wsA}','direct',true)`));
    const r = (await rows(A, `select version, created_by, completed_at is not null as c from public.tasks where id='${tid(52)}'`))[0];
    expect(r).toEqual({ version: 1, created_by: A, c: true });
  });
});

describe('apply_task_mutation', () => {
  it('replaying the same op id returns the original outcome and applies nothing twice', async () => {
    await mutate(A, 20, 'create', tid(20), wsA, null, { title: 'idem' });
    const first = await mutate(A, 21, 'toggle', tid(20), wsA, 1, { done: true });
    expect(first).toMatchObject({ status: 'applied', version: 2 });
    const again = await mutate(A, 21, 'toggle', tid(20), wsA, 1, { done: true });
    expect(again).toMatchObject({ status: 'applied', version: 2, replayed: true });
    expect((await rows(A, `select version from public.tasks where id='${tid(20)}'`))[0].version).toBe(2);
    expect(Number((await rows(A, `select count(*)::int as n from public.audit_log where row_id='${tid(20)}'`))[0].n)).toBe(2);
  });
  it('a replayed create with a fresh op id is a harmless no-op', async () => {
    expect(await mutate(A, 22, 'create', tid(20), wsA, null, { title: 'idem' })).toMatchObject({ status: 'applied', version: 2 });
    expect(Number((await rows(A, `select count(*)::int as n from public.tasks where id='${tid(20)}'`))[0].n)).toBe(1);
  });
  it('a stale base version is reported as a conflict with the server state, and nothing is overwritten', async () => {
    const r = await mutate(A, 23, 'toggle', tid(20), wsA, 1, { done: false });
    expect(r).toMatchObject({ status: 'conflict', server: { version: 2, done: true, deleted: false } });
    expect((await rows(A, `select done from public.tasks where id='${tid(20)}'`))[0].done).toBe(true);
  });
  it('a stale write whose outcome already holds converges silently', async () => {
    expect(await mutate(A, 24, 'toggle', tid(20), wsA, 1, { done: true })).toMatchObject({ status: 'applied', noop: true, version: 2 });
  });
  it('completed_at is server-controlled and follows done', async () => {
    const t = async () => (await rows(A, `select completed_at is not null as c from public.tasks where id='${tid(20)}'`))[0].c;
    expect(await t()).toBe(true);
    await mutate(A, 25, 'toggle', tid(20), wsA, 2, { done: false, completed_at: '1999-01-01' });
    expect(await t()).toBe(false);
  });
  it('delete is terminal: later edits conflict as "deleted", repeat deletes are no-ops', async () => {
    await mutate(A, 26, 'create', tid(26), wsA, null, { title: 'doomed' });
    expect(await mutate(A, 27, 'delete', tid(26), wsA, 1)).toMatchObject({ status: 'applied', version: 2 });
    expect(await mutate(A, 28, 'toggle', tid(26), wsA, 2, { done: true })).toMatchObject({ status: 'conflict', server: { deleted: true } });
    expect(await mutate(A, 29, 'delete', tid(26), wsA, 1)).toMatchObject({ status: 'applied', noop: true });
    await expect(as(A, () => db.query(`update public.tasks set title='zombie' where id='${tid(26)}'`))).rejects.toThrow(/deleted/);
  });
  it('bad input is rejected loudly, not stored', async () => {
    await expect(mutate(A, 30, 'toggle', tid(20), wsA, null, { done: true })).rejects.toThrow(/base_version/);
    await expect(mutate(A, 31, 'explode', tid(20), wsA, 1)).rejects.toThrow(/unknown mutation kind/);
    await expect(mutate(A, 32, 'create', tid(32), wsA, null, { title: 'x', priority: 'Urgent' })).rejects.toThrow(/check constraint/);
    await expect(mutate(A, 33, 'create', tid(33), wsA, null, { title: '' })).rejects.toThrow(/check constraint/);
  });
  it("one user's op ids are invisible to another", async () => {
    expect(await rows(B, `select 1 from public.applied_ops where user_id='${A}'`)).toHaveLength(0);
    expect((await rows(B, `select distinct user_id from public.applied_ops`)).every(r => r.user_id === B)).toBe(true);
  });
});

describe('upgrade path', () => {
  it('0002 applies cleanly on top of a database that already holds 0001 data (including racing duplicate workspaces)', async () => {
    const old = new PGlite(); await old.exec(prelude);
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    await old.exec(readFileSync(new URL(files[0], dir), 'utf8').replace(/create extension[^;]*;/gi, ''));
    // data as 0001 would have produced it, incl. the double-bootstrap race it allowed
    await old.exec(`
      insert into public.workspaces(id,name,kind,owner_id) values
        ('30000000-0000-4000-8000-000000000001','Personal','personal','${A}'),
        ('30000000-0000-4000-8000-000000000002','Personal','personal','${A}');
      insert into public.memberships values ('30000000-0000-4000-8000-000000000001','${A}','owner');
      insert into public.tasks(id,workspace_id,title,created_by) values ('${tid(70)}','30000000-0000-4000-8000-000000000001','legacy','${A}');`);
    await old.exec(readFileSync(new URL(files[1], dir), 'utf8'));
    expect((await old.query<any>(`select count(*)::int n from public.tasks`)).rows[0].n).toBe(1);        // nothing lost
    expect((await old.query<any>(`select count(*)::int n from public.workspaces where is_default`)).rows[0].n).toBe(1); // exactly one default kept
    expect((await old.query<any>(`select count(*)::int n from public.workspaces`)).rows[0].n).toBe(2);   // duplicate preserved, not deleted
  });
});

describe('planning hierarchy + generic mutation', () => {
  const gm = (uid: string, n: number, entity: string, kind: string, id: string, ws: string, base: number | null, payload: object = {}) =>
    as(uid, async () => (await db.query<{ r: any }>(
      `select public.apply_mutation($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::int,$7::jsonb) as r`,
      [op(n), entity, kind, id, ws, base, JSON.stringify(payload)])).rows[0].r);
  const gid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let wsA2: string;
  beforeAll(async () => { wsA2 = (await rows(A, `select id from public.workspaces where kind='academic'`))[0].id; });

  it('creates goal -> project -> milestone -> task, all server-versioned and audited', async () => {
    expect(await gm(A, 100, 'goals', 'create', gid(1), wsA, null, { title: 'Pass GPPQE', target_date: '2026-12-15' })).toMatchObject({ status: 'applied', version: 1 });
    expect(await gm(A, 101, 'projects', 'create', gid(2), wsA, null, { title: 'Pharmacology revision', goal_id: gid(1) })).toMatchObject({ status: 'applied' });
    expect(await gm(A, 102, 'milestones', 'create', gid(3), wsA, null, { title: 'Finish CNS drugs', project_id: gid(2) })).toMatchObject({ status: 'applied' });
    expect(await gm(A, 103, 'tasks', 'create', gid(4), wsA, null, { title: 'Quiz: antiepileptics', project_id: gid(2), milestone_id: gid(3), priority: 'High' })).toMatchObject({ status: 'applied' });
    const t = (await rows(A, `select project_id, milestone_id, priority, version from public.tasks where id='${gid(4)}'`))[0];
    expect(t).toEqual({ project_id: gid(2), milestone_id: gid(3), priority: 'High', version: 1 });
    const audited = (await rows(A, `select distinct table_name from public.audit_log where row_id in ('${gid(1)}','${gid(2)}','${gid(3)}','${gid(4)}') order by 1`)).map(r => r.table_name);
    expect(audited).toEqual(['goals', 'milestones', 'projects', 'tasks']);
  });
  it('cross-workspace links are impossible (composite foreign keys), even with a valid id', async () => {
    await expect(gm(A, 110, 'projects', 'create', gid(10), wsA2, null, { title: 'x', goal_id: gid(1) })).rejects.toThrow(/foreign key/);
    await expect(gm(A, 111, 'tasks', 'create', gid(11), wsA2, null, { title: 'x', project_id: gid(2) })).rejects.toThrow(/foreign key/);
    await expect(gm(A, 112, 'milestones', 'create', gid(12), wsA2, null, { title: 'x', project_id: gid(2) })).rejects.toThrow(/foreign key/);
    await expect(gm(A, 113, 'tasks', 'update', gid(4), wsA, 1, { project_id: gid(99) })).rejects.toThrow(/foreign key/);
  });
  it("user B cannot read A's planning data, and cannot link B's rows to it", async () => {
    for (const t of ['goals', 'projects', 'milestones']) expect(await rows(B, `select 1 from public.${t}`)).toHaveLength(0);
    await expect(gm(B, 120, 'projects', 'create', gid(20), wsB, null, { title: 'x', goal_id: gid(1) })).rejects.toThrow(/foreign key/);
    await expect(gm(B, 121, 'goals', 'create', gid(21), wsA, null, { title: 'planted' })).rejects.toThrow(/row-level security/);
    expect((await gm(B, 122, 'goals', 'update', gid(1), wsA, 1, { title: 'hacked' })).status).toBe('rejected');
    expect((await gm(B, 123, 'goals', 'delete', gid(1), wsA, 1)).status).toBe('rejected');
    expect((await rows(A, `select title from public.goals where id='${gid(1)}'`))[0].title).toBe('Pass GPPQE');
  });
  it('only whitelisted fields are accepted; server-owned and structural fields are refused loudly', async () => {
    for (const bad of [{ version: 9 }, { workspace_id: wsB }, { created_by: B }, { deleted_at: '2020-01-01' }, { id: gid(77) }, { completed_at: '2020-01-01' }])
      await expect(gm(A, 130, 'goals', 'update', gid(1), wsA, 1, { title: 'ok', ...bad })).rejects.toThrow(/not allowed/);
    await expect(gm(A, 131, 'users', 'create', gid(78), wsA, null, {})).rejects.toThrow(/unknown entity/);
    await expect(gm(A, 132, 'tasks', 'update', gid(4), wsA, 1, 'x' as any)).rejects.toThrow();
  });
  it('update semantics: version bump, replay, conflict with server values, convergent no-op, terminal delete', async () => {
    expect(await gm(A, 140, 'goals', 'update', gid(1), wsA, 1, { status: 'paused' })).toMatchObject({ status: 'applied', version: 2 });
    expect(await gm(A, 140, 'goals', 'update', gid(1), wsA, 1, { status: 'paused' })).toMatchObject({ status: 'applied', version: 2, replayed: true });
    expect(await gm(A, 141, 'goals', 'update', gid(1), wsA, 1, { status: 'completed' })).toMatchObject({ status: 'conflict', server: { version: 2, deleted: false, fields: { status: 'paused' } } });
    expect(await gm(A, 142, 'goals', 'update', gid(1), wsA, 1, { status: 'paused' })).toMatchObject({ status: 'applied', noop: true });
    expect(await gm(A, 143, 'goals', 'update', gid(1), wsA, 2, { description: 'desc', status: 'active' })).toMatchObject({ status: 'applied', version: 3 });   // multi-field
    expect((await rows(A, `select status, description from public.goals where id='${gid(1)}'`))[0]).toEqual({ status: 'active', description: 'desc' });
    await gm(A, 144, 'goals', 'create', gid(5), wsA, null, { title: 'temp' });
    expect(await gm(A, 145, 'goals', 'delete', gid(5), wsA, 1)).toMatchObject({ status: 'applied', version: 2 });
    expect(await gm(A, 146, 'goals', 'update', gid(5), wsA, 2, { title: 'zombie' })).toMatchObject({ status: 'conflict', server: { deleted: true } });
  });
  it('task completion still works through the generic path and completed_at stays server-controlled', async () => {
    await gm(A, 150, 'tasks', 'update', gid(4), wsA, 1, { done: true });
    expect((await rows(A, `select done, completed_at is not null as c, version from public.tasks where id='${gid(4)}'`))[0]).toEqual({ done: true, c: true, version: 2 });
    await gm(A, 151, 'tasks', 'update', gid(4), wsA, 2, { done: false });
    expect((await rows(A, `select c from (select completed_at is not null as c from public.tasks where id='${gid(4)}') s`))[0].c).toBe(false);
  });
  it('clients cannot bypass the function with direct writes to the new tables', async () => {
    await expect(as(A, () => db.query(`insert into public.goals(id,workspace_id,title,version) values ('${gid(60)}','${wsA}','x',5)`))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => db.query(`update public.projects set version = 1`))).rejects.toThrow(/permission denied/);
    await expect(as(A, () => db.query(`delete from public.milestones`))).rejects.toThrow(/permission denied/);
    await expect(rows(null, `select * from public.goals`)).rejects.toThrow(/permission denied/);
  });
  it('dropping the old task-only function is not required for safety: it is still locked to members', async () => {
    await expect(mutate(B, 160, 'create', tid(160), wsA, null, { title: 'x' })).rejects.toThrow(/row-level security/);
  });
});
