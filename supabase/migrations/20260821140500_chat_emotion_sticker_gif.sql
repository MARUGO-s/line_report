-- M-talk 感情イラストへアニメーションGIFを追加する。

alter table public.chat_stickers
  drop constraint if exists chat_stickers_asset_path_check;

alter table public.chat_stickers
  add constraint chat_stickers_asset_path_check
  check (asset_path ~ '^stickers/face/.+\.(png|gif)$');

insert into public.chat_stickers (id, label, asset_path, sort_order, is_active)
values ('hello-character', 'こんにちは', 'stickers/face/rh4dx-0yp8a.gif', 40, true)
on conflict (id) do update set
  label = excluded.label,
  asset_path = excluded.asset_path,
  sort_order = excluded.sort_order,
  is_active = true;
