'use strict';

// ============================================================================
// M-talk Web <-> ネイティブアプリ版 (build 80) 完全連携モジュール
// 1) 複数写真まとめ送信・ギャラリー表示・前後切替ライトボックス
// 2) ボイスメッセージ再生・3分上限ブラウザ録音送信・ワンタップ文字起こし
// 3) 動画メッセージ送信・インライン再生
// 4) 確認依頼 / チェックリスト / 投票カード & chat_message_interactions リアルタイム同期
// 5) 通話ログカード表示
// 6) / マニュアル参照 AI 質問 (help_qa / gpt-6-luna)
// 7) AI 機能連携 (トーク要約・未読AIまとめ・10言語翻訳・AI返信案・予定抽出・画像/PDF OCR)
// 8) 通知のおやすみ時間設定 (chat-push?action=preferences 同期)
// ============================================================================

const APP_COMPAT_MAX_GALLERY_ITEMS = 10;
const APP_COMPAT_VOICE_MAX_SECONDS = 180;
const APP_COMPAT_VOICE_WARN_SECONDS = 150;

const APP_COMPAT_TRANSLATE_LANGS = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: 'English（英語）' },
  { code: 'vi', label: 'Tiếng Việt（ベトナム語）' },
  { code: 'ne', label: 'नेपाली（ネパール語）' },
  { code: 'zh', label: '中文（中国語）' },
  { code: 'ko', label: '한국어（韓国語）' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'tl', label: 'Tagalog（タガログ語）' },
  { code: 'th', label: 'ไทย（タイ語）' },
  { code: 'my', label: 'မြန်မာ（ミャンマー語）' },
];

const APP_COMPAT_WEEKDAYS = [
  { day: 0, label: '日' },
  { day: 1, label: '月' },
  { day: 2, label: '火' },
  { day: 3, label: '水' },
  { day: 4, label: '木' },
  { day: 5, label: '金' },
  { day: 6, label: '土' },
];

let interactionsByMessage = new Map();
const voiceTranscriptsByMessage = new Map();
const voiceTranscribingIds = new Set();
const inlineTranslationsByMessage = new Map();
const helpQaCardsByGroup = new Map();
const helpQaHistoryByGroup = new Map();

let voiceRecorderState = null;
let appCompatActiveModalCleanup = null;

// --- ペイロード判定・パーサー（ネイティブ版 models.dart と完全一致） ---

function parseAppPayload(msg) {
  if (!msg || !msg.payload) return null;
  if (typeof msg.payload === 'string') {
    try { return JSON.parse(msg.payload); } catch (_) { return null; }
  }
  return typeof msg.payload === 'object' ? msg.payload : null;
}

function galleryPathsFromMessage(msg) {
  if (!msg || msg.kind !== 'image') return [];
  const payload = parseAppPayload(msg);
  if (!payload || !Array.isArray(payload.gallery) || payload.gallery.length < 2) return [];
  const out = [];
  for (const entry of payload.gallery) {
    const path = entry && typeof entry === 'object'
      ? String(entry.path || '').trim()
      : String(entry || '').trim();
    if (path) out.push(path);
  }
  return out.length >= 2 ? out : [];
}

function voiceMemoFromMessage(msg) {
  if (!msg) return null;
  const payload = parseAppPayload(msg);
  const raw = payload && payload.voice_memo;
  if (raw && typeof raw === 'object' && Object.keys(raw).length) return raw;
  if (msg.kind === 'file') {
    const file = payload && payload.file;
    const mime = String((file && file.mime) || '').toLowerCase();
    const name = String((file && file.name) || '').toLowerCase();
    if (mime.startsWith('audio/') || /\.(m4a|mp3|wav|ogg|aac|webm)$/.test(name) && /ボイスメッセージ|voice/i.test(String(msg.content || name))) {
      const m = /\((\d+):(\d{2})\)/.exec(String(msg.content || ''));
      const sec = m ? (Number(m[1]) * 60 + Number(m[2])) : 0;
      return { duration_seconds: sec > 0 ? sec : 0 };
    }
  }
  return null;
}

function isVideoMessage(msg) {
  if (!msg || msg.kind !== 'file') return false;
  const payload = parseAppPayload(msg);
  const file = payload && payload.file;
  const mime = String((file && file.mime) || '').toLowerCase();
  if (mime.startsWith('video/')) return true;
  const name = String((file && file.name) || (file && file.path) || '').toLowerCase();
  return /\.(mp4|mov|m4v|webm)$/.test(name);
}

function isAiAnalyzableAttachmentMessage(msg) {
  if (!msg) return false;
  if (msg.kind === 'image') return !!(imageFromMessage(msg) || galleryPathsFromMessage(msg).length);
  if (msg.kind !== 'file' || voiceMemoFromMessage(msg) || isVideoMessage(msg)) return false;
  const file = fileFromMessage(msg);
  if (!file || !file.path) return false;
  const mime = String(file.mime || '').toLowerCase();
  const name = String(file.name || file.path || '').toLowerCase();
  return mime === 'application/pdf'
    || mime.startsWith('image/')
    || mime.startsWith('text/')
    || /\.(pdf|txt|csv|png|jpe?g|webp)$/.test(name);
}

function callLogFromMessage(msg) {
  const payload = parseAppPayload(msg);
  const raw = payload && payload.call_log;
  return raw && typeof raw === 'object' && Object.keys(raw).length ? raw : null;
}

function ackRequestFromMessage(msg) {
  const payload = parseAppPayload(msg);
  const raw = payload && payload.ack_request;
  return raw && typeof raw === 'object' && Object.keys(raw).length ? raw : null;
}

function checklistFromMessage(msg) {
  const payload = parseAppPayload(msg);
  const raw = payload && payload.checklist;
  return raw && typeof raw === 'object' && Object.keys(raw).length ? raw : null;
}

function pollFromMessage(msg) {
  const payload = parseAppPayload(msg);
  const raw = payload && payload.poll;
  return raw && typeof raw === 'object' && Object.keys(raw).length ? raw : null;
}

function isInteractiveMessage(msg) {
  return !!(ackRequestFromMessage(msg) || checklistFromMessage(msg) || pollFromMessage(msg));
}

function isVideoFile(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return /^video\/(mp4|quicktime|webm)$/.test(type) || /\.(mp4|mov|m4v|webm)$/.test(name);
}

function isAudioFile(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return /^audio\/(mp4|m4a|mpeg|wav|webm|ogg|aac)$/.test(type) || /\.(m4a|mp3|wav|ogg|aac)$/.test(name);
}

function formatDurationMmSs(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatDurationPadded(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function appCompatMessagePreview(msg) {
  if (!msg) return '';
  if (msg.kind === 'image') {
    const gallery = galleryPathsFromMessage(msg);
    return gallery.length >= 2 ? `[写真 ${gallery.length}枚]` : '[画像]';
  }
  if (msg.kind === 'file') {
    if (voiceMemoFromMessage(msg)) return '🎤 ボイスメッセージ';
    if (isVideoMessage(msg)) return '🎬 動画';
    const file = fileFromMessage(msg);
    return file && file.name ? `[ファイル] ${file.name}` : '[ファイル]';
  }
  const ack = ackRequestFromMessage(msg);
  if (ack) return `【要確認】${ack.title || msg.content || ''}`;
  const checklist = checklistFromMessage(msg);
  if (checklist) return `【チェックリスト】${checklist.title || msg.content || ''}`;
  const poll = pollFromMessage(msg);
  if (poll) return `【投票】${poll.question || msg.content || ''}`;
  const callLog = callLogFromMessage(msg);
  if (callLog) return formatCallLogHeadline(callLog).title;
  return '';
}

// --- chat_message_interactions 読込・Realtime 同期・操作 ---

function resetAppCompatMessageState() {
  interactionsByMessage = new Map();
  voiceTranscribingIds.clear();
}

async function loadMessageInteractions(messageIds) {
  const ids = [...new Set((messageIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const missing = ids.filter((id) => !interactionsByMessage.has(id));
  if (!missing.length) return;
  missing.forEach((id) => interactionsByMessage.set(id, []));
  try {
    const { data, error } = await sb
      .from('chat_message_interactions')
      .select('message_id,kind,item_key,actor_key,user_id,username,value,updated_at')
      .in('message_id', missing);
    if (error) throw error;
    (data || []).forEach((row) => {
      const mid = Number(row.message_id);
      const list = interactionsByMessage.get(mid) || [];
      list.push(row);
      interactionsByMessage.set(mid, list);
    });
  } catch (error) {
    console.error('Load message interactions error:', error);
  }
}

function handleInteractionRealtimeChange(payload) {
  const row = payload && payload.new && payload.new.message_id
    ? payload.new
    : (payload && payload.old ? payload.old : null);
  if (!row || !row.message_id) return;
  const messageId = Number(row.message_id);
  const existsInView = currentMessages.some((m) => Number(m.id) === messageId);
  if (!existsInView) return;

  const list = (interactionsByMessage.get(messageId) || []).slice();
  const match = (item) => String(item.kind) === String(row.kind)
    && String(item.item_key) === String(row.item_key)
    && String(item.actor_key) === String(row.actor_key);
  const without = list.filter((item) => !match(item));
  const next = payload.eventType === 'DELETE' ? without : without.concat([row]);
  interactionsByMessage.set(messageId, next);
  refreshMessageNode(messageId);
}

function interactionsForMessage(messageId) {
  return interactionsByMessage.get(Number(messageId)) || [];
}

async function toggleAckConfirmation(messageId) {
  if (!currentUser || !requireCurrentRoomSend()) return;
  const mid = Number(messageId);
  const uid = String(currentUser.id);
  const uname = String(currentUser.username || 'メンバー');
  const current = interactionsForMessage(mid).slice();
  const already = current.some((i) => i.kind === 'ack' && i.item_key === 'ack' && i.actor_key === uid);
  const updated = already
    ? current.filter((i) => !(i.kind === 'ack' && i.item_key === 'ack' && i.actor_key === uid))
    : current.concat([{
        message_id: mid,
        kind: 'ack',
        item_key: 'ack',
        actor_key: uid,
        user_id: uid,
        username: uname,
        value: { acked: true },
        updated_at: new Date().toISOString(),
      }]);
  interactionsByMessage.set(mid, updated);
  refreshMessageNode(mid);
  try {
    if (already) {
      const { error } = await sb.from('chat_message_interactions')
        .delete()
        .eq('message_id', mid)
        .eq('kind', 'ack')
        .eq('item_key', 'ack')
        .eq('actor_key', uid);
      if (error) throw error;
    } else {
      const { error } = await sb.from('chat_message_interactions')
        .upsert({
          message_id: mid,
          kind: 'ack',
          item_key: 'ack',
          actor_key: uid,
          user_id: uid,
          username: uname,
          value: { acked: true },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'message_id,kind,item_key,actor_key' });
      if (error) throw error;
    }
  } catch (error) {
    console.error('Toggle ack error:', error);
    interactionsByMessage.set(mid, current);
    refreshMessageNode(mid);
    showChatToast('確認状態の更新に失敗しました');
  }
}

async function remindUnackedMembers(messageId) {
  if (!currentUser || !requireCurrentRoomSend()) return;
  const mid = Number(messageId);
  const msg = currentMessages.find((m) => Number(m.id) === mid);
  const ack = msg && ackRequestFromMessage(msg);
  if (!ack) return;
  const rows = interactionsForMessage(mid).filter((i) => i.kind === 'ack');
  const ackedIds = new Set(rows.map((r) => String(r.user_id || r.actor_key)));
  const targets = (groupMembers || []).filter((u) => u && !u.is_bot
    && String(u.id) !== String(msg.user_id)
    && !ackedIds.has(String(u.id)));
  if (!targets.length) {
    showChatToast('全員が確認済みです');
    return;
  }
  const names = targets.map((u) => `@${personName(u)}`).join(' ');
  const title = String(ack.title || '確認依頼').trim();
  if (!confirm(`未確認の ${targets.length} 名へ再通知メッセージを送信しますか？\n\n${names}`)) return;
  await sendChatText(`${names}\n「${title}」のご確認をお願いします。`, { withReply: false });
}

async function toggleChecklistItem(messageId, itemId) {
  if (!currentUser || !requireCurrentRoomSend()) return;
  const mid = Number(messageId);
  const key = String(itemId || '').trim();
  if (!key) return;
  const uid = String(currentUser.id);
  const uname = String(currentUser.username || 'メンバー');
  const current = interactionsForMessage(mid).slice();
  const existing = current.find((i) => i.kind === 'checklist' && i.item_key === key && i.actor_key === 'shared');
  const nextChecked = !(existing && existing.value && existing.value.checked === true);
  const updated = current
    .filter((i) => !(i.kind === 'checklist' && i.item_key === key && i.actor_key === 'shared'))
    .concat([{
      message_id: mid,
      kind: 'checklist',
      item_key: key,
      actor_key: 'shared',
      user_id: uid,
      username: uname,
      value: { checked: nextChecked },
      updated_at: new Date().toISOString(),
    }]);
  interactionsByMessage.set(mid, updated);
  refreshMessageNode(mid);
  try {
    const { error } = await sb.from('chat_message_interactions').upsert({
      message_id: mid,
      kind: 'checklist',
      item_key: key,
      actor_key: 'shared',
      user_id: uid,
      username: uname,
      value: { checked: nextChecked },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'message_id,kind,item_key,actor_key' });
    if (error) throw error;
  } catch (error) {
    console.error('Toggle checklist error:', error);
    interactionsByMessage.set(mid, current);
    refreshMessageNode(mid);
    showChatToast('チェックリストの更新に失敗しました');
  }
}

async function togglePollVote(messageId, optionId, multiple) {
  if (!currentUser || !requireCurrentRoomSend()) return;
  const mid = Number(messageId);
  const opt = String(optionId || '').trim();
  if (!opt) return;
  const uid = String(currentUser.id);
  const uname = String(currentUser.username || 'メンバー');
  const current = interactionsForMessage(mid).slice();
  const already = current.some((i) => i.kind === 'poll' && i.item_key === opt && i.actor_key === uid);
  let updated = current.slice();
  if (!multiple) {
    updated = updated.filter((i) => !(i.kind === 'poll' && i.actor_key === uid));
  } else if (already) {
    updated = updated.filter((i) => !(i.kind === 'poll' && i.item_key === opt && i.actor_key === uid));
  }
  if (!already) {
    updated.push({
      message_id: mid,
      kind: 'poll',
      item_key: opt,
      actor_key: uid,
      user_id: uid,
      username: uname,
      value: { voted: true },
      updated_at: new Date().toISOString(),
    });
  }
  interactionsByMessage.set(mid, updated);
  refreshMessageNode(mid);
  try {
    if (!multiple) {
      const { error } = await sb.from('chat_message_interactions')
        .delete()
        .eq('message_id', mid)
        .eq('kind', 'poll')
        .eq('actor_key', uid);
      if (error) throw error;
    } else if (already) {
      const { error } = await sb.from('chat_message_interactions')
        .delete()
        .eq('message_id', mid)
        .eq('kind', 'poll')
        .eq('item_key', opt)
        .eq('actor_key', uid);
      if (error) throw error;
    }
    if (!already) {
      const { error } = await sb.from('chat_message_interactions').upsert({
        message_id: mid,
        kind: 'poll',
        item_key: opt,
        actor_key: uid,
        user_id: uid,
        username: uname,
        value: { voted: true },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'message_id,kind,item_key,actor_key' });
      if (error) throw error;
    }
  } catch (error) {
    console.error('Toggle poll vote error:', error);
    interactionsByMessage.set(mid, current);
    refreshMessageNode(mid);
    showChatToast('投票の反映に失敗しました');
  }
}

// --- 新ペイロード専用レンダリング ---

function formatCallLogHeadline(callLog) {
  const type = String(callLog.call_type || 'audio').toLowerCase();
  const isVideo = type === 'video';
  const isGroup = callLog.is_group === true;
  const outcome = String(callLog.outcome || callLog.status || '').toLowerCase();
  const sec = Math.max(0, Math.floor(Number(callLog.duration_seconds) || 0));
  const icon = isVideo ? '📹' : (isGroup ? '👥' : '📞');
  const label = isGroup
    ? (isVideo ? 'グループビデオ通話' : 'グループ音声通話')
    : (isVideo ? 'ビデオ通話' : '音声通話');
  if (outcome === 'missed') return { icon, title: label, sub: '不在着信', missed: true };
  if (outcome === 'declined') return { icon, title: label, sub: '応答なし・拒否', missed: true };
  if (outcome === 'canceled' || (outcome === 'ended' && sec === 0)) {
    return { icon, title: label, sub: 'キャンセル', missed: false };
  }
  return { icon, title: label, sub: sec > 0 ? formatDurationPadded(sec) : '通話終了', missed: false };
}

function renderGalleryHtml(msg, paths) {
  const colsClass = paths.length === 2 ? 'cols-2' : (paths.length === 4 ? 'cols-2' : 'cols-3');
  const items = paths.map((path, idx) => `
    <button type="button" class="msg-gallery-tile" data-gallery-open="${Number(msg.id)}" data-gallery-index="${idx}" aria-label="写真 ${idx + 1}/${paths.length} を拡大">
      <img class="msg-image" data-path="${escapeHtml(path)}" alt="写真 ${idx + 1}" loading="lazy" decoding="async">
    </button>
  `).join('');
  return `<div class="msg-gallery ${colsClass}" data-gallery-count="${paths.length}">
    ${items}
    <span class="msg-gallery-badge">${paths.length}枚</span>
  </div>`;
}

function renderVoiceMessageHtml(msg, file, voiceMemo) {
  const durationSec = Number(voiceMemo && voiceMemo.duration_seconds) || 0;
  const durationLabel = durationSec > 0 ? formatDurationMmSs(durationSec) : '';
  const transcript = voiceTranscriptsByMessage.get(Number(msg.id)) || '';
  const busy = voiceTranscribingIds.has(Number(msg.id));
  return `<div class="message-bubble voice-bubble">
    <div class="voice-bubble-head">
      <span class="voice-bubble-icon" aria-hidden="true">🎤</span>
      <span class="voice-bubble-title">ボイスメッセージ</span>
      ${durationLabel ? `<span class="voice-bubble-duration">${escapeHtml(durationLabel)}</span>` : ''}
    </div>
    <audio class="voice-audio" controls preload="metadata" data-media-path="${escapeHtml(file.path)}"></audio>
    <div class="voice-bubble-actions">
      <button type="button" class="voice-transcribe-btn" data-transcribe-voice="${Number(msg.id)}" ${busy ? 'disabled' : ''}>
        ${busy ? '文字起こし中…' : (transcript ? '再文字起こし' : '文字で見る')}
      </button>
    </div>
    ${transcript ? `<div class="voice-transcript">${escapeHtml(transcript)}</div>` : ''}
  </div>`;
}

function renderVideoMessageHtml(msg, file) {
  const name = String(file.name || '動画');
  const size = Number(file.size) > 0 ? `${(Number(file.size) / 1024 / 1024).toFixed(2)} MB` : '';
  return `<div class="video-card">
    <video class="msg-video" controls playsinline preload="metadata" data-media-path="${escapeHtml(file.path)}"></video>
    <div class="video-card-footer">
      <span class="video-card-name" title="${escapeHtml(name)}">🎬 ${escapeHtml(name)}</span>
      ${size ? `<span class="video-card-size">${escapeHtml(size)}</span>` : ''}
      <a class="video-card-dl" data-media-download-path="${escapeHtml(file.path)}" download="${escapeHtml(name)}" href="#">保存</a>
    </div>
  </div>`;
}

function renderCallLogHtml(callLog) {
  const info = formatCallLogHeadline(callLog);
  return `<div class="message-bubble call-log-bubble${info.missed ? ' is-missed' : ''}">
    <span class="call-log-icon" aria-hidden="true">${info.icon}</span>
    <span class="call-log-body">
      <span class="call-log-title">${escapeHtml(info.title)}</span>
      <span class="call-log-sub">${escapeHtml(info.sub)}</span>
    </span>
  </div>`;
}

function renderAckCardHtml(msg, ack) {
  const mid = Number(msg.id);
  const rows = interactionsForMessage(mid).filter((i) => i.kind === 'ack');
  const uid = currentUser ? String(currentUser.id) : '';
  const mineAcked = rows.some((r) => String(r.user_id || r.actor_key) === uid);
  const humans = (groupMembers || []).filter((u) => u && !u.is_bot && String(u.id) !== String(msg.user_id));
  const ackedIds = new Set(rows.map((r) => String(r.user_id || r.actor_key)));
  const targetTotal = Math.max(humans.length, rows.length);
  const unackedCount = humans.filter((u) => !ackedIds.has(String(u.id))).length;
  const urgent = ack.urgent === true;
  const canSend = canCurrentUserSend();
  const chips = rows.slice(0, 12).map((r) => `<span class="icard-chip">✓ ${escapeHtml(r.username || speakerName(r.user_id, ''))}</span>`).join('');
  const extra = rows.length > 12 ? `<span class="icard-chip">+${rows.length - 12}名</span>` : '';
  return `<div class="icard icard-ack${urgent ? ' is-urgent' : ''}">
    <div class="icard-head">
      <span class="icard-badge${urgent ? ' urgent' : ''}">${urgent ? '⚠ 重要・要確認' : '✓ 確認依頼'}</span>
      <span class="icard-stat">確認済み ${rows.length}${targetTotal > 0 ? ` / ${targetTotal}人` : '人'}</span>
    </div>
    <div class="icard-title">${escapeHtml(ack.title || '確認依頼')}</div>
    ${ack.body ? `<div class="icard-body">${escapeHtml(ack.body)}</div>` : ''}
    ${chips ? `<div class="icard-chips">${chips}${extra}</div>` : ''}
    <div class="icard-actions">
      <button type="button" class="icard-btn${mineAcked ? ' is-done' : ' primary'}" data-ack-toggle="${mid}" ${canSend ? '' : 'disabled'}>
        ${mineAcked ? '✓ 確認済み（取消）' : '確認しました'}
      </button>
      ${canSend && unackedCount > 0 ? `<button type="button" class="icard-btn secondary" data-ack-remind="${mid}">未確認 ${unackedCount}名へ再通知</button>` : ''}
    </div>
  </div>`;
}

function renderChecklistCardHtml(msg, checklist) {
  const mid = Number(msg.id);
  const items = Array.isArray(checklist.items) ? checklist.items : [];
  const rows = interactionsForMessage(mid).filter((i) => i.kind === 'checklist' && i.actor_key === 'shared');
  const stateById = new Map(rows.map((r) => [String(r.item_key), r]));
  const doneCount = items.filter((it) => {
    const st = stateById.get(String(it.id));
    return !!(st && st.value && st.value.checked === true);
  }).length;
  const canSend = canCurrentUserSend();
  const listHtml = items.map((it) => {
    const id = String(it.id || '');
    const st = stateById.get(id);
    const checked = !!(st && st.value && st.value.checked === true);
    const by = checked && st && st.username ? `<span class="icard-check-by">${escapeHtml(st.username)}</span>` : '';
    return `<button type="button" class="icard-check-row${checked ? ' is-checked' : ''}" data-checklist-toggle="${mid}" data-item-id="${escapeHtml(id)}" ${canSend ? '' : 'disabled'}>
      <span class="icard-checkbox" aria-hidden="true">${checked ? '☑' : '☐'}</span>
      <span class="icard-check-text">${escapeHtml(it.text || '')}</span>
      ${by}
    </button>`;
  }).join('');
  return `<div class="icard icard-checklist">
    <div class="icard-head">
      <span class="icard-badge">☑ チェックリスト</span>
      <span class="icard-stat">${doneCount} / ${items.length} 完了</span>
    </div>
    <div class="icard-title">${escapeHtml(checklist.title || 'チェックリスト')}</div>
    <div class="icard-list">${listHtml}</div>
  </div>`;
}

function renderPollCardHtml(msg, poll) {
  const mid = Number(msg.id);
  const options = Array.isArray(poll.options) ? poll.options : [];
  const multiple = poll.multiple === true;
  const anonymous = poll.anonymous === true;
  const rows = interactionsForMessage(mid).filter((i) => i.kind === 'poll');
  const uid = currentUser ? String(currentUser.id) : '';
  const uniqueVoters = new Set(rows.map((r) => String(r.actor_key || r.user_id)));
  const totalVotes = rows.length;
  const canSend = canCurrentUserSend();

  const optsHtml = options.map((opt) => {
    const optId = String(opt.id || '');
    const votes = rows.filter((r) => String(r.item_key) === optId);
    const mine = votes.some((r) => String(r.actor_key || r.user_id) === uid);
    const pct = totalVotes > 0 ? Math.round((votes.length / totalVotes) * 100) : 0;
    const votersText = !anonymous && votes.length
      ? `<div class="icard-poll-voters">${votes.slice(0, 6).map((v) => escapeHtml(v.username || speakerName(v.user_id, ''))).join('・')}${votes.length > 6 ? ` 他${votes.length - 6}名` : ''}</div>`
      : '';
    return `<button type="button" class="icard-poll-opt${mine ? ' is-selected' : ''}" data-poll-vote="${mid}" data-option-id="${escapeHtml(optId)}" data-poll-multiple="${multiple ? '1' : '0'}" ${canSend ? '' : 'disabled'}>
      <span class="icard-poll-bar" style="width:${pct}%"></span>
      <span class="icard-poll-row">
        <span class="icard-poll-label">${mine ? '✓ ' : ''}${escapeHtml(opt.label || '')}</span>
        <span class="icard-poll-count">${votes.length}票 (${pct}%)</span>
      </span>
      ${votersText}
    </button>`;
  }).join('');

  const metaBits = [multiple ? '複数選択可' : '単一選択'];
  if (anonymous) metaBits.push('匿名');
  metaBits.push(`${uniqueVoters.size}人回答`);

  return `<div class="icard icard-poll">
    <div class="icard-head">
      <span class="icard-badge">📊 投票</span>
      <span class="icard-stat">${escapeHtml(metaBits.join(' ・ '))}</span>
    </div>
    <div class="icard-title">${escapeHtml(poll.question || '投票')}</div>
    <div class="icard-poll-list">${optsHtml}</div>
  </div>`;
}

function renderInlineTranslationHtml(msg) {
  const tr = inlineTranslationsByMessage.get(Number(msg.id));
  if (!tr || !tr.text) return '';
  return `<div class="msg-translation">
    <div class="msg-translation-head">
      <span>🌐 翻訳（${escapeHtml(tr.langLabel || tr.targetLang || '')}）</span>
      <button type="button" data-close-translation="${Number(msg.id)}" aria-label="翻訳を閉じる">×</button>
    </div>
    <div class="msg-translation-body">${escapeHtml(tr.text)}</div>
  </div>`;
}

function renderAppCompatMessageBody(msg) {
  if (!msg) return null;
  if (msg.kind === 'image') {
    const paths = galleryPathsFromMessage(msg);
    if (paths.length >= 2) return { html: renderGalleryHtml(msg, paths), extraClass: 'gallery' };
  }
  if (msg.kind === 'file') {
    const file = fileFromMessage(msg);
    if (file && file.path) {
      const voice = voiceMemoFromMessage(msg);
      if (voice) return { html: renderVoiceMessageHtml(msg, file, voice), extraClass: 'voice' };
      if (isVideoMessage(msg)) return { html: renderVideoMessageHtml(msg, file), extraClass: 'video' };
    }
  }
  const callLog = callLogFromMessage(msg);
  if (callLog) return { html: renderCallLogHtml(callLog), extraClass: 'call-log' };
  const ack = ackRequestFromMessage(msg);
  if (ack) return { html: renderAckCardHtml(msg, ack), extraClass: 'interactive' };
  const checklist = checklistFromMessage(msg);
  if (checklist) return { html: renderChecklistCardHtml(msg, checklist), extraClass: 'interactive' };
  const poll = pollFromMessage(msg);
  if (poll) return { html: renderPollCardHtml(msg, poll), extraClass: 'interactive' };
  return null;
}

async function hydrateAppCompatMedia() {
  const container = $('messages');
  if (!container) return;
  const mediaNodes = Array.from(container.querySelectorAll('[data-media-path]'));
  const dlNodes = Array.from(container.querySelectorAll('[data-media-download-path]'));
  const wanted = [...new Set([
    ...mediaNodes.map((n) => n.dataset.mediaPath),
    ...dlNodes.map((n) => n.dataset.mediaDownloadPath),
  ].filter(Boolean))];
  if (!wanted.length) return;

  const now = Date.now();
  const missing = wanted.filter((p) => {
    const cached = signedImageUrls.get(p);
    return !cached || cached.expiresAt < now + 60000;
  });
  if (missing.length) {
    try {
      const { data, error } = await sb.storage.from('chat-images').createSignedUrls(missing, 3600);
      if (error) throw error;
      (data || []).forEach((row) => {
        if (row.signedUrl && row.path) {
          signedImageUrls.set(row.path, { url: row.signedUrl, expiresAt: now + 3600000 });
        }
      });
      persistSignedImageCache();
    } catch (error) {
      console.error('Sign media url error:', error);
    }
  }
  mediaNodes.forEach((node) => {
    const cached = signedImageUrls.get(node.dataset.mediaPath);
    if (cached && node.src !== cached.url) node.src = cached.url;
  });
  dlNodes.forEach((node) => {
    const cached = signedImageUrls.get(node.dataset.mediaDownloadPath);
    if (cached && node.href !== cached.url) node.href = cached.url;
  });
}

// --- 複数写真まとめ送信（最大10枚・アプリ版と完全互換 payload.gallery） ---

async function sendChatImageGallery(files) {
  const list = Array.from(files || []).filter(Boolean).slice(0, APP_COMPAT_MAX_GALLERY_ITEMS);
  if (!list.length) return;
  if (list.length === 1) {
    await sendChatImage(list[0]);
    return;
  }
  if (!currentGroupId || !currentUser || uploadingImage) return;
  if (!requireCurrentRoomSend()) return;
  uploadingImage = true;
  if ($('chatImageInput')) $('chatImageInput').disabled = true;
  const groupId = currentGroupId;
  try {
    showChatToast(`写真 ${list.length} 枚を送信しています…`);
    const uploaded = [];
    for (let i = 0; i < list.length; i++) {
      let f = list[i];
      if (isHeicFile(f)) f = await normalizeImageFile(f);
      const item = await uploadChatImage(f, groupId);
      uploaded.push({ path: item.path, w: item.width, h: item.height });
    }
    const first = uploaded[0];
    const { data, error } = await sb.from('chat_messages').insert({
      group_id: groupId,
      user_id: currentUser.id,
      username: currentUser.username,
      content: `[写真 ${uploaded.length}枚]`,
      kind: 'image',
      payload: {
        v: 1,
        kind: 'image',
        image: first,
        gallery: uploaded,
      },
      is_silent: isSilentSendActive === true,
    }).select(MESSAGE_COLUMNS).single();
    if (error) throw error;
    try {
      await archiveChatImageInMediaLibrary(data.id, groupId);
    } catch (_) { /* non-fatal */ }
    lastMessages[data.group_id] = data;
    followNewMessages = true;
    if (viewHasLatest) addMessageToUI(data);
    else {
      await fillLatestGap();
      addMessageToUI(data);
    }
    renderGroups();
    dispatchPushForMessage(data.id);
  } catch (error) {
    console.error('Send gallery error:', error);
    alert(`写真のまとめ送信に失敗しました: ${error.message || error}`);
  } finally {
    uploadingImage = false;
    if ($('chatImageInput')) {
      $('chatImageInput').disabled = false;
      $('chatImageInput').value = '';
    }
  }
}

async function openGalleryViewerForMessage(messageId, startIndex = 0) {
  const msg = currentMessages.find((m) => Number(m.id) === Number(messageId));
  if (!msg) return;
  const paths = galleryPathsFromMessage(msg);
  if (!paths.length) return;
  const urls = await albumSignedUrls(paths);
  const items = paths.map((p) => ({ path: p, src: urls.get(p) || '' })).filter((x) => x.src);
  if (!items.length) return;
  const idx = Math.max(0, Math.min(items.length - 1, Number(startIndex) || 0));
  openImageViewer(items[idx].src, {
    messageId: msg.id,
    storagePath: items[idx].path,
    gallery: items,
    galleryIndex: idx,
  });
}

// --- ボイスメッセージ録音送信（最大3分・残り30秒カウントダウン・自動終了送信） ---

function pickSupportedRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch (_) {}
  }
  return '';
}

function renderVoiceRecordBar() {
  const bar = $('voiceRecordBar');
  if (!bar) return;
  if (!voiceRecorderState) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  const elapsed = Math.min(APP_COMPAT_VOICE_MAX_SECONDS, voiceRecorderState.elapsedSeconds || 0);
  const remaining = Math.max(0, APP_COMPAT_VOICE_MAX_SECONDS - elapsed);
  const pct = Math.min(100, Math.round((elapsed / APP_COMPAT_VOICE_MAX_SECONDS) * 100));
  const warn = elapsed >= APP_COMPAT_VOICE_WARN_SECONDS;
  const hint = warn
    ? `まもなく自動送信（残り ${remaining}秒 / 最大3分）`
    : '最大3分（03:00で自動終了・送信）';
  bar.classList.remove('hidden');
  bar.classList.toggle('is-warn', warn);
  bar.innerHTML = `
    <div class="voice-rec-top">
      <div class="voice-rec-status">
        <span class="voice-rec-dot" aria-hidden="true"></span>
        <div class="voice-rec-text">
          <div class="voice-rec-time">録音中 ${formatDurationPadded(elapsed)} / 03:00</div>
          <div class="voice-rec-hint">${escapeHtml(hint)}</div>
        </div>
      </div>
      <div class="voice-rec-actions">
        <button type="button" class="voice-rec-cancel" onclick="cancelVoiceRecording()">キャンセル</button>
        <button type="button" class="voice-rec-send" onclick="stopAndSendVoiceRecording()">送信</button>
      </div>
    </div>
    <div class="voice-rec-progress"><span style="width:${pct}%"></span></div>
  `;
}

async function startVoiceRecording() {
  if (!currentGroupId || !currentUser) return;
  if (!requireCurrentRoomSend()) return;
  if (voiceRecorderState) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    alert('このブラウザでは音声録音に対応していません。音声ファイルの添付またはアプリ版をご利用ください。');
    return;
  }
  closeComposerSheet();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickSupportedRecorderMime();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];
    const stateObj = {
      recorder,
      stream,
      chunks,
      mimeType: mimeType || recorder.mimeType || 'audio/webm',
      startedAt: Date.now(),
      elapsedSeconds: 0,
      cancelled: false,
      groupId: currentGroupId,
      timer: null,
    };
    voiceRecorderState = stateObj;

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    recorder.onstop = async () => {
      if (stateObj.timer) clearInterval(stateObj.timer);
      stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      const durationSec = Math.max(1, Math.min(APP_COMPAT_VOICE_MAX_SECONDS, Math.round((Date.now() - stateObj.startedAt) / 1000)));
      const wasCancelled = stateObj.cancelled;
      if (voiceRecorderState === stateObj) voiceRecorderState = null;
      renderVoiceRecordBar();
      if (wasCancelled || !chunks.length) return;
      const baseMime = String(stateObj.mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
      const ext = baseMime === 'audio/mp4' ? '.m4a' : (baseMime === 'audio/ogg' ? '.ogg' : '.webm');
      const blob = new Blob(chunks, { type: baseMime });
      await uploadAndSendVoiceBlob(blob, baseMime, ext, durationSec, stateObj.groupId);
    };

    recorder.start(500);
    renderVoiceRecordBar();
    stateObj.timer = setInterval(() => {
      if (!voiceRecorderState || voiceRecorderState !== stateObj) return;
      stateObj.elapsedSeconds = Math.floor((Date.now() - stateObj.startedAt) / 1000);
      renderVoiceRecordBar();
      if (stateObj.elapsedSeconds >= APP_COMPAT_VOICE_MAX_SECONDS) {
        showChatToast('3分の上限に達したため自動で送信します');
        stopAndSendVoiceRecording();
      }
    }, 500);
  } catch (error) {
    console.error('Voice recording start error:', error);
    alert('マイクの使用が許可されませんでした。ブラウザのマイク権限を確認してください。');
  }
}

function stopAndSendVoiceRecording() {
  if (!voiceRecorderState) return;
  const st = voiceRecorderState;
  st.cancelled = false;
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  try {
    if (st.recorder && st.recorder.state !== 'inactive') st.recorder.stop();
  } catch (error) {
    console.error('Stop recorder error:', error);
    voiceRecorderState = null;
    renderVoiceRecordBar();
  }
}

function cancelVoiceRecording() {
  if (!voiceRecorderState) return;
  const st = voiceRecorderState;
  st.cancelled = true;
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  try {
    if (st.recorder && st.recorder.state !== 'inactive') st.recorder.stop();
  } catch (_) {
    st.stream.getTracks().forEach((t) => { try { t.stop(); } catch (__) {} });
    voiceRecorderState = null;
    renderVoiceRecordBar();
  }
}

async function uploadAndSendVoiceBlob(blob, mime, ext, durationSec, groupId) {
  if (!currentUser || !groupId) return;
  try {
    showChatToast('ボイスメッセージを送信しています…');
    const fileName = `voice_${Date.now()}${ext}`;
    const path = `groups/${groupId}/${crypto.randomUUID()}${ext}`;
    const { error: uploadError } = await sb.storage.from('chat-images').upload(path, blob, {
      contentType: mime,
      cacheControl: '3600',
    });
    if (uploadError) throw uploadError;
    const { data, error } = await sb.from('chat_messages').insert({
      group_id: groupId,
      user_id: currentUser.id,
      username: currentUser.username,
      content: `🎤 ボイスメッセージ (${formatDurationMmSs(durationSec)})`,
      kind: 'file',
      payload: {
        v: 1,
        kind: 'file',
        file: { path, name: fileName, mime, size: Number(blob.size) || 0 },
        voice_memo: { duration_seconds: durationSec },
      },
      is_silent: isSilentSendActive === true,
    }).select(MESSAGE_COLUMNS).single();
    if (error) throw error;
    lastMessages[data.group_id] = data;
    followNewMessages = true;
    if (Number(currentGroupId) === Number(groupId)) {
      if (viewHasLatest) addMessageToUI(data);
      else {
        await fillLatestGap();
        addMessageToUI(data);
      }
    }
    renderGroups();
    dispatchPushForMessage(data.id);
  } catch (error) {
    console.error('Upload voice error:', error);
    alert(`ボイスメッセージの送信に失敗しました: ${error.message || error}`);
  }
}

// --- Edge Function 共通呼び出し (chat-ai-summary / chat-push) ---

async function callChatAiSummary(payload) {
  const { data: sessionData } = await sb.auth.getSession();
  const accessToken = String(sessionData?.session?.access_token || '');
  if (!accessToken) throw new Error('ログインセッションを確認できませんでした。');
  const url = `${CONFIG.supabaseUrl}/functions/v1/chat-ai-summary`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': CONFIG.supabaseKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
    cache: 'no-store',
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 429) {
      throw new Error(body.message || '短時間にAI機能の利用が集中しました。少し時間を置いてからお試しください。');
    }
    throw new Error(body.message || body.error || `AI処理に失敗しました (${resp.status})`);
  }
  return body;
}

async function transcribeVoiceMessage(messageId) {
  const mid = Number(messageId);
  const msg = currentMessages.find((m) => Number(m.id) === mid);
  const file = msg && fileFromMessage(msg);
  if (!msg || !file || !file.path || voiceTranscribingIds.has(mid)) return;
  voiceTranscribingIds.add(mid);
  refreshMessageNode(mid);
  try {
    const res = await callChatAiSummary({
      mode: 'transcribe_voice',
      group_id: Number(msg.group_id || currentGroupId),
      attachment_path: file.path,
    });
    voiceTranscriptsByMessage.set(mid, String(res.text || '（音声を認識できませんでした）'));
  } catch (error) {
    console.error('Transcribe voice error:', error);
    showChatToast(error.message || '文字起こしに失敗しました');
  } finally {
    voiceTranscribingIds.delete(mid);
    refreshMessageNode(mid);
  }
}

// --- / (／) 詳細マニュアル参照 AI 質問（自分だけに表示・相手へ送信しない） ---

function isHelpQaInputText(raw) {
  const s = String(raw || '').trimStart();
  return s.startsWith('/') || s.startsWith('／');
}

function extractHelpQaQuestion(raw) {
  const s = String(raw || '').trimStart();
  if (!s.startsWith('/') && !s.startsWith('／')) return '';
  return s.slice(1).trim();
}

function renderHelpQaCardsInTimeline() {
  const container = $('messages');
  if (!container || !currentGroupId) return;
  container.querySelectorAll('.help-qa-card').forEach((el) => el.remove());
  const cards = helpQaCardsByGroup.get(Number(currentGroupId)) || [];
  if (!cards.length) return;
  cards.forEach((card) => {
    const node = document.createElement('div');
    node.className = 'help-qa-card';
    node.dataset.helpCardId = card.id;
    const refs = (card.referenced_sections || []).map((r) => `<span class="help-qa-ref">${escapeHtml(r)}</span>`).join('');
    const followups = (card.suggested_followups || []).map((q) => `<button type="button" class="help-qa-followup" data-help-followup="${escapeHtml(q)}">/${escapeHtml(q)}</button>`).join('');
    node.innerHTML = `
      <div class="help-qa-head">
        <span class="help-qa-badge">📖 使い方ガイド（自分だけに表示）</span>
        <button type="button" class="help-qa-close" data-help-close="${escapeHtml(card.id)}" aria-label="閉じる">✕</button>
      </div>
      <div class="help-qa-question">Q. ${escapeHtml(card.question)}</div>
      <div class="help-qa-answer">${card.loading ? 'マニュアルを参照して回答を作成しています…' : escapeHtml(card.answer || '')}</div>
      ${refs ? `<div class="help-qa-refs">${refs}</div>` : ''}
      ${followups ? `<div class="help-qa-followups">${followups}</div>` : ''}
      ${!card.loading && card.answer ? `<div class="help-qa-footer"><button type="button" class="help-qa-copy" data-help-copy="${escapeHtml(card.id)}">回答をコピー</button></div>` : ''}
    `;
    container.appendChild(node);
  });
}

async function submitHelpQaFromComposer(rawContent) {
  const groupId = Number(currentGroupId);
  if (!groupId || !currentUser) return false;
  const question = extractHelpQaQuestion(rawContent);
  if (!question) {
    showChatToast('「/ ボイスメッセージの送り方」のように / のあとに質問を入力してください');
    return false;
  }
  const cardId = `help-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const cards = (helpQaCardsByGroup.get(groupId) || []).slice(-4);
  const entry = {
    id: cardId,
    question,
    loading: true,
    answer: '',
    referenced_sections: [],
    suggested_followups: [],
  };
  cards.push(entry);
  helpQaCardsByGroup.set(groupId, cards);
  renderHelpQaCardsInTimeline();
  scrollMessagesToBottom();

  const history = (helpQaHistoryByGroup.get(groupId) || []).slice(-6);
  try {
    const res = await callChatAiSummary({
      mode: 'help_qa',
      question,
      history,
    });
    entry.loading = false;
    entry.answer = String(res.answer || '回答を取得できませんでした。');
    entry.referenced_sections = Array.isArray(res.referenced_sections) ? res.referenced_sections : [];
    entry.suggested_followups = Array.isArray(res.suggested_followups) ? res.suggested_followups : [];
    const nextHist = history.concat([
      { role: 'user', content: question },
      { role: 'assistant', content: entry.answer.slice(0, 800) },
    ]).slice(-6);
    helpQaHistoryByGroup.set(groupId, nextHist);
  } catch (error) {
    entry.loading = false;
    entry.answer = `エラー: ${error.message || '回答を取得できませんでした。'}`;
  }
  if (Number(currentGroupId) === groupId) {
    renderHelpQaCardsInTimeline();
    scrollMessagesToBottom();
  }
  return true;
}

// --- 汎用モーダルヘルパー ---

function openAppCompatModal(title, bodyHtml, options = {}) {
  const overlay = $('appCompatOverlay');
  const titleEl = $('appCompatModalTitle');
  const bodyEl = $('appCompatModalBody');
  if (!overlay || !titleEl || !bodyEl) return null;
  if (appCompatActiveModalCleanup) {
    try { appCompatActiveModalCleanup(); } catch (_) {}
    appCompatActiveModalCleanup = null;
  }
  titleEl.textContent = title || '';
  bodyEl.innerHTML = bodyHtml || '';
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  if (typeof options.onCleanup === 'function') appCompatActiveModalCleanup = options.onCleanup;
  return bodyEl;
}

function closeAppCompatModal() {
  const overlay = $('appCompatOverlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
  if (appCompatActiveModalCleanup) {
    try { appCompatActiveModalCleanup(); } catch (_) {}
    appCompatActiveModalCleanup = null;
  }
}

async function copyAppCompatText(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    showChatToast('コピーしました');
  } catch (_) {
    prompt('コピーしてください', String(text || ''));
  }
}

async function saveTextAsPrivateNoteInCurrentRoom(text) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean || !currentGroupId || !currentUser) return;
  try {
    const { data, error } = await sb.from('chat_private_notes').insert({
      group_id: currentGroupId,
      user_id: currentUser.id,
      content: clean,
    }).select('id,group_id,user_id,content,created_at').single();
    if (error) throw error;
    handleIncomingNote(data);
    showChatToast('このトークの個人メモへ保存しました');
  } catch (error) {
    console.error('Save private note from AI error:', error);
    alert(`個人メモの保存に失敗しました: ${error.message || error}`);
  }
}

// --- インタラクティブカード作成モーダル（確認依頼・チェックリスト・投票） ---

function openInteractiveComposerModal(kind) {
  if (!currentGroupId || !currentUser) return;
  if (!requireCurrentRoomSend()) return;
  closeComposerSheet();

  if (kind === 'ack') {
    const body = openAppCompatModal('確認依頼を作成', `
      <p class="schedule-hint">メンバーに「確認しました」を押してもらえる依頼カードを送ります。未確認者への再通知もできます。</p>
      <label class="compat-field"><span>タイトル（必須）</span><input id="compatAckTitle" maxlength="80" placeholder="例：明日の仕込み変更について"></label>
      <label class="compat-field"><span>詳細・内容（任意）</span><textarea id="compatAckBody" rows="4" maxlength="1000" placeholder="確認してほしい詳細を記入"></textarea></label>
      <label class="compat-check"><input type="checkbox" id="compatAckUrgent"><span>重要・至急として強調表示する</span></label>
      <div class="compat-actions">
        <button type="button" class="invite-close" onclick="closeAppCompatModal()">キャンセル</button>
        <button type="button" class="send-mode-now" id="compatAckSubmit">確認依頼を送信</button>
      </div>
    `);
    body?.querySelector('#compatAckSubmit')?.addEventListener('click', async () => {
      const title = String($('compatAckTitle')?.value || '').trim();
      const detail = String($('compatAckBody')?.value || '').trim();
      const urgent = $('compatAckUrgent')?.checked === true;
      if (!title) { alert('タイトルを入力してください'); return; }
      const prefix = urgent ? '【重要・要確認】' : '【申し送り・要確認】';
      const fallback = detail ? `${prefix}${title}\n${detail}` : `${prefix}${title}`;
      await sendInteractiveMessage(fallback, { v: 1, ack_request: { title, body: detail, urgent } });
    });
    $('compatAckTitle')?.focus();
    return;
  }

  if (kind === 'checklist') {
    const body = openAppCompatModal('共有チェックリストを作成', `
      <p class="schedule-hint">トーク参加者全員でリアルタイムにチェックを入れ合えるリストを作成します。</p>
      <label class="compat-field"><span>タイトル（必須）</span><input id="compatClTitle" maxlength="80" placeholder="例：閉店作業チェック"></label>
      <label class="compat-field"><span>項目（1行に1項目・最大20件）</span><textarea id="compatClItems" rows="6" placeholder="レジ締め\nガス元栓の確認\n冷蔵庫温度チェック"></textarea></label>
      <div class="compat-actions">
        <button type="button" class="invite-close" onclick="closeAppCompatModal()">キャンセル</button>
        <button type="button" class="send-mode-now" id="compatClSubmit">チェックリストを送信</button>
      </div>
    `);
    body?.querySelector('#compatClSubmit')?.addEventListener('click', async () => {
      const title = String($('compatClTitle')?.value || '').trim();
      const lines = String($('compatClItems')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (!title) { alert('タイトルを入力してください'); return; }
      if (!lines.length) { alert('項目を1つ以上入力してください'); return; }
      const items = lines.map((text, idx) => ({ id: `i${idx + 1}`, text }));
      const fallback = `【チェックリスト】${title}\n${items.map((it) => `・${it.text}`).join('\n')}`;
      await sendInteractiveMessage(fallback, { v: 1, checklist: { title, items } });
    });
    $('compatClTitle')?.focus();
    return;
  }

  if (kind === 'poll') {
    const body = openAppCompatModal('投票を作成', `
      <p class="schedule-hint">メンバーからリアルタイムで回答を集計できる投票カードを送ります。</p>
      <label class="compat-field"><span>質問（必須）</span><input id="compatPollQuestion" maxlength="120" placeholder="例：来週のミーティング希望日時は？"></label>
      <label class="compat-field"><span>選択肢（1行に1つ・2〜10個）</span><textarea id="compatPollOptions" rows="5" placeholder="火曜 15:00\n水曜 15:00\n木曜 16:00"></textarea></label>
      <label class="compat-check"><input type="checkbox" id="compatPollMultiple"><span>複数選択を許可する</span></label>
      <label class="compat-check"><input type="checkbox" id="compatPollAnonymous"><span>匿名投票にする</span></label>
      <div class="compat-actions">
        <button type="button" class="invite-close" onclick="closeAppCompatModal()">キャンセル</button>
        <button type="button" class="send-mode-now" id="compatPollSubmit">投票を送信</button>
      </div>
    `);
    body?.querySelector('#compatPollSubmit')?.addEventListener('click', async () => {
      const question = String($('compatPollQuestion')?.value || '').trim();
      const lines = String($('compatPollOptions')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
      if (!question) { alert('質問を入力してください'); return; }
      if (lines.length < 2) { alert('選択肢を2つ以上入力してください'); return; }
      const multiple = $('compatPollMultiple')?.checked === true;
      const anonymous = $('compatPollAnonymous')?.checked === true;
      const options = lines.map((label, idx) => ({ id: `o${idx + 1}`, label }));
      const fallback = `【投票】${question}\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`;
      await sendInteractiveMessage(fallback, { v: 1, poll: { question, multiple, anonymous, options } });
    });
    $('compatPollQuestion')?.focus();
  }
}

async function sendInteractiveMessage(content, payload) {
  if (!currentGroupId || !currentUser || !requireCurrentRoomSend()) return;
  try {
    const { data, error } = await sb.from('chat_messages').insert({
      group_id: currentGroupId,
      user_id: currentUser.id,
      username: currentUser.username,
      content,
      kind: 'text',
      payload,
      is_silent: isSilentSendActive === true,
    }).select(MESSAGE_COLUMNS).single();
    if (error) throw error;
    interactionsByMessage.set(Number(data.id), []);
    closeAppCompatModal();
    lastMessages[data.group_id] = data;
    followNewMessages = true;
    if (viewHasLatest) addMessageToUI(data);
    else {
      await fillLatestGap();
      addMessageToUI(data);
    }
    renderGroups();
    dispatchPushForMessage(data.id);
  } catch (error) {
    console.error('Send interactive message error:', error);
    alert(`送信に失敗しました: ${error.message || error}`);
  }
}

// --- AI 機能モーダル群 ---

function openRoomAiSummaryModal() {
  if (!currentGroupId || !currentUser) return;
  closeComposerSheet();
  const group = currentGroup();
  const body = openAppCompatModal(`AI要約 — ${roomTitle(group)}`, `
    <p class="schedule-hint">このトークの履歴をAIで要約し、要点・決定事項・ToDoに整理します（他の人には送信されません）。</p>
    <div class="compat-grid-2">
      <label class="compat-field"><span>対象期間</span>
        <select id="compatSumRange">
          <option value="recent50">直近50件</option>
          <option value="today">今日</option>
          <option value="3days">直近3日間</option>
          <option value="7days">直近7日間</option>
          <option value="recent200">直近200件</option>
        </select>
      </label>
      <label class="compat-field"><span>注目キーワード（任意）</span>
        <input id="compatSumKeyword" maxlength="100" placeholder="例：予約、仕入れ">
      </label>
    </div>
    <div class="compat-actions">
      <button type="button" class="send-mode-now" id="compatSumRun">AI要約を実行</button>
    </div>
    <div id="compatSumOutput" class="compat-result hidden"></div>
  `);
  body?.querySelector('#compatSumRun')?.addEventListener('click', async () => {
    const btn = $('compatSumRun');
    const out = $('compatSumOutput');
    if (!btn || !out) return;
    const range = $('compatSumRange')?.value || 'recent50';
    const keyword = String($('compatSumKeyword')?.value || '').trim();
    const payload = { mode: 'room', group_id: Number(currentGroupId) };
    if (keyword) payload.focus_keyword = keyword;
    const now = new Date();
    if (range === 'today') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      payload.since_iso = start.toISOString();
      payload.limit = 200;
    } else if (range === '3days') {
      payload.since_iso = new Date(now.getTime() - 3 * 86400000).toISOString();
      payload.limit = 200;
    } else if (range === '7days') {
      payload.since_iso = new Date(now.getTime() - 7 * 86400000).toISOString();
      payload.limit = 200;
    } else if (range === 'recent200') {
      payload.limit = 200;
    } else {
      payload.limit = 50;
    }
    btn.disabled = true;
    btn.textContent = '要約を作成中…';
    out.classList.remove('hidden');
    out.innerHTML = '<div class="compat-loading">AIがトーク履歴を読み込んでいます…</div>';
    try {
      const res = await callChatAiSummary(payload);
      const summary = String(res.summary || '');
      out.innerHTML = `
        <div class="compat-result-meta">対象 ${Number(res.message_count || 0)}件${res.focus_keyword ? ` ・ 語句「${escapeHtml(res.focus_keyword)}」` : ''}</div>
        <pre class="compat-pre">${escapeHtml(summary)}</pre>
        <div class="compat-actions">
          <button type="button" class="invite-close" id="compatSumCopy">コピー</button>
          <button type="button" class="send-mode-now" id="compatSumSaveNote">個人メモに保存</button>
        </div>
      `;
      out.querySelector('#compatSumCopy')?.addEventListener('click', () => copyAppCompatText(summary));
      out.querySelector('#compatSumSaveNote')?.addEventListener('click', () => saveTextAsPrivateNoteInCurrentRoom(`【AI要約】\n${summary}`));
    } catch (error) {
      out.innerHTML = `<div class="compat-error">${escapeHtml(error.message || '要約に失敗しました')}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'AI要約を実行';
    }
  });
}

async function openUnreadDigestModal() {
  if (!currentUser) return;
  closeComposerSheet();
  closeAccountMenu();
  const unreadRooms = (myGroups || [])
    .filter((g) => !g.trashed_at && Number(unread[g.id] || 0) > 0)
    .sort((a, b) => Number(unread[b.id] || 0) - Number(unread[a.id] || 0))
    .slice(0, 12)
    .map((g) => ({
      group_id: Number(g.id),
      unread_count: Number(unread[g.id] || 1),
      room_name: roomTitle(g),
    }));

  const body = openAppCompatModal('未読の一括 AI まとめ', unreadRooms.length
    ? '<div class="compat-loading">未読メッセージをAIで整理しています…</div>'
    : '<p class="schedule-hint">現在、未読メッセージのあるトークはありません。</p><div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>');
  if (!unreadRooms.length || !body) return;

  try {
    const res = await callChatAiSummary({ mode: 'unread_digest', rooms: unreadRooms });
    const rooms = Array.isArray(res.rooms) ? res.rooms : [];
    const cardsHtml = rooms.map((r) => {
      const prioBadge = r.priority === 'high'
        ? '<span class="compat-pill danger">至急</span>'
        : (r.action_required ? '<span class="compat-pill warn">要対応</span>' : '<span class="compat-pill">確認</span>');
      return `<div class="compat-digest-card">
        <div class="compat-digest-head">
          <strong>${escapeHtml(r.room_name || '')}</strong>
          <span>${prioBadge} <span class="compat-pill">未読 ${Number(r.unread_count || 0)}件</span></span>
        </div>
        <pre class="compat-pre">${escapeHtml(r.summary || '')}</pre>
        <button type="button" class="compat-link-btn" data-jump-room="${Number(r.group_id)}">このトークを開く →</button>
      </div>`;
    }).join('');
    body.innerHTML = `
      <div class="compat-digest-overview">${escapeHtml(res.overview || '未読をまとめました。')}</div>
      <div class="compat-digest-list">${cardsHtml || '<p class="schedule-hint">要約対象がありませんでした。</p>'}</div>
      <div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>
    `;
    body.querySelectorAll('[data-jump-room]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const gid = Number(btn.dataset.jumpRoom);
        const group = findMineGroup(gid);
        closeAppCompatModal();
        if (group) selectGroup(group);
      });
    });
  } catch (error) {
    body.innerHTML = `<div class="compat-error">${escapeHtml(error.message || '未読まとめの作成に失敗しました')}</div>
      <div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>`;
  }
}

function openTranslateMessageModal(msg) {
  if (!msg) return;
  const text = String(msg.content || '').trim();
  if (!text) return;
  const opts = APP_COMPAT_TRANSLATE_LANGS.map((l) => `<button type="button" class="compat-lang-btn" data-lang="${l.code}">${escapeHtml(l.label)}</button>`).join('');
  const body = openAppCompatModal('メッセージを翻訳', `
    <p class="schedule-hint">翻訳先の言語を選んでください。結果は吹き出しの下に表示されます。</p>
    <div class="compat-lang-grid">${opts}</div>
  `);
  body?.querySelectorAll('[data-lang]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.dataset.lang;
      const langObj = APP_COMPAT_TRANSLATE_LANGS.find((l) => l.code === code);
      closeAppCompatModal();
      showChatToast(`${langObj ? langObj.label : code}へ翻訳しています…`);
      try {
        const res = await callChatAiSummary({ mode: 'translate', text, target_lang: code });
        inlineTranslationsByMessage.set(Number(msg.id), {
          targetLang: code,
          langLabel: langObj ? langObj.label : code,
          text: String(res.translated_text || ''),
        });
        refreshMessageNode(msg.id);
      } catch (error) {
        showChatToast(error.message || '翻訳に失敗しました');
      }
    });
  });
}

function openPreSendTranslateModal() {
  if (!currentGroupId || !currentUser) return;
  closeComposerSheet();
  const initialText = String($('messageInput')?.value || '').trim();
  const opts = APP_COMPAT_TRANSLATE_LANGS.map((l) => `<option value="${l.code}"${l.code === 'en' ? ' selected' : ''}>${escapeHtml(l.label)}</option>`).join('');
  const body = openAppCompatModal('送信前翻訳', `
    <p class="schedule-hint">文章を翻訳して確認してから入力欄へ反映できます。</p>
    <label class="compat-field"><span>元の文章</span><textarea id="compatTrInput" rows="3" maxlength="3000" placeholder="翻訳したい文章を入力">${escapeHtml(initialText)}</textarea></label>
    <label class="compat-field"><span>翻訳先言語</span><select id="compatTrLang">${opts}</select></label>
    <div class="compat-actions">
      <button type="button" class="send-mode-now" id="compatTrRun">翻訳する</button>
    </div>
    <div id="compatTrOutput" class="compat-result hidden"></div>
  `);
  body?.querySelector('#compatTrRun')?.addEventListener('click', async () => {
    const src = String($('compatTrInput')?.value || '').trim();
    const lang = $('compatTrLang')?.value || 'en';
    if (!src) { alert('文章を入力してください'); return; }
    const btn = $('compatTrRun');
    const out = $('compatTrOutput');
    btn.disabled = true;
    btn.textContent = '翻訳中…';
    out.classList.remove('hidden');
    out.innerHTML = '<div class="compat-loading">翻訳しています…</div>';
    try {
      const res = await callChatAiSummary({ mode: 'translate', text: src, target_lang: lang });
      const translated = String(res.translated_text || '');
      out.innerHTML = `
        <pre class="compat-pre">${escapeHtml(translated)}</pre>
        <div class="compat-actions">
          <button type="button" class="invite-close" id="compatTrCopy">コピー</button>
          <button type="button" class="send-mode-now" id="compatTrApply">入力欄にセット</button>
        </div>
      `;
      out.querySelector('#compatTrCopy')?.addEventListener('click', () => copyAppCompatText(translated));
      out.querySelector('#compatTrApply')?.addEventListener('click', () => {
        const input = $('messageInput');
        if (input) {
          input.value = translated;
          resizeComposer();
          syncComposerModeUi();
          input.focus();
        }
        closeAppCompatModal();
      });
    } catch (error) {
      out.innerHTML = `<div class="compat-error">${escapeHtml(error.message || '翻訳に失敗しました')}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '翻訳する';
    }
  });
}

async function openReplySuggestModal(msg) {
  if (!msg || !currentGroupId) return;
  const targetText = String(msg.content || '').trim();
  if (!targetText) return;
  const idx = currentMessages.findIndex((m) => Number(m.id) === Number(msg.id));
  const ctxSlice = idx >= 0 ? currentMessages.slice(Math.max(0, idx - 6), idx) : [];
  const contextLines = ctxSlice
    .filter((m) => (m.kind || 'text') === 'text' && String(m.content || '').trim())
    .map((m) => `${speakerName(m.user_id, m.username)}: ${String(m.content || '').trim().slice(0, 240)}`);

  const body = openAppCompatModal('AI返信案', '<div class="compat-loading">返信案（丁寧・簡潔・確認）を作成しています…</div>');
  if (!body) return;
  try {
    const res = await callChatAiSummary({
      mode: 'reply_suggest',
      group_id: Number(currentGroupId),
      target_text: targetText,
      sender_name: speakerName(msg.user_id, msg.username),
      context_lines: contextLines,
    });
    const list = Array.isArray(res.suggestions) ? res.suggestions : [];
    body.innerHTML = `
      <p class="schedule-hint">タップすると入力欄へ挿入されます（そのまま編集してから送信できます）。</p>
      <div class="compat-suggest-list">
        ${list.map((s, i) => `
          <button type="button" class="compat-suggest-item" data-suggest-idx="${i}">
            <span class="compat-pill">${escapeHtml(s.tone || '返信案')}</span>
            <span class="compat-suggest-text">${escapeHtml(s.text || '')}</span>
          </button>
        `).join('')}
      </div>
      <div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>
    `;
    body.querySelectorAll('[data-suggest-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const picked = list[Number(btn.dataset.suggestIdx)];
        if (picked && picked.text) {
          setReplyTarget(msg);
          const input = $('messageInput');
          if (input) {
            input.value = picked.text;
            resizeComposer();
            syncComposerModeUi();
            input.focus();
          }
        }
        closeAppCompatModal();
      });
    });
  } catch (error) {
    body.innerHTML = `<div class="compat-error">${escapeHtml(error.message || '返信案の作成に失敗しました')}</div>
      <div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>`;
  }
}

async function openExtractTasksModal(msg) {
  if (!msg) return;
  const text = String(msg.content || '').trim();
  if (!text) return;
  const body = openAppCompatModal('予定・タスク抽出', '<div class="compat-loading">本文から予定・ToDo候補を抽出しています…</div>');
  if (!body) return;
  try {
    const res = await callChatAiSummary({
      mode: 'extract_tasks',
      text,
      room_name: roomTitle(currentGroup()),
    });
    const items = Array.isArray(res.items) ? res.items : [];
    if (!items.length) {
      body.innerHTML = '<p class="schedule-hint">抽出できる予定・タスク候補は見つかりませんでした。</p><div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>';
      return;
    }
    const formatItemText = (it) => {
      const due = it.due_iso ? `（${new Date(it.due_iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）` : '';
      return `${it.kind === 'event' ? '📅' : '⏰'} ${it.title}${due}${it.note ? `\n${it.note}` : ''}`;
    };
    body.innerHTML = `
      <div class="compat-task-list">
        ${items.map((it, i) => `
          <div class="compat-task-item">
            <div class="compat-task-head">
              <span class="compat-pill">${it.kind === 'event' ? '📅 予定' : '⏰ タスク'}</span>
              <strong>${escapeHtml(it.title || '')}</strong>
            </div>
            ${it.due_iso ? `<div class="compat-task-due">日時: ${escapeHtml(new Date(it.due_iso).toLocaleString('ja-JP'))}</div>` : ''}
            ${it.note ? `<div class="compat-task-note">${escapeHtml(it.note)}</div>` : ''}
            <div class="compat-task-btns">
              <button type="button" class="compat-link-btn" data-task-note="${i}">個人メモへ保存</button>
              <button type="button" class="compat-link-btn" data-task-copy="${i}">コピー</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>
    `;
    body.querySelectorAll('[data-task-note]').forEach((btn) => {
      btn.addEventListener('click', () => saveTextAsPrivateNoteInCurrentRoom(formatItemText(items[Number(btn.dataset.taskNote)])));
    });
    body.querySelectorAll('[data-task-copy]').forEach((btn) => {
      btn.addEventListener('click', () => copyAppCompatText(formatItemText(items[Number(btn.dataset.taskCopy)])));
    });
  } catch (error) {
    body.innerHTML = `<div class="compat-error">${escapeHtml(error.message || '予定の抽出に失敗しました')}</div>
      <div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>`;
  }
}

async function openAnalyzeAttachmentModal(msg) {
  if (!msg || !currentGroupId) return;
  let path = '';
  let fileName = '';
  if (msg.kind === 'image') {
    const img = imageFromMessage(msg);
    const gallery = galleryPathsFromMessage(msg);
    path = (img && img.path) || gallery[0] || '';
    fileName = 'image.jpg';
  } else {
    const file = fileFromMessage(msg);
    path = (file && file.path) || '';
    fileName = (file && file.name) || '';
  }
  if (!path) return;

  const body = openAppCompatModal('AI 書類・画像読み取り', '<div class="compat-loading">AIが画像・資料を読み取って要約しています…</div>');
  if (!body) return;
  try {
    const res = await callChatAiSummary({
      mode: 'analyze_attachment',
      group_id: Number(msg.group_id || currentGroupId),
      attachment_path: path,
      file_name: fileName,
    });
    const facts = Array.isArray(res.key_facts) ? res.key_facts : [];
    const summary = String(res.summary || '');
    const extracted = String(res.extracted_text || '');
    const combined = `【${res.doc_type || '添付資料'}】\n${summary}${facts.length ? `\n\n■ 重要項目\n${facts.map((f) => `・${f}`).join('\n')}` : ''}`;
    body.innerHTML = `
      <div class="compat-result-meta"><span class="compat-pill">${escapeHtml(res.doc_type || '添付資料')}</span></div>
      <div class="compat-section-label">要約</div>
      <pre class="compat-pre">${escapeHtml(summary)}</pre>
      ${facts.length ? `<div class="compat-section-label">重要項目</div><ul class="compat-facts">${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : ''}
      ${extracted ? `<details class="compat-details"><summary>読み取り全文を表示</summary><pre class="compat-pre">${escapeHtml(extracted)}</pre></details>` : ''}
      <div class="compat-actions">
        <button type="button" class="invite-close" id="compatOcrCopy">要約をコピー</button>
        <button type="button" class="send-mode-now" id="compatOcrSaveNote">個人メモに保存</button>
      </div>
    `;
    body.querySelector('#compatOcrCopy')?.addEventListener('click', () => copyAppCompatText(combined));
    body.querySelector('#compatOcrSaveNote')?.addEventListener('click', () => saveTextAsPrivateNoteInCurrentRoom(combined));
  } catch (error) {
    body.innerHTML = `<div class="compat-error">${escapeHtml(error.message || '読み取りに失敗しました')}</div>
      <div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>`;
  }
}

// --- 通知のおやすみ時間設定（chat-push?action=preferences 同期） ---

function minutesToTimeInput(min) {
  const safe = Math.max(0, Math.min(1439, Number(min) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function timeInputToMinutes(val, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(val || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return fallback;
  return h * 60 + mi;
}

async function openQuietHoursModal() {
  if (!currentUser) return;
  closeAccountMenu();
  const body = openAppCompatModal('通知のおやすみ時間', '<div class="compat-loading">設定を読み込んでいます…</div>');
  if (!body) return;
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const accessToken = String(sessionData?.session?.access_token || '');
    if (!accessToken) throw new Error('ログインセッションを確認できませんでした。');
    const url = `${CONFIG.supabaseUrl}/functions/v1/chat-push?action=preferences`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': CONFIG.supabaseKey },
      cache: 'no-store',
    });
    const pref = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(pref.error || '設定の読み込みに失敗しました');

    const enabled = pref.quiet_hours_enabled === true;
    const startMin = Number.isFinite(Number(pref.quiet_start_minute)) ? Number(pref.quiet_start_minute) : 23 * 60;
    const endMin = Number.isFinite(Number(pref.quiet_end_minute)) ? Number(pref.quiet_end_minute) : 8 * 60;
    const allowMentions = pref.quiet_allow_mentions !== false;
    const days = Array.isArray(pref.quiet_days) ? pref.quiet_days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    const daySet = new Set(days);

    body.innerHTML = `
      <p class="schedule-hint">指定した時間帯はプッシュ通知を自動停止します。設定は iPhone / Android アプリ版とも共通で同期されます。</p>
      <label class="compat-check"><input type="checkbox" id="compatQuietEnabled"${enabled ? ' checked' : ''}><span>おやすみ時間を有効にする</span></label>
      <div class="compat-grid-2">
        <label class="compat-field"><span>開始時刻</span><input type="time" id="compatQuietStart" value="${minutesToTimeInput(startMin)}"></label>
        <label class="compat-field"><span>終了時刻</span><input type="time" id="compatQuietEnd" value="${minutesToTimeInput(endMin)}"></label>
      </div>
      <div class="compat-field">
        <span>適用する曜日</span>
        <div class="compat-day-chips">
          ${APP_COMPAT_WEEKDAYS.map((w) => `<label class="compat-day-chip"><input type="checkbox" data-quiet-day="${w.day}"${daySet.has(w.day) ? ' checked' : ''}><span>${w.label}</span></label>`).join('')}
        </div>
      </div>
      <label class="compat-check"><input type="checkbox" id="compatQuietMentions"${allowMentions ? ' checked' : ''}><span>自分宛ての @メンション は通知する</span></label>
      <div class="compat-actions">
        <button type="button" class="invite-close" onclick="closeAppCompatModal()">キャンセル</button>
        <button type="button" class="send-mode-now" id="compatQuietSave">保存する</button>
      </div>
    `;
    body.querySelector('#compatQuietSave')?.addEventListener('click', async () => {
      const saveBtn = $('compatQuietSave');
      const nextDays = Array.from(body.querySelectorAll('[data-quiet-day]:checked')).map((el) => Number(el.dataset.quietDay));
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      try {
        const saveResp = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'apikey': CONFIG.supabaseKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            quiet_hours_enabled: $('compatQuietEnabled')?.checked === true,
            quiet_start_minute: timeInputToMinutes($('compatQuietStart')?.value, 23 * 60),
            quiet_end_minute: timeInputToMinutes($('compatQuietEnd')?.value, 8 * 60),
            quiet_allow_mentions: $('compatQuietMentions')?.checked !== false,
            quiet_days: nextDays,
          }),
          cache: 'no-store',
        });
        const saveRes = await saveResp.json().catch(() => ({}));
        if (!saveResp.ok) throw new Error(saveRes.error || '保存に失敗しました');
        closeAppCompatModal();
        showChatToast('おやすみ時間設定を保存しました（アプリ版と同期）');
      } catch (err) {
        alert(err.message || '保存に失敗しました');
        saveBtn.disabled = false;
        saveBtn.textContent = '保存する';
      }
    });
  } catch (error) {
    body.innerHTML = `<div class="compat-error">${escapeHtml(error.message || '読み込みに失敗しました')}</div>
      <div class="compat-actions"><button type="button" class="invite-close" onclick="closeAppCompatModal()">閉じる</button></div>`;
  }
}

// --- メッセージメニューへ AI 操作を追加 ---

function appendAppCompatMessageMenuActions(menu, msg) {
  if (!menu || !msg) return;
  const actionsWrap = menu.querySelector('.msg-menu-actions');
  if (!actionsWrap) return;
  const hasText = (msg.kind || 'text') === 'text' && String(msg.content || '').trim().length > 0 && !callLogFromMessage(msg);
  const canOcr = isAiAnalyzableAttachmentMessage(msg);
  const canVoice = !!voiceMemoFromMessage(msg);
  const items = [];
  if (hasText) {
    items.push({ action: 'ai-translate', icon: '🌐', label: '翻訳' });
    if (canCurrentUserSend()) items.push({ action: 'ai-reply', icon: '✨', label: 'AI返信案' });
    items.push({ action: 'ai-tasks', icon: '📅', label: '予定抽出' });
  }
  if (canOcr) {
    items.push({ action: 'ai-ocr', icon: '🔍', label: 'AIで読み取る' });
  }
  if (canVoice) {
    items.push({ action: 'ai-voice', icon: '📝', label: '文字で見る' });
  }
  if (!items.length) return;
  items.forEach((it) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-menu-reply';
    btn.dataset.action = it.action;
    btn.innerHTML = `<span class="msg-menu-action-icon">${it.icon}</span><span>${it.label}</span>`;
    actionsWrap.appendChild(btn);
  });
}

function handleAppCompatMessageMenuAction(action, msg) {
  if (action === 'ai-translate') { openTranslateMessageModal(msg); return true; }
  if (action === 'ai-reply') { openReplySuggestModal(msg); return true; }
  if (action === 'ai-tasks') { openExtractTasksModal(msg); return true; }
  if (action === 'ai-ocr') { openAnalyzeAttachmentModal(msg); return true; }
  if (action === 'ai-voice') { transcribeVoiceMessage(msg.id); return true; }
  return false;
}

// --- タイムライン内のアプリ連携クリックイベント委譲 ---

document.addEventListener('DOMContentLoaded', () => {
  const messagesEl = $('messages');
  if (!messagesEl) return;
  messagesEl.addEventListener('click', (e) => {
    if (!e.target || !e.target.closest) return;

    const galleryTile = e.target.closest('[data-gallery-open]');
    if (galleryTile) {
      e.stopPropagation();
      openGalleryViewerForMessage(Number(galleryTile.dataset.galleryOpen), Number(galleryTile.dataset.galleryIndex || 0));
      return;
    }

    const ackBtn = e.target.closest('[data-ack-toggle]');
    if (ackBtn) { toggleAckConfirmation(Number(ackBtn.dataset.ackToggle)); return; }

    const remindBtn = e.target.closest('[data-ack-remind]');
    if (remindBtn) { remindUnackedMembers(Number(remindBtn.dataset.ackRemind)); return; }

    const clBtn = e.target.closest('[data-checklist-toggle]');
    if (clBtn) { toggleChecklistItem(Number(clBtn.dataset.checklistToggle), clBtn.dataset.itemId); return; }

    const pollBtn = e.target.closest('[data-poll-vote]');
    if (pollBtn) {
      togglePollVote(Number(pollBtn.dataset.pollVote), pollBtn.dataset.optionId, pollBtn.dataset.pollMultiple === '1');
      return;
    }

    const voiceBtn = e.target.closest('[data-transcribe-voice]');
    if (voiceBtn) { transcribeVoiceMessage(Number(voiceBtn.dataset.transcribeVoice)); return; }

    const closeTrBtn = e.target.closest('[data-close-translation]');
    if (closeTrBtn) {
      inlineTranslationsByMessage.delete(Number(closeTrBtn.dataset.closeTranslation));
      refreshMessageNode(Number(closeTrBtn.dataset.closeTranslation));
      return;
    }

    const helpClose = e.target.closest('[data-help-close]');
    if (helpClose) {
      const gid = Number(currentGroupId);
      const id = helpClose.dataset.helpClose;
      const list = (helpQaCardsByGroup.get(gid) || []).filter((c) => c.id !== id);
      helpQaCardsByGroup.set(gid, list);
      renderHelpQaCardsInTimeline();
      return;
    }

    const helpCopy = e.target.closest('[data-help-copy]');
    if (helpCopy) {
      const gid = Number(currentGroupId);
      const card = (helpQaCardsByGroup.get(gid) || []).find((c) => c.id === helpCopy.dataset.helpCopy);
      if (card && card.answer) copyAppCompatText(card.answer);
      return;
    }

    const helpFollow = e.target.closest('[data-help-followup]');
    if (helpFollow) {
      const q = helpFollow.dataset.helpFollowup;
      if (q) submitHelpQaFromComposer(`/${q}`);
    }
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAppCompatModal();
});
