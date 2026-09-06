-- Run in Supabase SQL Editor
create extension if not exists pgcrypto;

-- Removed feature cleanup: the Writing Space document library is retired.
drop table if exists public.user_document_libraries;
grant usage on schema public to anon, authenticated;

-- Every authenticated app surface is restricted to the single authorized owner.
-- Keep this server-side check in addition to the client-side access gate.
create or replace function public.is_ariadne_owner()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select auth.uid() is not null
    and lower(coalesce(auth.jwt()->>'email', '')) = 'theneolorenzo@gmail.com';
$$;

revoke all on function public.is_ariadne_owner() from public;
grant execute on function public.is_ariadne_owner() to authenticated;

-- 1) Substack backend tables are retired; dashboard reads public Substack archive data directly.
drop table if exists public.substack_archive_posts;
drop table if exists public.substack_publication_sources;
drop table if exists public.substack_publication_exports;

-- 2) Per-user task board storage (task list JSON)
create table if not exists public.user_tasks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tasks jsonb not null default '[]'::jsonb,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.user_tasks
add column if not exists version bigint not null default 1;

alter table public.user_tasks enable row level security;
grant select, insert, update on table public.user_tasks to authenticated;
revoke all on table public.user_tasks from anon;

drop policy if exists "Users can read own tasks" on public.user_tasks;
create policy "Users can read own tasks"
on public.user_tasks
for select
to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner());

drop policy if exists "Users can insert own tasks" on public.user_tasks;
create policy "Users can insert own tasks"
on public.user_tasks
for insert
to authenticated
with check (auth.uid() = user_id and public.is_ariadne_owner());

drop policy if exists "Users can update own tasks" on public.user_tasks;
create policy "Users can update own tasks"
on public.user_tasks
for update
to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner())
with check (auth.uid() = user_id and public.is_ariadne_owner());

-- 3) Immutable backup history for user_tasks updates
create table if not exists public.user_tasks_backups (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  version bigint not null,
  tasks jsonb not null,
  backup_reason text not null default 'before_update',
  backed_up_at timestamptz not null default now()
);

alter table public.user_tasks_backups enable row level security;
grant select, insert on table public.user_tasks_backups to authenticated;
revoke all on table public.user_tasks_backups from anon;

drop policy if exists "Users can read own task backups" on public.user_tasks_backups;
create policy "Users can read own task backups"
on public.user_tasks_backups
for select
to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner());

drop policy if exists "Users can insert own task backups" on public.user_tasks_backups;
create policy "Users can insert own task backups"
on public.user_tasks_backups
for insert
to authenticated
with check (auth.uid() = user_id and public.is_ariadne_owner());

create or replace function public.backup_user_tasks_before_update()
returns trigger
language plpgsql
as $$
begin
  insert into public.user_tasks_backups (user_id, version, tasks, backup_reason)
  values (old.user_id, old.version, old.tasks, 'before_update');

  return new;
end;
$$;

drop trigger if exists backup_user_tasks_before_update_trigger on public.user_tasks;
create trigger backup_user_tasks_before_update_trigger
before update on public.user_tasks
for each row
when (old.tasks is distinct from new.tasks)
execute function public.backup_user_tasks_before_update();

create or replace function public.purge_expired_task_tombstones()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned_row_count integer := 0;
begin
  with cleaned_rows as (
    update public.user_tasks as task_row
    set
      tasks = (
        select coalesce(jsonb_agg(task_item.value order by task_item.ordinality), '[]'::jsonb)
        from jsonb_array_elements(task_row.tasks) with ordinality as task_item(value, ordinality)
        where not (
          task_item.value ->> 'deleted' = 'true'
          and case
            when coalesce(
              task_item.value ->> 'deletedAt',
              task_item.value ->> 'updatedAt',
              ''
            ) ~ '^[0-9]+([.][0-9]+)?$'
              then coalesce(
                task_item.value ->> 'deletedAt',
                task_item.value ->> 'updatedAt'
              )::numeric <= extract(epoch from (now() - interval '1 day')) * 1000
            else false
          end
        )
      ),
      version = task_row.version + 1,
      updated_at = now()
    where exists (
      select 1
      from jsonb_array_elements(task_row.tasks) as candidate(value)
      where candidate.value ->> 'deleted' = 'true'
        and case
          when coalesce(
            candidate.value ->> 'deletedAt',
            candidate.value ->> 'updatedAt',
            ''
          ) ~ '^[0-9]+([.][0-9]+)?$'
            then coalesce(
              candidate.value ->> 'deletedAt',
              candidate.value ->> 'updatedAt'
            )::numeric <= extract(epoch from (now() - interval '1 day')) * 1000
          else false
        end
    )
    returning 1
  )
  select count(*) into cleaned_row_count from cleaned_rows;

  return cleaned_row_count;
end;
$$;

revoke all on function public.purge_expired_task_tombstones() from public;
grant execute on function public.purge_expired_task_tombstones() to service_role;

-- 4) Per-user projects board storage (project list JSON)
create table if not exists public.user_projects (
  user_id uuid primary key references auth.users(id) on delete cascade,
  projects jsonb not null default '[]'::jsonb,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.user_projects
add column if not exists version bigint not null default 1;

alter table public.user_projects enable row level security;
grant select, insert, update on table public.user_projects to authenticated;
revoke all on table public.user_projects from anon;

drop policy if exists "Users can read own projects" on public.user_projects;
create policy "Users can read own projects"
on public.user_projects
for select
to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner());

drop policy if exists "Users can insert own projects" on public.user_projects;
create policy "Users can insert own projects"
on public.user_projects
for insert
to authenticated
with check (auth.uid() = user_id and public.is_ariadne_owner());

drop policy if exists "Users can update own projects" on public.user_projects;
create policy "Users can update own projects"
on public.user_projects
for update
to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner())
with check (auth.uid() = user_id and public.is_ariadne_owner());

-- 5) Immutable backup history for user_projects updates
create table if not exists public.user_projects_backups (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  version bigint not null,
  projects jsonb not null,
  backup_reason text not null default 'before_update',
  backed_up_at timestamptz not null default now()
);

alter table public.user_projects_backups enable row level security;
grant select, insert on table public.user_projects_backups to authenticated;
revoke all on table public.user_projects_backups from anon;

drop policy if exists "Users can read own project backups" on public.user_projects_backups;
create policy "Users can read own project backups"
on public.user_projects_backups
for select
to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner());

drop policy if exists "Users can insert own project backups" on public.user_projects_backups;
create policy "Users can insert own project backups"
on public.user_projects_backups
for insert
to authenticated
with check (auth.uid() = user_id and public.is_ariadne_owner());

create or replace function public.backup_user_projects_before_update()
returns trigger
language plpgsql
as $$
begin
  insert into public.user_projects_backups (user_id, version, projects, backup_reason)
  values (old.user_id, old.version, old.projects, 'before_update');

  return new;
end;
$$;

drop trigger if exists backup_user_projects_before_update_trigger on public.user_projects;
create trigger backup_user_projects_before_update_trigger
before update on public.user_projects
for each row
when (old.projects is distinct from new.projects)
execute function public.backup_user_projects_before_update();

-- 6) Company catalog/profile tables are retired; dashboard signals are client-side.
drop trigger if exists sync_user_company_profiles_from_projects_trigger on public.user_projects;
drop function if exists public.sync_user_company_profiles_from_projects();
drop view if exists public.user_company_profiles_with_status;
drop function if exists public.is_date_in_season_ranges(jsonb, date);
drop table if exists public.user_company_profiles;
drop table if exists public.company_catalog;

-- 7) One active direction per user, with user-managed pre-edit revisions.
create table if not exists public.directions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  statement text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists one_active_direction_per_user
on public.directions (user_id) where is_active;

create table if not exists public.direction_revisions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  direction_id text not null references public.directions(id) on delete cascade,
  title text not null,
  statement text not null,
  change_reason text,
  created_at timestamptz not null default now()
);

alter table public.directions enable row level security;
alter table public.direction_revisions enable row level security;
grant select, insert, update on table public.directions to authenticated;
grant select, insert, delete on table public.direction_revisions to authenticated;
revoke all on table public.directions from anon;
revoke all on table public.direction_revisions from anon;

drop policy if exists "Users manage own directions" on public.directions;
create policy "Users manage own directions" on public.directions
for all to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner())
with check (auth.uid() = user_id and public.is_ariadne_owner());
drop policy if exists "Users read own direction revisions" on public.direction_revisions;
create policy "Users read own direction revisions" on public.direction_revisions
for select to authenticated using (auth.uid() = user_id and public.is_ariadne_owner());
drop policy if exists "Users insert own direction revisions" on public.direction_revisions;
create policy "Users insert own direction revisions" on public.direction_revisions
for insert to authenticated with check (auth.uid() = user_id and public.is_ariadne_owner());
drop policy if exists "Users delete own direction revisions" on public.direction_revisions;
create policy "Users delete own direction revisions" on public.direction_revisions
for delete to authenticated using (auth.uid() = user_id and public.is_ariadne_owner());

-- 8) Strategic objectives attached to a direction.
create table if not exists public.strategic_objectives (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  direction_id text not null references public.directions(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  description text,
  success_condition text not null check (length(trim(success_condition)) > 0),
  status text not null default 'active' check (status in ('active', 'completed', 'paused', 'abandoned')),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists strategic_objectives_direction_position
on public.strategic_objectives (direction_id, position);

create or replace function public.enforce_strategic_objective_rules()
returns trigger
language plpgsql
as $$
declare
  active_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':' || new.direction_id, 0));

  if not exists (
    select 1 from public.directions
    where id = new.direction_id and user_id = new.user_id
  ) then
    raise exception 'Strategic objective must belong to the user direction';
  end if;

  if new.status = 'active' then
    select count(*) into active_count
    from public.strategic_objectives
    where user_id = new.user_id
      and direction_id = new.direction_id
      and status = 'active'
      and id <> new.id;
    if active_count >= 3 then
      raise exception 'A direction may have at most three active strategic objectives';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_strategic_objective_rules_trigger on public.strategic_objectives;
create trigger enforce_strategic_objective_rules_trigger
before insert or update on public.strategic_objectives
for each row execute function public.enforce_strategic_objective_rules();

alter table public.strategic_objectives enable row level security;
grant select, insert, update, delete on table public.strategic_objectives to authenticated;
revoke all on table public.strategic_objectives from anon;
drop policy if exists "Users manage own strategic objectives" on public.strategic_objectives;
create policy "Users manage own strategic objectives" on public.strategic_objectives
for all to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner())
with check (auth.uid() = user_id and public.is_ariadne_owner());

-- 9) Measurable outcome goals and user-managed meaningful-change history.
create table if not exists public.outcome_goals (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  strategic_objective_id text not null references public.strategic_objectives(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  description text,
  metric_type text not null default 'count' check (metric_type = 'count'),
  current_value numeric not null default 0 check (current_value >= 0),
  target_value numeric not null check (target_value > 0),
  bare_minimum numeric not null default 0 check (bare_minimum >= 0 and bare_minimum <= target_value),
  display_on_todo_list boolean not null default false,
  start_date date,
  target_date date,
  status text not null default 'active' check (status in ('active', 'partially-completed', 'completed', 'exceptional', 'failed')),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (target_date is null or start_date is null or target_date >= start_date),
  check (current_value = trunc(current_value)),
  check (target_value = trunc(target_value)),
  check (bare_minimum = trunc(bare_minimum))
);

alter table public.outcome_goals add column if not exists bare_minimum numeric;
alter table public.outcome_goals add column if not exists display_on_todo_list boolean not null default false;
update public.outcome_goals
set
  metric_type = 'count',
  current_value = greatest(0, trunc(current_value)),
  target_value = greatest(1, trunc(target_value)),
  bare_minimum = least(greatest(0, trunc(coalesce(bare_minimum, 0))), greatest(1, trunc(target_value))),
  status = case
    when status in ('active', 'partially-completed', 'completed', 'exceptional', 'failed') then status
    else 'active'
  end;
alter table public.outcome_goals alter column metric_type set default 'count';
alter table public.outcome_goals alter column bare_minimum set default 0;
alter table public.outcome_goals alter column bare_minimum set not null;
alter table public.outcome_goals drop constraint if exists outcome_goals_metric_type_check;
alter table public.outcome_goals add constraint outcome_goals_metric_type_check check (metric_type = 'count');
alter table public.outcome_goals drop constraint if exists outcome_goals_status_check;
alter table public.outcome_goals add constraint outcome_goals_status_check
check (status in ('active', 'partially-completed', 'completed', 'exceptional', 'failed'));
alter table public.outcome_goals drop constraint if exists outcome_goals_integer_counts_check;
alter table public.outcome_goals add constraint outcome_goals_integer_counts_check
check (
  current_value = trunc(current_value)
  and target_value = trunc(target_value)
  and bare_minimum = trunc(bare_minimum)
);
alter table public.outcome_goals drop constraint if exists outcome_goals_bare_minimum_check;
alter table public.outcome_goals add constraint outcome_goals_bare_minimum_check
check (bare_minimum >= 0 and bare_minimum <= target_value);

create index if not exists outcome_goals_objective_position
on public.outcome_goals (strategic_objective_id, position);

create or replace function public.enforce_outcome_goal_owner()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from public.strategic_objectives
    where id = new.strategic_objective_id and user_id = new.user_id
  ) then
    raise exception 'Outcome goal must belong to the user strategic objective';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_outcome_goal_owner_trigger on public.outcome_goals;
create trigger enforce_outcome_goal_owner_trigger
before insert or update on public.outcome_goals
for each row execute function public.enforce_outcome_goal_owner();

create table if not exists public.outcome_goal_revisions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  outcome_goal_id text not null references public.outcome_goals(id) on delete cascade,
  previous_title text not null,
  previous_metric_type text not null,
  previous_target_value numeric not null,
  previous_bare_minimum numeric not null default 0,
  previous_start_date date,
  previous_target_date date,
  change_reason text not null check (length(trim(change_reason)) > 0),
  created_at timestamptz not null default now()
);

alter table public.outcome_goal_revisions add column if not exists previous_bare_minimum numeric;
update public.outcome_goal_revisions
set previous_bare_minimum = 0
where previous_bare_minimum is null;
alter table public.outcome_goal_revisions alter column previous_bare_minimum set default 0;
alter table public.outcome_goal_revisions alter column previous_bare_minimum set not null;

alter table public.outcome_goals enable row level security;
alter table public.outcome_goal_revisions enable row level security;
grant select, insert, update, delete on table public.outcome_goals to authenticated;
grant select, insert, delete on table public.outcome_goal_revisions to authenticated;
revoke all on table public.outcome_goals from anon;
revoke all on table public.outcome_goal_revisions from anon;
drop policy if exists "Users manage own outcome goals" on public.outcome_goals;
create policy "Users manage own outcome goals" on public.outcome_goals
for all to authenticated
using (auth.uid() = user_id and public.is_ariadne_owner())
with check (auth.uid() = user_id and public.is_ariadne_owner());
drop policy if exists "Users read own outcome goal revisions" on public.outcome_goal_revisions;
create policy "Users read own outcome goal revisions" on public.outcome_goal_revisions
for select to authenticated using (auth.uid() = user_id and public.is_ariadne_owner());
drop policy if exists "Users insert own outcome goal revisions" on public.outcome_goal_revisions;
create policy "Users insert own outcome goal revisions" on public.outcome_goal_revisions
for insert to authenticated with check (auth.uid() = user_id and public.is_ariadne_owner());
drop policy if exists "Users delete own outcome goal revisions" on public.outcome_goal_revisions;
create policy "Users delete own outcome goal revisions" on public.outcome_goal_revisions
for delete to authenticated using (auth.uid() = user_id and public.is_ariadne_owner());

-- 10) Durable owner-only cache for external dashboard signals
create table if not exists public.external_signal_cache (
  signal_key text primary key,
  latest_entry_at timestamptz not null,
  latest_entry_title text not null default '',
  latest_entry_url text not null default '',
  source text not null default 'unknown',
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.external_signal_cache enable row level security;
grant select on table public.external_signal_cache to authenticated;
revoke all on table public.external_signal_cache from anon;
revoke insert, update, delete on table public.external_signal_cache from anon, authenticated;

drop policy if exists "Anyone can read external signal cache" on public.external_signal_cache;
drop policy if exists "Authorized owner can read external signal cache" on public.external_signal_cache;
create policy "Authorized owner can read external signal cache"
on public.external_signal_cache
for select
to authenticated
using (public.is_ariadne_owner());

create or replace function public.record_external_signal_if_newer(
  p_signal_key text,
  p_latest_entry_at timestamptz,
  p_latest_entry_title text default '',
  p_latest_entry_url text default '',
  p_source text default 'client'
)
returns public.external_signal_cache
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.external_signal_cache;
begin
  if nullif(trim(p_signal_key), '') is null or p_latest_entry_at is null then
    raise exception 'Signal key and latest entry timestamp are required' using errcode = '22023';
  end if;
  if trim(p_signal_key) <> 'lorenzo-roque-substack' then
    raise exception 'Unsupported external signal key' using errcode = '22023';
  end if;
  if auth.role() <> 'service_role'
    and lower(coalesce(auth.jwt()->>'email', '')) <> 'theneolorenzo@gmail.com' then
    raise exception 'Not authorized to update external signals' using errcode = '42501';
  end if;

  insert into public.external_signal_cache (
    signal_key,
    latest_entry_at,
    latest_entry_title,
    latest_entry_url,
    source,
    checked_at,
    updated_at
  )
  values (
    trim(p_signal_key),
    p_latest_entry_at,
    coalesce(p_latest_entry_title, ''),
    coalesce(p_latest_entry_url, ''),
    coalesce(nullif(trim(p_source), ''), 'client'),
    now(),
    now()
  )
  on conflict (signal_key) do update
  set
    latest_entry_at = excluded.latest_entry_at,
    latest_entry_title = excluded.latest_entry_title,
    latest_entry_url = excluded.latest_entry_url,
    source = excluded.source,
    checked_at = now(),
    updated_at = now()
  where excluded.latest_entry_at > external_signal_cache.latest_entry_at
  returning * into result;

  if result is null then
    select *
    into result
    from public.external_signal_cache
    where signal_key = trim(p_signal_key);
  end if;

  return result;
end;
$$;

revoke all on function public.record_external_signal_if_newer(text, timestamptz, text, text, text) from public;
grant execute on function public.record_external_signal_if_newer(text, timestamptz, text, text, text) to authenticated, service_role;

insert into public.external_signal_cache (
  signal_key,
  latest_entry_at,
  latest_entry_title,
  latest_entry_url,
  source
)
values (
  'lorenzo-roque-substack',
  '2025-12-07T23:57:53.310Z',
  'Your Panic Is For Sale',
  'https://lorenzoroque.substack.com/p/your-panic-is-for-sale',
  'schema-seed'
)
on conflict (signal_key) do nothing;
