alter table public.foodcourt_weekly_reports
  add column if not exists report_html text;

comment on column public.foodcourt_weekly_reports.report_html
  is 'LINEから開く週次レポートの保存済みHTML本文。';

update public.foodcourt_weekly_reports
set report_html = '<article class="weekly-report-content">' ||
  replace(replace(replace(replace(replace(coalesce(ai_report, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), chr(10), '<br>'), chr(13), '') ||
  '</article>'
where report_html is null and ai_report is not null;
