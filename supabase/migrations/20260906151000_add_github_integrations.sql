create table if not exists public.github_integrations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  installation_id bigint not null unique check (installation_id > 0),
  account_login text not null default '',
  account_id bigint,
  target_type text not null default 'User',
  repository_selection text not null default 'all',
  sync_status text not null default 'pending'
    check (sync_status in ('pending', 'syncing', 'ok', 'error', 'disconnected')),
  last_reconciled_at timestamptz,
  last_webhook_at timestamptz,
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.github_integrations enable row level security;

create policy "Users can read own GitHub integration"
on public.github_integrations
for select
to authenticated
using ((auth.uid() = user_id) and is_ariadne_owner());

comment on table public.github_integrations is
  'Links an Ariadne user to a GitHub App installation. Secrets remain in Edge Function environment variables.';
