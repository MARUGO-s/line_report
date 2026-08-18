-- チャットアイコンで SVG を受け付ける。

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml'
]::text[]
where id = 'chat-icons';
