create or replace function public.enqueue_billing_line_notification(p_text text)
returns bigint
language plpgsql
security definer
set search_path = vault, net, pg_catalog
as $$
declare
  config_json jsonb;
  request_id bigint;
begin
  if p_text is null or btrim(p_text) = '' or length(p_text) > 5000 then
    raise exception 'Notification text must be 1-5000 characters';
  end if;

  select ds.decrypted_secret::jsonb
    into config_json
  from vault.decrypted_secrets as ds
  where ds.name = 'billing_line_config'
  limit 1;

  if config_json is null or coalesce(config_json ->> 'internal_secret', '') = '' then
    raise exception 'Billing LINE configuration is unavailable';
  end if;

  select net.http_post(
    'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/billing-line-webhook/notify',
    jsonb_build_object('text', p_text),
    '{}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (config_json ->> 'internal_secret')
    ),
    5000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function public.enqueue_billing_line_notification(text) from public, anon, authenticated;
grant execute on function public.enqueue_billing_line_notification(text) to service_role;
