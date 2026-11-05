-- Life OS V5 — slice 1: workspaces, tasks, audit. Isolation is enforced by RLS, not the client.
create extension if not exists pgcrypto;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('personal','academic','professional','mubah')),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','editor','viewer')),
  primary key (workspace_id, user_id)
);

create table public.tasks (
  id uuid primary key,                       -- client-generated => idempotent offline creates
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (length(title) between 1 and 300),
  priority text not null default 'Medium' check (priority in ('High','Medium','Low')),
  due date,
  done boolean not null default false,
  completed_at timestamptz,
  version int not null default 1,            -- optimistic concurrency
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on public.tasks (workspace_id, deleted_at, due);

create table public.audit_log (
  id bigserial primary key,
  workspace_id uuid not null,
  user_id uuid,
  table_name text not null,
  row_id uuid not null,
  action text not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index on public.audit_log (workspace_id, at desc);

create or replace function public.is_member(ws uuid, need_write boolean default false)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.workspace_id = ws and m.user_id = auth.uid()
      and (not need_write or m.role in ('owner','editor'))
  );
$$;

alter table public.workspaces  enable row level security;
alter table public.memberships enable row level security;
alter table public.tasks       enable row level security;
alter table public.audit_log   enable row level security;

create policy ws_read on public.workspaces for select using (public.is_member(id));
create policy mem_read on public.memberships for select using (user_id = auth.uid());
create policy task_read on public.tasks for select using (public.is_member(workspace_id));
create policy task_insert on public.tasks for insert with check (public.is_member(workspace_id, true) and created_by = auth.uid());
create policy task_update on public.tasks for update using (public.is_member(workspace_id, true)) with check (public.is_member(workspace_id, true));
create policy audit_read on public.audit_log for select using (public.is_member(workspace_id));
-- no delete policy on tasks (soft delete only); no client writes to workspaces/memberships/audit_log.

create or replace function public.tasks_before_update() returns trigger language plpgsql as $$
begin
  if new.workspace_id <> old.workspace_id then raise exception 'workspace_id is immutable'; end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
create trigger trg_tasks_before_update before update on public.tasks
  for each row execute function public.tasks_before_update();

create or replace function public.tasks_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log(workspace_id, user_id, table_name, row_id, action, detail)
  values (new.workspace_id, auth.uid(), 'tasks', new.id,
          case when tg_op='INSERT' then 'create'
               when new.deleted_at is not null and old.deleted_at is null then 'delete'
               else 'update' end,
          jsonb_build_object('title', new.title, 'done', new.done, 'version', new.version));
  return new;
end $$;
create trigger trg_tasks_audit after insert or update on public.tasks
  for each row execute function public.tasks_audit();

-- First-login bootstrap: the four workspaces. Safe to call repeatedly.
create or replace function public.ensure_default_workspaces() returns setof public.workspaces
language plpgsql security definer set search_path = public as $$
declare k text; ws uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from workspaces where owner_id = auth.uid()) then
    foreach k in array array['personal','academic','professional','mubah'] loop
      insert into workspaces(name, kind, owner_id)
        values (initcap(k), k, auth.uid()) returning id into ws;
      insert into memberships(workspace_id, user_id, role) values (ws, auth.uid(), 'owner');
    end loop;
  end if;
  return query select * from workspaces where owner_id = auth.uid() order by created_at;
end $$;
revoke all on function public.ensure_default_workspaces() from public, anon;
grant execute on function public.ensure_default_workspaces() to authenticated;
