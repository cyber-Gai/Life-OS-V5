-- Life OS V5 — 0003 planning hierarchy: goals -> projects -> milestones -> tasks, plus ONE generic mutation function.
-- Cross-workspace links are impossible by construction: every parent reference is a composite FK (id, workspace_id).

------------------------------------------------------------------ 1. tables
create table public.goals (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (length(title) between 1 and 300),
  description text not null default '' check (length(description) <= 5000),
  status text not null default 'active' check (status in ('active','paused','completed')),
  target_date date,
  version int not null default 1,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, workspace_id)
);
create table public.projects (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  goal_id uuid,
  title text not null check (length(title) between 1 and 300),
  status text not null default 'active' check (status in ('active','paused','completed')),
  target_date date,
  version int not null default 1,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, workspace_id),
  foreign key (goal_id, workspace_id) references public.goals (id, workspace_id)
);
create table public.milestones (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null,
  title text not null check (length(title) between 1 and 300),
  due date,
  done boolean not null default false,
  version int not null default 1,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, workspace_id),
  foreign key (project_id, workspace_id) references public.projects (id, workspace_id)
);
create index on public.goals (workspace_id, deleted_at);
create index on public.projects (workspace_id, deleted_at, goal_id);
create index on public.milestones (workspace_id, deleted_at, project_id);

alter table public.tasks add column if not exists project_id uuid;
alter table public.tasks add column if not exists milestone_id uuid;
alter table public.tasks add constraint tasks_project_fk   foreign key (project_id, workspace_id)   references public.projects (id, workspace_id);
alter table public.tasks add constraint tasks_milestone_fk foreign key (milestone_id, workspace_id) references public.milestones (id, workspace_id);
create index on public.tasks (workspace_id, project_id);

alter table public.applied_ops add column if not exists entity text not null default 'tasks';

------------------------------------------------------------------ 2. shared triggers (server owns version/audit/timestamps)
create or replace function public.entity_before_insert() returns trigger language plpgsql set search_path = '' as $$
begin
  new.version := 1; new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := now(); new.updated_at := now(); new.deleted_at := null;
  return new;
end $$;
create or replace function public.entity_before_update() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null then raise exception '% % is deleted and can no longer change', tg_table_name, old.id using errcode = '55000'; end if;
  if new.id <> old.id or new.workspace_id <> old.workspace_id then raise exception 'id and workspace_id are immutable' using errcode = '55000'; end if;
  new.created_by := old.created_by; new.created_at := old.created_at;
  new.version := old.version + 1; new.updated_at := now();
  return new;
end $$;
create or replace function public.entity_audit() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log(workspace_id, user_id, table_name, row_id, action, detail)
  values (new.workspace_id, auth.uid(), tg_table_name, new.id,
          case when tg_op = 'INSERT' then 'create' when new.deleted_at is not null and old.deleted_at is null then 'delete' else 'update' end,
          jsonb_build_object('title', new.title, 'version', new.version));
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['goals','projects','milestones'] loop
    execute format('create trigger trg_%1$s_bi before insert on public.%1$I for each row execute function public.entity_before_insert()', t);
    execute format('create trigger trg_%1$s_bu before update on public.%1$I for each row execute function public.entity_before_update()', t);
    execute format('create trigger trg_%1$s_audit after insert or update on public.%1$I for each row execute function public.entity_audit()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member(workspace_id))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_member(workspace_id, true))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_member(workspace_id, true)) with check (public.is_member(workspace_id, true))', t || '_update', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

------------------------------------------------------------------ 3. least-privilege column grants
grant insert (id, workspace_id, title, description, status, target_date) on public.goals to authenticated;
grant update (title, description, status, target_date, deleted_at)       on public.goals to authenticated;
grant insert (id, workspace_id, goal_id, title, status, target_date)     on public.projects to authenticated;
grant update (goal_id, title, status, target_date, deleted_at)           on public.projects to authenticated;
grant insert (id, workspace_id, project_id, title, due, done)            on public.milestones to authenticated;
grant update (project_id, title, due, done, deleted_at)                  on public.milestones to authenticated;
grant insert (project_id, milestone_id) on public.tasks to authenticated;
grant update (project_id, milestone_id) on public.tasks to authenticated;
grant insert (entity) on public.applied_ops to authenticated;

------------------------------------------------------------------ 4. generic mutation
-- The single place that decides which fields clients may change, per entity.
create or replace function public.mutable_columns(p_entity text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_entity
    when 'tasks'      then array['title','priority','due','done','project_id','milestone_id']
    when 'goals'      then array['title','description','status','target_date']
    when 'projects'   then array['title','goal_id','status','target_date']
    when 'milestones' then array['title','project_id','due','done']
  end
$$;

-- SECURITY INVOKER: all dynamic SQL below still runs under the caller's RLS and column grants.
-- Entity is whitelisted via mutable_columns(); column names are whitelisted and quoted with %I; values are bound, never concatenated.
create or replace function public.apply_mutation(
  p_op_id uuid, p_entity text, p_kind text, p_id uuid, p_workspace_id uuid,
  p_base_version integer default null, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_cols text[] := public.mutable_columns(p_entity);
  v_keys text[]; v_bad text[]; v_list text;
  v_prev jsonb; v_row jsonb; v_result jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if v_cols is null then raise exception 'unknown entity %', p_entity using errcode = '22023'; end if;
  if p_kind not in ('create','update','delete') then raise exception 'unknown mutation kind %', p_kind using errcode = '22023'; end if;
  if p_kind in ('update','delete') and p_base_version is null then raise exception 'base_version is required for %', p_kind using errcode = '22023'; end if;
  if jsonb_typeof(p_payload) <> 'object' then raise exception 'payload must be an object' using errcode = '22023'; end if;

  v_keys := array(select jsonb_object_keys(p_payload));
  v_bad  := array(select unnest(v_keys) except select unnest(v_cols));
  if cardinality(v_bad) > 0 then raise exception 'field(s) not allowed for %: %', p_entity, array_to_string(v_bad, ', ') using errcode = '22023'; end if;
  v_list := (select string_agg(format('%I', k), ', ') from unnest(v_keys) k);

  perform pg_advisory_xact_lock(hashtextextended(p_op_id::text, 0));   -- retries of one op are serialised
  select r.result into v_prev from public.applied_ops r where r.op_id = p_op_id and r.user_id = v_uid;
  if found then return v_prev || jsonb_build_object('replayed', true); end if;

  if p_kind = 'create' then
    if v_list is null then
      execute format('insert into public.%I (id, workspace_id) values ($1, $2) on conflict (id) do nothing', p_entity) using p_id, p_workspace_id;
    else
      execute format('insert into public.%1$I (id, workspace_id, %2$s) select $1, $2, %2$s from jsonb_populate_record(null::public.%1$I, $3) on conflict (id) do nothing',
                     p_entity, v_list) using p_id, p_workspace_id, p_payload;
    end if;
    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.workspace_id = $2', p_entity) into v_row using p_id, p_workspace_id;
    if v_row is null then v_result := jsonb_build_object('status', 'rejected', 'reason', 'id unavailable');
    else v_result := jsonb_build_object('status', 'applied', 'version', (v_row->>'version')::int); end if;
  else
    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.workspace_id = $2 for update', p_entity) into v_row using p_id, p_workspace_id;
    if v_row is null then
      v_result := jsonb_build_object('status', 'rejected', 'reason', 'not found');
    elsif p_kind = 'delete' and v_row->>'deleted_at' is not null then
      v_result := jsonb_build_object('status', 'applied', 'version', (v_row->>'version')::int, 'noop', true);
    elsif v_row->>'deleted_at' is not null then
      v_result := jsonb_build_object('status', 'conflict', 'server', jsonb_build_object('version', (v_row->>'version')::int, 'deleted', true, 'title', v_row->>'title', 'fields', '{}'::jsonb));
    elsif (v_row->>'version')::int = p_base_version then
      if p_kind = 'delete' then
        execute format('update public.%I set deleted_at = now() where id = $1', p_entity) using p_id;
      elsif v_list is not null then
        execute format('update public.%1$I set (%2$s) = (select %2$s from jsonb_populate_record(null::public.%1$I, $2)) where id = $1', p_entity, v_list) using p_id, p_payload;
      end if;
      execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_entity) into v_row using p_id;
      v_result := jsonb_build_object('status', 'applied', 'version', (v_row->>'version')::int);
    elsif p_kind = 'update' and v_row @> p_payload then
      v_result := jsonb_build_object('status', 'applied', 'version', (v_row->>'version')::int, 'noop', true);   -- stale, but the server already holds exactly these values
    else
      v_result := jsonb_build_object('status', 'conflict', 'server', jsonb_build_object(
        'version', (v_row->>'version')::int, 'deleted', false, 'title', v_row->>'title',
        'fields', (select coalesce(jsonb_object_agg(k, v_row->k), '{}'::jsonb) from unnest(v_keys) k)));
    end if;
  end if;

  insert into public.applied_ops(op_id, user_id, entity, kind, task_id, workspace_id, result)
  values (p_op_id, v_uid, p_entity, p_kind, p_id, p_workspace_id, v_result);
  return v_result;
end $$;
revoke all on function public.mutable_columns(text) from public, anon;
revoke all on function public.apply_mutation(uuid, text, text, uuid, uuid, integer, jsonb) from public, anon;
grant execute on function public.mutable_columns(text) to authenticated;
grant execute on function public.apply_mutation(uuid, text, text, uuid, uuid, integer, jsonb) to authenticated;
-- apply_task_mutation (0002) is superseded by apply_mutation; it stays for one release so old clients keep working, then drop it.
