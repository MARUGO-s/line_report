import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readChatPageSource } from './helpers/chat-page-source.mjs';

const root = new URL('..', import.meta.url);
const read = (path) => path === 'public/chat.html'
  ? readChatPageSource()
  : readFile(new URL(path, root), 'utf8');

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

test('M-talk menu image reuses the first vision pass, retries only low-quality menus, and requires an authenticated decision', async () => {
  const [chat, dispatch, bridge, api, migration] = await Promise.all([
    read('public/chat.html'),
    read('supabase/functions/chat-knowledge/index.ts'),
    read('supabase/functions/_shared/chat_store_file_bridge.ts'),
    read('supabase/functions/admin-api/index.ts'),
    read('supabase/migrations/20260911040000_chat_menu_knowledge_drafts.sql'),
  ]);

  assert.match(bridge, /const menuPrompt = \[/);
  assert.match(bridge, /KNOWLEDGE_MENU_EXTRACTION_PROMPT_BLOCK/);
  assert.match(bridge, /buildStoreKnowledgeSpecializedPromptBlock\(registry\.store_partition_key\)/);
  assert.match(bridge, /menuKnowledge/);
  assert.match(bridge, /if \(menuKnowledge\?\.needs_review\) \{[\s\S]*-menu-retry[\s\S]*preferMenuKnowledgeResult/);
  assert.match(bridge, /const retryPrompt = \[[\s\S]*menuPrompt,[\s\S]*メニュー品質再確認/);
  const offerBlock = dispatch.slice(
    dispatch.indexOf('async function offerMenuKnowledgeRegistration'),
    dispatch.indexOf('/** payload から添付ファイル情報'),
  );
  assert.doesNotMatch(offerBlock, /knowledge\/analyze-image|callKnowledgeGemini/);
  assert.match(dispatch, /from\("chat_menu_knowledge_drafts"\)[\s\S]*source_message_id/);
  assert.match(dispatch, /kind: "menu_knowledge_draft"/);

  assert.match(chat, /parseMenuKnowledgeDecisionCommand/);
  assert.match(chat, /adminApiUrl\('\/chat-menu-knowledge-decision'\)/);
  const commandStart = chat.indexOf('async function sendCardCommand');
  const commandBlock = chat.slice(commandStart, chat.indexOf('\nasync function', commandStart + 20));
  assert.ok(commandBlock.indexOf('parseMenuKnowledgeDecisionCommand') < commandBlock.indexOf("from('chat_messages')"));

  assert.match(api, /path === "\/chat-menu-knowledge-decision"/);
  assert.match(api, /authenticateChatMember\(req, supabase, groupId, "send"\)/);
  assert.match(api, /requireMtalkRoomStoreBinding\(supabase, userId, groupId, room\.storeKey\)/);
  assert.match(api, /\.eq\("id", draftId\)[\s\S]*\.eq\("group_id", groupId\)/);
  assert.match(api, /toSafeString\(draft\.requested_by\) !== userId/);
  assert.match(api, /画像の投稿者本人だけ/);
  assert.match(api, /decision === "decline"/);
  assert.match(api, /saveStoreKnowledge\(supabase/);
  assert.match(api, /\.eq\("sha256_hex", sha256Hex\)[\s\S]*\.eq\("is_active", true\)/);
  assert.match(api, /chat_guard_message_edit intentionally freezes card payloads/);
  assert.match(api, /\.insert\(\{[\s\S]*kind: "card"[\s\S]*kind: "menu_knowledge_draft"/);
  assert.match(api, /\.update\(\{ card_message_id: replacementId/);
  assert.match(api, /\.delete\(\)[\s\S]*\.eq\("id", cardMessageId\)/);
  assert.match(api, /if \(uploadedPath && !persistedDocumentId\)/);
  assert.match(api, /mtalkMenuKnowledgeImageFileName\(draft\.source_message_id, mimeType\)/);
  assert.match(chat, /const groupId = currentGroupId;[\s\S]*group_id: groupId/);

  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.chat_menu_knowledge_drafts from public, anon, authenticated/);
  assert.match(migration, /unique \(source_message_id\)/);
});
