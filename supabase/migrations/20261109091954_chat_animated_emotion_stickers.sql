-- M-talkに8コマのアニメーション感情スタンプ10種を追加する。

alter table public.chat_stickers
  drop constraint if exists chat_stickers_asset_path_check;
alter table public.chat_stickers
  add constraint chat_stickers_asset_path_check
  check (
    asset_path ~ '^stickers/face/.+\.(png|webp)$'
    or asset_path ~ '^stickers/symbol/.+\.png$'
  );

insert into public.chat_stickers (id, label, asset_path, sort_order, category, is_active) values
  ('emotion-happy-animated', 'うれしい', 'stickers/face/mtalk-emotion-01-happy.webp', 133, 'emotion', true),
  ('emotion-thanks-animated', 'ありがとう', 'stickers/face/mtalk-emotion-02-thanks.webp', 134, 'emotion', true),
  ('emotion-love-animated', 'だいすき', 'stickers/face/mtalk-emotion-03-love.webp', 135, 'emotion', true),
  ('emotion-sad-animated', 'かなしい', 'stickers/face/mtalk-emotion-04-sad.webp', 136, 'emotion', true),
  ('emotion-sorry-animated', 'ごめん', 'stickers/face/mtalk-emotion-05-sorry.webp', 137, 'emotion', true),
  ('emotion-surprised-animated', 'びっくり', 'stickers/face/mtalk-emotion-06-surprised.webp', 138, 'emotion', true),
  ('emotion-angry-animated', 'ぷんぷん', 'stickers/face/mtalk-emotion-07-angry.webp', 139, 'emotion', true),
  ('emotion-confused-animated', '困った', 'stickers/face/mtalk-emotion-08-confused.webp', 140, 'emotion', true),
  ('emotion-sleepy-animated', 'ねむい', 'stickers/face/mtalk-emotion-09-sleepy.webp', 141, 'emotion', true),
  ('emotion-cheer-animated', '応援', 'stickers/face/mtalk-emotion-10-cheer.webp', 142, 'emotion', true)
on conflict (id) do update set
  label = excluded.label,
  asset_path = excluded.asset_path,
  sort_order = excluded.sort_order,
  category = excluded.category,
  is_active = excluded.is_active;
