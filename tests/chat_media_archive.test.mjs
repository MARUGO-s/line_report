import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('M-talk image posts are archived in the existing LINE media library', async () => {
  const [chat, mediaPage, api, mediaStore, bridge, auth, ai] = await Promise.all([
    read('public/chat.html'),
    read('public/media.html'),
    read('supabase/functions/admin-api/index.ts'),
    read('supabase/functions/_shared/line_media_store.ts'),
    read('supabase/functions/_shared/chat_store_file_bridge.ts'),
    read('supabase/functions/_shared/admin_dashboard_link_auth.ts'),
    read('supabase/functions/ai-analyze/index.ts'),
  ]);

  assert.match(chat, /adminApiUrl\('\/chat-media-archive'\)/);
  assert.match(chat, /archiveChatImageInMediaLibrary\(data\.id, groupId\)/);
  assert.match(api, /req\.method === "POST" && path === "\/chat-media-archive"/);
  assert.match(api, /authenticateChatMember\(req, supabase, groupId, "send"\)/);
  assert.match(api, /\.eq\("user_id", userId\)/);
  assert.ok(api.includes('imagePath.startsWith(`groups/${groupId}/`)'));
  assert.match(api, /storage\.from\("chat-images"\)\.download\(imagePath\)/);
  assert.match(api, /saveMediaBytesToLibrary\(supabase/);
  assert.match(api, /lineMessageId: `mtalk-\$\{groupId\}-\$\{messageId\}`/);
  assert.match(mediaStore, /const MEDIA_LIBRARY_BUCKET = 'line-media'/);
  assert.match(mediaStore, /\.from\('line_message_media'\)\.insert/);
  assert.match(bridge, /return `mtalk-\$\{groupId\}-\$\{chatMessageId\}`/);
  assert.match(bridge, /const roomId = `mtalk-group-\$\{params\.groupId\}`/);
  assert.doesNotMatch(bridge, /const lineRoomId = await resolveStoreLineRoomId/);

  assert.match(chat, /CONFIG\.adminApiUrl\('\/chat-media-link'\)/);
  assert.match(chat, /target\.searchParams\.set\('lt', body\.login_token\)/);
  assert.match(mediaPage, /const MTALK_MEDIA_ONLY = new URLSearchParams\(window\.location\.search\)\.get\('from'\) === 'mtalk';/);
  assert.match(mediaPage, /document\.body\.classList\.add\('mtalk-media-only'\)/);
  assert.match(mediaPage, /body\.mtalk-media-only \.ms-side/);
  assert.match(mediaPage, /body\.mtalk-media-only #toggleMediaBulkDeleteBtn/);
  assert.match(api, /path === "\/chat-media-view"/);
  assert.match(api, /user_id, sender_display_name/);
  assert.match(api, /fetchRoomNameMapForIds\(supabase, rows\.map\(\(row\) => row\.room_id\)\)/);
  assert.match(api, /fetchSenderNameMapForUserIds/);
  assert.match(api, /room_name: roomNameMap\.get\(row\.room_id\)/);
});
