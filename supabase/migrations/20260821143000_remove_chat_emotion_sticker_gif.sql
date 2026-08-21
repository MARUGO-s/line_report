delete from public.chat_stickers
where sticker_key = 'hello-character';

alter table public.chat_stickers
  drop constraint if exists chat_stickers_asset_path_check;

alter table public.chat_stickers
  add constraint chat_stickers_asset_path_check
  check (asset_path ~ '^stickers/face/.+\.png$');
