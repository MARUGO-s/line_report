insert into summary_settings (id, admin_dashboard_token_hash)
values (1, '44bbeb373d94e7e16991e6544be9e3bf256d380aed3d9241a08da3d435188d25')
on conflict (id)
do update set admin_dashboard_token_hash = excluded.admin_dashboard_token_hash;
