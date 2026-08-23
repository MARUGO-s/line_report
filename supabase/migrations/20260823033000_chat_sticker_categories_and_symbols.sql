-- M-talkの感情イラストをカテゴリ分けし、漫符・記号イラストを追加する。

alter table public.chat_stickers
  add column if not exists category text not null default 'emotion';

alter table public.chat_stickers
  drop constraint if exists chat_stickers_category_check;
alter table public.chat_stickers
  add constraint chat_stickers_category_check
  check (category in ('emotion', 'symbol'));

alter table public.chat_stickers
  drop constraint if exists chat_stickers_asset_path_check;
alter table public.chat_stickers
  add constraint chat_stickers_asset_path_check
  check (
    asset_path like 'stickers/face/%.png'
    or asset_path like 'stickers/symbol/%.png'
  );

insert into public.chat_stickers (id, label, asset_path, sort_order, category, is_active) values
  ('symbol-nc203932', 'もやもや', 'stickers/symbol/nc203932.png', 94, 'symbol', true),
  ('symbol-nc205971', 'ドン引き', 'stickers/symbol/nc205971.png', 95, 'symbol', true),
  ('symbol-nc206073', '魂が抜ける', 'stickers/symbol/nc206073.png', 96, 'symbol', true),
  ('symbol-nc209292', 'どくろ', 'stickers/symbol/nc209292.png', 97, 'symbol', true),
  ('symbol-nc212730', 'ガーン', 'stickers/symbol/nc212730.png', 98, 'symbol', true),
  ('symbol-nc212736', '失敗した', 'stickers/symbol/nc212736.png', 99, 'symbol', true),
  ('symbol-nc251023', '音符', 'stickers/symbol/nc251023.png', 100, 'symbol', true),
  ('symbol-nc252391', '怒り', 'stickers/symbol/nc252391.png', 101, 'symbol', true),
  ('symbol-nc252663', 'ZZZ', 'stickers/symbol/nc252663.png', 102, 'symbol', true),
  ('symbol-nc263818', '血痕', 'stickers/symbol/nc263818.png', 103, 'symbol', true),
  ('symbol-nc284624', '笑いながら怒る', 'stickers/symbol/nc284624.png', 104, 'symbol', true),
  ('symbol-nc284661', 'びっくり', 'stickers/symbol/nc284661.png', 105, 'symbol', true),
  ('symbol-nc285375', '呆れる', 'stickers/symbol/nc285375.png', 106, 'symbol', true),
  ('symbol-nc286328', 'いびき', 'stickers/symbol/nc286328.png', 107, 'symbol', true),
  ('symbol-nc286478', '汗・涙', 'stickers/symbol/nc286478.png', 108, 'symbol', true),
  ('symbol-nc286570', 'おばけ', 'stickers/symbol/nc286570.png', 109, 'symbol', true),
  ('symbol-nc291025', 'ルンルン', 'stickers/symbol/nc291025.png', 110, 'symbol', true),
  ('symbol-nc291217', '衝撃', 'stickers/symbol/nc291217.png', 111, 'symbol', true),
  ('symbol-nc293180', '失恋', 'stickers/symbol/nc293180.png', 112, 'symbol', true),
  ('symbol-nc293667', 'ぐるぐる', 'stickers/symbol/nc293667.png', 113, 'symbol', true),
  ('symbol-nc293905', '激熱', 'stickers/symbol/nc293905.png', 114, 'symbol', true),
  ('symbol-nc295015', '割れたハート', 'stickers/symbol/nc295015.png', 115, 'symbol', true),
  ('symbol-nc297728', '天使', 'stickers/symbol/nc297728.png', 116, 'symbol', true),
  ('symbol-nc300747', 'びっくり', 'stickers/symbol/nc300747.png', 117, 'symbol', true),
  ('symbol-nc354866', 'いびき', 'stickers/symbol/nc354866.png', 118, 'symbol', true),
  ('symbol-nc397833', '照れ', 'stickers/symbol/nc397833.png', 119, 'symbol', true),
  ('symbol-nc439487', '頭を抱える', 'stickers/symbol/nc439487.png', 120, 'symbol', true),
  ('symbol-nc440211', '疲れた', 'stickers/symbol/nc440211.png', 121, 'symbol', true),
  ('symbol-nc441785', '勝った', 'stickers/symbol/nc441785.png', 122, 'symbol', true),
  ('symbol-nc454154', 'びっくり！？', 'stickers/symbol/nc454154.png', 123, 'symbol', true),
  ('symbol-nc454166', '大汗', 'stickers/symbol/nc454166.png', 124, 'symbol', true),
  ('symbol-nc454409', 'ぐるぐる', 'stickers/symbol/nc454409.png', 125, 'symbol', true),
  ('symbol-nc461717', '！！', 'stickers/symbol/nc461717.png', 126, 'symbol', true),
  ('symbol-nc461718', '！？', 'stickers/symbol/nc461718.png', 127, 'symbol', true),
  ('symbol-nc470979', 'ひらめき', 'stickers/symbol/nc470979.png', 128, 'symbol', true),
  ('symbol-nc480030', '思いついた', 'stickers/symbol/nc480030.png', 129, 'symbol', true),
  ('symbol-nc486172', '汗・焦り', 'stickers/symbol/nc486172.png', 130, 'symbol', true),
  ('symbol-nc486379', '慌てる', 'stickers/symbol/nc486379.png', 131, 'symbol', true),
  ('symbol-nc497064', '怒り', 'stickers/symbol/nc497064.png', 132, 'symbol', true)
on conflict (id) do update set
  label = excluded.label,
  asset_path = excluded.asset_path,
  sort_order = excluded.sort_order,
  category = excluded.category,
  is_active = excluded.is_active;

comment on column public.chat_stickers.category is
  'M-talkピッカーのタブ分類。emotion=感情、symbol=漫符・記号。';
