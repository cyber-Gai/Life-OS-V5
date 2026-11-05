-- Life OS V5 — 0002 hardening. Never edit 0001 once applied; this migration layers on top of it.
-- Goals: (a) clients can only touch what they must, (b) server owns version/audit/timestamps,
-- (c) mutations are idempotent + version-checked in ONE transaction, (d) bootstrap is race-free.

------------------------------------------------------------------ 1. defaults / schema
alter table public.workspaces add column if not exists is_default boolean not null default false;
-- Only the oldest workspace per (owner, kind) becomes the default; any racing duplicates from 0001 are kept (not deleted) for manual review.
update public.workspaces set is_default = true
 where id in (select distinct on (owner_id, kind) id from public.workspaces order by owner_id, kind, created_at);
create unique index if not exists workspaces_one_default_per_kind on public.workspaces (owner_id, kind) where is_default;

-- Operation ledger: makes retries safe (same op_id => same outcome, applied at most once).
create table if not exists public.applied_ops (
  op_id        uuid primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind         text not null,
  task_id      uuid not null,
  workspace_id uuid not null,
  result       jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists applied_ops_created_idx on public.applied_ops (created_at);  -- prune old rows via a scheduled job later
alter table public.applied_ops enable row level security;

------------------------------------------------------------------ 2. membership helper
create or replace function public.is_member(ws uuid, need_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
     where m.workspace_id = ws and m.user_id = (select auth.uid())
       and (not need_write or m.role in ('owner','editor'))
  );
$$;
revoke all on function public.is_member(uuid, boolean) from public, anon;
grant execute on function public.is_member(uuid, boolean) to authenticated;

------------------------------------------------------------------ 3. server-owned columns
create or replace function public.tasks_before_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.version      := 1;
  new.created_by   := coalesce(auth.uid(), new.created_by);
  new.created_at   := now();
  new.updated_at   := now();
  new.deleted_at   := null;
  new.completed_at := case when new.done then now() else null end;
  return new;
end $$;
drop trigger if exists trg_tasks_before_insert on public.tasks;
create trigger trg_tasks_before_insert before insert on public.tasks
  for each row execute function public.tasks_before_insert();

create or replace function public.tasks_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null then
    raise exception 'task % is deleted and can no longer change', old.id using errcode = '55000';
  end if;
  if new.id <> old.id or new.workspace_id <> old.workspace_id then
    raise exception 'id and workspace_id are immutable' using errcode = '55000';
  end if;
  new.created_by   := old.created_by;
  new.created_at   := old.created_at;
  new.version      := old.version + 1;
  new.updated_at   := now();
  new.completed_at := case when new.done then coalesce(old.completed_at, now()) else null end;
  return new;
end $$;

create or replace function public.tasks_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log(workspace_id, user_id, table_name, row_id, action, detail)
  values (new.workspace_id, auth.uid(), 'tasks', new.id,
          case when tg_op = 'INSERT' then 'create'
               when new.deleted_at is not null and old.deleted_at is null then 'delete'
               else 'update' end,
          jsonb_build_object('title', new.title, 'done', new.done, 'version', new.version));
  return new;
end $$;

-- audit_log is append-only for everyone, including privileged roles.
create or replace function public.audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'audit_log is append-only' using errcode = '55000'; end $$;
drop trigger if exists trg_audit_no_mutation on public.audit_log;
create trigger trg_audit_no_mutation before update or delete on public.audit_log
  for each row execute function public.audit_append_only();
drop trigger if exists trg_audit_no_truncate on public.audit_log;
create trigger trg_audit_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_append_only();

------------------------------------------------------------------ 4. least-privilege grants
-- Supabase grants ALL on new public tables to anon/authenticated by default. Remove that, then grant back only what is needed.
revoke all on table public.workspaces, public.memberships, public.tasks, public.audit_log, public.applied_ops
  from public, anon, authenticated;
grant select on public.workspaces, public.memberships, public.tasks, public.audit_log, public.applied_ops to authenticated;
grant insert (id, workspace_id, title, priority, due, done)         on public.tasks to authenticated;
grant update (title, priority, due, done, deleted_at)               on public.tasks to authenticated;  -- no version/created_by/completed_at
grant insert (op_id, user_id, kind, task_id, workspace_id, result)  on public.applied_ops to authenticated;
-- No DELETE anywhere for clients. No client writes to workspaces, memberships or audit_log.
-- Future tables start closed: they need explicit grants.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

------------------------------------------------------------------ 5. RLS policies (authenticated only)
drop policy if exists ws_read     on public.workspaces;
drop policy if exists mem_read    on public.memberships;
drop policy if exists task_read   on public.tasks;
drop policy if exists task_insert on public.tasks;
drop policy if exists task_update on public.tasks;
drop policy if exists audit_read  on public.audit_log;
drop policy if exists ops_read    on public.applied_ops;
drop policy if exists ops_insert  on public.applied_ops;

create policy ws_read     on public.workspaces  for select to authenticated using (public.is_member(id));
create policy mem_read    on public.memberships for select to authenticated using (user_id = (select auth.uid()));
create policy task_read   on public.tasks       for select to authenticated using (public.is_member(workspace_id));
create policy task_insert on public.tasks       for insert to authenticated with check (public.is_member(workspace_id, true));
create policy task_update on public.tasks       for update to authenticated
  using (public.is_member(workspace_id, true)) with check (public.is_member(workspace_id, true));
create policy audit_read  on public.audit_log   for select to authenticated using (public.is_member(workspace_id));
create policy ops_read    on public.applied_ops for select to authenticated using (user_id = (select auth.uid()));
create policy ops_insert  on public.applied_ops for insert to authenticated with check (user_id = (select auth.uid()));

------------------------------------------------------------------ 6. race-free bootstrap
create or replace function public.ensure_default_workspaces() returns setof public.workspaces
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); k text; ws uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ensure_ws:' || v_uid::text, 0));  -- two devices on first login can't double-create
  foreach k in array array['personal','academic','professional','mubah'] loop
    if not exists (select 1 from public.workspaces w where w.owner_id = v_uid and w.kind = k and w.is_default) then
      insert into public.workspaces(name, kind, owner_id, is_default)
        values (case k when 'mubah' then 'MUBAH' else initcap(k) end, k, v_uid, true)
        returning id into ws;
      insert into public.memberships(workspace_id, user_id, role) values (ws, v_uid, 'owner');
    end if;
  end loop;
  return query
    select w.* from public.workspaces w
      join public.memberships m on m.workspace_id = w.id
     where m.user_id = v_uid order by w.created_at, w.kind;
end $$;
revoke all on function public.ensure_default_workspaces() from public, anon;
grant execute on function public.ensure_default_workspaces() to authenticated;

------------------------------------------------------------------ 7. idempotent, version-checked mutations
-- SECURITY INVOKER on purpose: every write below still passes through RLS and column grants.
create or replace function public.apply_task_mutation(
  p_op_id        uuid,
  p_kind         text,
  p_task_id      uuid,
  p_workspace_id uuid,
  p_base_version integer default null,
  p_payload      jsonb   default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_prev   jsonb;
  v_row    public.tasks%rowtype;
  v_want   boolean;
  v_result jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_kind not in ('create','toggle','delete') then
    raise exception 'unknown mutation kind %', p_kind using errcode = '22023';
  end if;
  if p_kind in ('toggle','delete') and p_base_version is null then
    raise exception 'base_version is required for %', p_kind using errcode = '22023';
  end if;

  -- Serialise retries of the same op: the second caller waits, then sees the first caller's stored result.
  perform pg_advisory_xact_lock(hashtextextended(p_op_id::text, 0));
  select r.result into v_prev from public.applied_ops r where r.op_id = p_op_id and r.user_id = v_uid;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  if p_kind = 'create' then
    insert into public.tasks(id, workspace_id, title, priority, due, done)
    values (p_task_id, p_workspace_id, p_payload->>'title', coalesce(p_payload->>'priority', 'Medium'),
            nullif(p_payload->>'due', '')::date, coalesce((p_payload->>'done')::boolean, false))
    on conflict (id) do nothing;
    select * into v_row from public.tasks t where t.id = p_task_id and t.workspace_id = p_workspace_id;
    if not found then
      v_result := jsonb_build_object('status', 'rejected', 'reason', 'task id unavailable');
    else
      v_result := jsonb_build_object('status', 'applied', 'version', v_row.version);
    end if;
  else
    select * into v_row from public.tasks t
     where t.id = p_task_id and t.workspace_id = p_workspace_id for update;
    if not found then
      v_result := jsonb_build_object('status', 'rejected', 'reason', 'task not found');
    elsif p_kind = 'delete' and v_row.deleted_at is not null then
      v_result := jsonb_build_object('status', 'applied', 'version', v_row.version, 'noop', true);
    elsif v_row.deleted_at is not null then
      v_result := jsonb_build_object('status', 'conflict', 'server', jsonb_build_object(
        'version', v_row.version, 'done', v_row.done, 'deleted', true, 'title', v_row.title));
    else
      if p_kind = 'toggle' then v_want := (p_payload->>'done')::boolean; end if;
      if v_row.version = p_base_version then
        if p_kind = 'toggle' then
          update public.tasks set done = v_want where id = p_task_id returning * into v_row;
        else
          update public.tasks set deleted_at = now() where id = p_task_id returning * into v_row;
        end if;
        v_result := jsonb_build_object('status', 'applied', 'version', v_row.version);
      elsif p_kind = 'toggle' and v_row.done = v_want then
        v_result := jsonb_build_object('status', 'applied', 'version', v_row.version, 'noop', true);  -- both sides agree
      else
        v_result := jsonb_build_object('status', 'conflict', 'server', jsonb_build_object(
          'version', v_row.version, 'done', v_row.done, 'deleted', false, 'title', v_row.title));
      end if;
    end if;
  end if;

  insert into public.applied_ops(op_id, user_id, kind, task_id, workspace_id, result)
  values (p_op_id, v_uid, p_kind, p_task_id, p_workspace_id, v_result);
  return v_result;
end $$;
revoke all on function public.apply_task_mutation(uuid, text, uuid, uuid, integer, jsonb) from public, anon;
grant execute on function public.apply_task_mutation(uuid, text, uuid, uuid, integer, jsonb) to authenticated;
