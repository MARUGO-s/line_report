-- Remove legacy `using (true)` write policies that accidentally treated
-- anonymous and M-talk authenticated clients as backend writers.

drop policy if exists service_role_all on public.foodcourt_weekly_reports;
create policy service_role_all on public.foodcourt_weekly_reports
  for all to service_role
  using (true)
  with check (true);

revoke all privileges on table public.foodcourt_weekly_reports
  from public, anon, authenticated;
grant all privileges on table public.foodcourt_weekly_reports
  to service_role;

drop policy if exists "Allow public read" on public.giants_game_results;
drop policy if exists "Allow system write" on public.giants_game_results;

-- Game results are non-sensitive public facts, so read access is retained.
create policy "Allow public read" on public.giants_game_results
  for select to anon, authenticated
  using (true);

create policy "Allow system write" on public.giants_game_results
  for all to service_role
  using (true)
  with check (true);

revoke all privileges on table public.giants_game_results
  from public, anon, authenticated;
grant select on table public.giants_game_results
  to anon, authenticated;
grant all privileges on table public.giants_game_results
  to service_role;
