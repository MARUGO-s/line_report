-- M-talk チャットメッセージの通知なし（サイレント送信）用カラム追加

alter table if exists public.chat_messages
  add column if not exists is_silent boolean not null default false;

comment on column public.chat_messages.is_silent is 'trueの場合、Web PushやLINE等へのプッシュ通知をスキップして静かに送信する';
