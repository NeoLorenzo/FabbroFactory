do $$
begin
  if exists (select 1 from cron.job where jobname = 'github-sync-reconcile-all') then
    perform cron.unschedule('github-sync-reconcile-all');
  end if;
end
$$;

select cron.schedule(
  'github-sync-reconcile-all',
  '0 */6 * * *',
  $cron$
  select net.http_post(
    url := 'https://jhpsggjphoqyygthqfki.supabase.co/functions/v1/github-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ariadne-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'github_sync_cron_secret'
      )
    ),
    body := '{"action":"reconcile-all"}'::jsonb,
    timeout_milliseconds := 15000
  ) as request_id;
  $cron$
);
