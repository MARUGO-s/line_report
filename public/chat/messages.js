'use strict';

// --- 参加者 / 既読 / リアクション / 引用元の読み込み ---

async function loadGroupContext(groupId) {
  groupMembers = [];
  groupReadStates = [];
  try {
    const [memberRes, readRes] = await Promise.all([
      sb.from('chat_group_members')
        .select('user_id, can_view, can_send, can_invite, can_manage, chat_users(id, username, icon_url, is_bot, store_key)')
        .eq('group_id', groupId),
      sb.from('chat_read_states')
        .select('user_id, last_read_at')
        .eq('group_id', groupId)
    ]);
    if (memberRes.error) throw memberRes.error;
    if (readRes.error) throw readRes.error;
    const memberRows = memberRes.data || [];
    groupMembers = memberRows.filter((row) => row.can_view === true).map((row) => row.chat_users).filter(Boolean);
    const mine = memberRows.find((row) => String(row.user_id) === String(currentUser.id)) || null;
    if (Number(groupId) === Number(currentGroupId)) {
      currentRoomMembership = mine;
      const group = currentGroup();
      if (group && mine) group.membership = {
        user_id: mine.user_id,
        group_id: Number(groupId),
        can_view: mine.can_view === true,
        can_send: mine.can_send === true,
        can_invite: mine.can_invite === true,
        can_manage: mine.can_manage === true
      };
      syncComposerForGroup(group);
    }
    groupReadStates = readRes.data || [];
  } catch (error) {
    console.error('Load group context error:', error);
  }
  updateChatHeaderMeta();
}

// 個人メモを取得する。RLSで本人の分しか返らない。件数が変わったときだけ描き直す。
async function loadPrivateNotes(groupId, seq) {
  try {
    const { data, error } = await sb
      .from('chat_private_notes')
      .select('id, group_id, content, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (seq !== selectGroupSeq || Number(currentGroupId) !== Number(groupId)) return;
    const next = data || [];
    const changed = JSON.stringify(currentPrivateNotes) !== JSON.stringify(next);
    currentPrivateNotes = next;
    if (changed) renderMessageList();
  } catch (error) {
    console.error('Load private notes error:', error);
  }
}

async function loadReactions(messageIds) {
  const ids = messageIds.filter((id) => !reactionsByMessage.has(id));
  if (!ids.length) return;
  ids.forEach((id) => reactionsByMessage.set(id, []));
  try {
    const { data, error } = await sb
      .from('chat_message_reactions')
      .select('message_id, user_id, emoji')
      .in('message_id', ids);
    if (error) throw error;
    (data || []).forEach((row) => {
      const list = reactionsByMessage.get(row.message_id) || [];
      list.push({ user_id: row.user_id, emoji: row.emoji });
      reactionsByMessage.set(row.message_id, list);
    });
  } catch (error) {
    console.error('Load reactions error:', error);
  }
}

// 引用元が画面に読み込まれていない場合だけ、まとめて取りに行く。
async function loadQuotedMessages(list) {
  const known = new Map(currentMessages.map((m) => [m.id, m]));
  const wanted = [...new Set(
    list.map((m) => m.reply_to_id).filter((id) => id && !known.has(id) && !quotedMessages.has(id))
  )];
  if (!wanted.length) return;
  try {
    const { data, error } = await sb
      .from('chat_messages')
      .select('id, username, content, kind')
      .in('id', wanted);
    if (error) throw error;
    (data || []).forEach((row) => quotedMessages.set(row.id, row));
  } catch (error) {
    console.error('Load quoted messages error:', error);
  }
}

function resolveQuoted(id) {
  if (!id) return null;
  return currentMessages.find((m) => m.id === id) || quotedMessages.get(id) || null;
}

// 自分の発言を、自分以外の誰が読んだか。読んだ時刻の新しい順。
// 既読数と既読メンバー一覧はここだけを出所にして、両者がずれないようにする。
function readersFor(msg) {
  if (!msg || msg.user_id !== currentUser.id) return [];
  const sentAt = new Date(msg.created_at).getTime();
  return groupReadStates
    .filter((row) => (
      row.user_id !== currentUser.id && new Date(row.last_read_at).getTime() >= sentAt
    ))
    .slice()
    .sort((a, b) => new Date(b.last_read_at).getTime() - new Date(a.last_read_at).getTime());
}

// 自分の発言を、自分以外の何人が読んだか。
function readCountFor(msg) {
  return readersFor(msg).length;
}

function readMarkHtml(msg) {
  const count = readCountFor(msg);
  if (count <= 0) return '';
  // 1対1では人数を出さず「既読」だけにする（LINE と同じ見え方）。
  const others = groupMembers.filter((u) => u.id !== currentUser.id).length;
  const label = others <= 1 ? '既読' : `既読 ${count}`;
  // 押すと誰が読んだかを開く。data 属性は refreshReadMarks の textContent 更新でも残る。
  return `<button type="button" class="read-mark" data-read-for="${msg.id}" onclick="openReadDetails(this.dataset.readFor, this)" aria-label="${label}の内訳を見る">${label}<span aria-hidden="true">⌄</span></button>`;
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 768px), (max-height: 600px) and (pointer: coarse)').matches;
}

function resetMessageView() {
  currentMessages = [];
  currentPrivateNotes = [];
  seenMessageIds = new Set();
  historyExhausted = false;
  loadingHistory = false;
  viewHasLatest = true;
  followNewMessages = true;
  reactionsByMessage = new Map();
  quotedMessages = new Map();
  clearReplyTarget();
  closeMessageMenu();
  closeReadDetails();
  $('mentionPop').classList.add('hidden');
  $('messages').innerHTML = '';
  $('jumpLatestBtn').classList.add('hidden');
}

function updateJumpLatestButton() {
  $('jumpLatestBtn').classList.toggle('hidden', viewHasLatest && followNewMessages);
}

async function setMessages(list) {
  const groupId = currentGroupId;
  currentMessages = list.slice();
  seenMessageIds = new Set(currentMessages.map((m) => m.id));
  renderMessageList();
  // リアクションと引用元は後追いで足して描き直す（本文の表示を待たせない）。
  await Promise.all([
    loadReactions(currentMessages.map((m) => m.id)),
    loadQuotedMessages(currentMessages)
  ]);
  if (Number(currentGroupId) !== Number(groupId)) return;
  renderMessageList();
}

function scrollMessagesToBottom() {
  const el = $('messages');
  el.scrollTop = el.scrollHeight;
}

// 検索などで最新まで届いていない範囲の末尾が見えたら、最新範囲へ切り替える。
// 末尾の先に未読込メッセージがある状態で止まると、DOM上には続きがないため
// 入力欄まで空白になる。「最新へ」と同じ再読込を自動で行い、その空白を作らない。
function resolveUnloadedLatestGap() {
  if (jumpingToLatest) return;
  const messages = $('messages');
  const lastMessageId = currentMessages.at(-1)?.id;
  const lastMessage = lastMessageId
    ? messages?.querySelector(`.message[data-message-id="${lastMessageId}"]`)
    : null;
  if (!messages || !lastMessage) return;
  const viewport = messages.getBoundingClientRect();
  const last = lastMessage.getBoundingClientRect();
  if (last.bottom <= viewport.top || last.bottom > viewport.bottom) return;
  const gap = viewport.bottom - last.bottom - 16;
  if (gap <= 8) return;
  if (viewHasLatest) {
    // 最新データはあるが、画像読込などで追従だけ外れた状態。
    // 「最新へ」で行われる入力欄再計測も実行してから最下部へ戻す。
    followNewMessages = true;
    syncChatViewport();
    scrollMessagesToBottom();
    updateJumpLatestButton();
    return;
  }
  void jumpToLatest();
}

// スタンプは遅延読み込みのため、初回描画時点では高さが未確定になる。
// 読み込み後に下端が動いたタイミングでも最新追従・未読込判定をやり直す。
function watchStickerLayout(root) {
  const settle = () => requestAnimationFrame(() => {
    if (viewHasLatest && followNewMessages) scrollMessagesToBottom();
    else resolveUnloadedLatestGap();
  });
  root.querySelectorAll('img.msg-sticker').forEach((image) => {
    if (image.complete) {
      settle();
      return;
    }
    image.addEventListener('load', settle, { once: true });
    image.addEventListener('error', settle, { once: true });
  });
}

// 自分が送った感情イラストは、画像の読み込みで高さが確定した後も
// 入力欄の裏へ隠れないよう、最新位置へ追従させる。
function scrollSentStickerIntoView(messageId) {
  const messages = $('messages');
  const scroll = () => {
    if (!messages || Number(currentMessages.at(-1)?.id) !== Number(messageId)) return;
    messages.scrollTop = messages.scrollHeight;
    updateJumpLatestButton();
  };

  requestAnimationFrame(() => {
    scroll();
    requestAnimationFrame(scroll);
    const image = messages?.querySelector(`.message[data-message-id="${messageId}"] img.msg-sticker`);
    if (image && !image.complete) image.addEventListener('load', scroll, { once: true });
  });
}

// --- 日付の区切り ---

function dayKey(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function formatDayLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (dayKey(iso) === dayKey(today.toISOString())) return '今日';
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return '昨日';
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${weekday})`;
}

// --- 1件分の DOM ---

// 本文中の @表示名 を、そのトークの参加者名と照合して強調する。
// 長い名前から先に照合しないと「@田中」が「@田中太郎」を食ってしまう。
// 本文中のURL。末尾の句読点・閉じ括弧は本文の一部として外す（firstMessageUrl と同じ扱い）。
// 全角記号・日本語句読点でも必ず切る。ここを緩くすると
// 「…opera.html、https://…」がひと続きのURLとして扱われ、読点が %E3%80%81 へ
// エンコードされた存在しないURLになる（2026-08-27 実利用で404を確認）。
const MESSAGE_URL_PATTERN = 'https?:\\/\\/[^\\s<>"、。，．！？；：・〜（）「」『』【】〔〕〈〉《》［］｛｝｜＼＜＞]+';
const MESSAGE_URL_RE = new RegExp(MESSAGE_URL_PATTERN, 'i');

// 本文の途中にあるURLを、その場でクリックできるリンクにする。
// href は safeHttpUrl で http/https に限定し、javascript: 等を弾く。
function linkifyAt(text, index) {
  if (text[index] !== 'h' && text[index] !== 'H') return null;
  const match = MESSAGE_URL_RE.exec(text.slice(index));
  if (!match || match.index !== 0) return null;
  const raw = match[0].replace(/[.,!?。、，！？）)\]}]+$/g, '');
  if (!raw) return null;
  const href = safeHttpUrl(raw);
  if (!href) return null;
  return {
    length: raw.length,
    html: `<a class="msg-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`,
  };
}

function renderContentWithMentions(content, mentions) {
  const text = String(content ?? '');
  const names = groupMembers
    .flatMap((u) => isStoreBot(u) ? [personName(u), u.username] : [u.username])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const mentionSet = new Set(Array.isArray(mentions) ? mentions : []);
  let out = '';
  let i = 0;
  while (i < text.length) {
    // メンション候補が無いルームでもURLだけはリンク化する（早期returnしない）。
    const link = linkifyAt(text, i);
    if (link) {
      out += link.html;
      i += link.length;
      continue;
    }
    if (names.length && (text[i] === '@' || text[i] === '＠')) {
      const rest = text.slice(i + 1);
      const hit = names.find((name) => rest.startsWith(name));
      if (hit) {
        const user = groupMembers.find((u) => u.username === hit);
        const isMe = user && user.id === currentUser.id && mentionSet.has(currentUser.id);
        out += `<span class="mention${isMe ? ' me' : ''}">@${escapeHtml(hit)}</span>`;
        i += 1 + hit.length;
        continue;
      }
    }
    out += escapeHtml(text[i]);
    i += 1;
  }
  return out;
}

function quotePreviewText(quoted) {
  if (!quoted) return '（削除された発言）';
  if (quoted.kind === 'image') return '[画像]';
  if (quoted.kind === 'file') return `[ファイル] ${fileFromMessage(quoted)?.name || ''}`;
  if (quoted.kind === 'sticker') return String(quoted.content || '[感情イラスト]');
  return String(quoted.content ?? '');
}

function fileFromMessage(msg) {
  if (!msg || msg.kind !== 'file') return null;
  const payload = typeof msg.payload === 'string' ? safeParseJson(msg.payload) : msg.payload;
  const file = payload && payload.file;
  return file && file.path ? file : null;
}

function firstMessageUrl(content) {
  const match = String(content || '').match(MESSAGE_URL_RE);
  if (!match) return '';
  return safeHttpUrl(match[0].replace(/[.,!?。、，！？）)\]}]+$/g, ''));
}

function renderLinkPreview(content) {
  const url = firstMessageUrl(content);
  if (!url) return '';
  let host = url;
  try { host = new URL(url).hostname; } catch (_) {}
  return `<a class="link-preview" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span class="link-preview-label">リンク</span><span class="link-preview-host">${escapeHtml(host)}</span><span class="link-preview-url">${escapeHtml(url)}</span></a>`;
}

function renderReactions(msg) {
  const list = reactionsByMessage.get(msg.id) || [];
  if (!list.length) return '';
  const grouped = new Map();
  list.forEach((row) => {
    const entry = grouped.get(row.emoji) || { count: 0, mine: false };
    entry.count += 1;
    if (row.user_id === currentUser.id) entry.mine = true;
    grouped.set(row.emoji, entry);
  });
  const chips = [...grouped.entries()].map(([emoji, entry]) => (
    `<button class="reaction-chip ${entry.mine ? 'mine' : ''}" type="button"
       data-emoji="${escapeHtml(emoji)}" data-message-id="${msg.id}">
       <span>${escapeHtml(emoji)}</span><span class="count">${entry.count}</span>
     </button>`
  )).join('');
  return `<div class="reactions">${chips}</div>`;
}

function closeReactionDetails() {
  $('reactionDetailOverlay').classList.add('hidden');
}

function openReactionDetails(messageId) {
  const list = reactionsByMessage.get(Number(messageId)) || [];
  if (!list.length) return;
  $('reactionDetailHeading').textContent = `リアクション ${list.length}`;
  $('reactionDetailList').innerHTML = list.map((row) => {
    const user = groupMembers.find((member) => String(member.id) === String(row.user_id));
    const name = user ? personName(user) : '退出したユーザー';
    const iconUrl = user ? personIconUrl(user) : '';
    const avatarBackground = iconUrl ? 'transparent' : avatarStyle(name);
    return `<div class="reaction-detail-row">
      <div class="reaction-detail-avatar" style="background:${avatarBackground}">${avatarHtml(user ? personAvatarKey(user) : '?', iconUrl, isStoreBot(user))}</div>
      <div class="reaction-detail-name">${escapeHtml(name)}${user && String(user.id) === String(currentUser.id) ? '（自分）' : ''}</div>
      <div class="reaction-detail-emoji" aria-label="${escapeHtml(row.emoji)}">${escapeHtml(row.emoji)}</div>
    </div>`;
  }).join('');
  $('reactionDetailOverlay').classList.remove('hidden');
}

function closeReadDetails() {
  document.querySelector('.read-menu')?.remove();
}

// 既読マークのそばに、メッセージ操作と同じ浮遊パネルで誰がいつ読んだかを出す。
function openReadDetails(messageId, anchor) {
  const msg = currentMessages.find((m) => String(m.id) === String(messageId));
  const readers = readersFor(msg);
  if (!readers.length) return;
  closeReadDetails();
  const menu = document.createElement('div');
  menu.className = 'read-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', `既読 ${readers.length}人`);
  menu.innerHTML = `<div class="read-menu-heading"><span>既読 ${readers.length}</span><button type="button" aria-label="閉じる">×</button></div>
    <div class="read-menu-list">${readers.map((row) => {
    // 退出した人の既読も履歴としては残るため、名前が引けない場合を潰さない。
    const user = groupMembers.find((member) => String(member.id) === String(row.user_id));
    const name = user ? personName(user) : '退出したユーザー';
    const iconUrl = user ? personIconUrl(user) : '';
    const avatarBackground = iconUrl ? 'transparent' : avatarStyle(name);
    return `<div class="read-detail-row">
      <div class="reaction-detail-avatar" style="background:${avatarBackground}">${avatarHtml(user ? personAvatarKey(user) : '?', iconUrl, isStoreBot(user))}</div>
      <div class="reaction-detail-name">${escapeHtml(name)}</div>
      <div class="read-detail-time">${escapeHtml(formatTalkTime(row.last_read_at))}</div>
    </div>`;
  }).join('')}</div>`;
  document.body.appendChild(menu);

  const target = anchor || document.querySelector(`.read-mark[data-read-for="${msg.id}"]`);
  const rect = target?.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = rect
    ? Math.min(Math.max(8, rect.right - menuRect.width), window.innerWidth - menuRect.width - 8)
    : Math.max(8, (window.innerWidth - menuRect.width) / 2);
  const preferredTop = rect && rect.top - menuRect.height - 8 >= 8
    ? rect.top - menuRect.height - 8
    : (rect ? rect.bottom + 8 : 56);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.min(preferredTop, window.innerHeight - menuRect.height - 8)}px`;
  menu.querySelector('button')?.addEventListener('click', closeReadDetails);
}

function messageEditHistory(msg) {
  const raw = msg && msg.edit_history;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function renderStruckEditHistory(msg) {
  const items = messageEditHistory(msg)
    .map((row) => String((row && row.content) || '').trim())
    .filter(Boolean);
  if (!items.length) return '';
  return items.map((text) => `<span class="edit-original">${escapeHtml(text)}</span>`).join('');
}

function buildMessageNode(msg) {
  if (shouldHideAdminNotice(msg)) return null;
  const div = document.createElement('div');
  const isOwn = currentUser && String(msg.user_id) === String(currentUser.id);
  const cards = cardsFromMessage(msg);
  const image = imageFromMessage(msg);
  const file = fileFromMessage(msg);
  const sticker = stickerFromMessage(msg);
  const compactSticker = sticker && sticker.display === 'compact';
  div.className = `message ${isOwn ? 'own' : ''} ${cards ? 'card' : ''} ${image ? 'image' : ''} ${file ? 'file' : ''} ${sticker ? 'sticker' : ''} ${compactSticker ? 'compact-sticker' : ''}`;
  div.dataset.messageId = String(msg.id);

  let bodyHtml;
  if (cards) {
    bodyHtml = cards.map(renderCard).join('');
  } else if (image) {
    bodyHtml = `<img class="msg-image" data-path="${escapeHtml(image.path)}" alt="画像" loading="lazy" decoding="async">`;
  } else if (file) {
    const size = Number(file.size) > 0 ? `${(Number(file.size) / 1024 / 1024).toFixed(2)} MB` : 'ファイル';
    bodyHtml = `<a class="file-attachment" data-file-path="${escapeHtml(file.path)}" data-file-mime="${escapeHtml(file.mime || '')}" data-file-name="${escapeHtml(file.name || '添付ファイル')}" href="#" download><span class="file-attachment-icon" aria-hidden="true">${fileAttachmentIcon(file.mime)}</span><span class="file-attachment-body"><span class="file-attachment-name">${escapeHtml(file.name || '添付ファイル')}</span><span class="file-attachment-meta">${escapeHtml(file.mime || '')} · ${escapeHtml(size)}</span></span><span class="file-attachment-download">保存</span></a>`;
  } else if (sticker) {
    const stickerImage = `<img class="msg-sticker" src="${escapeHtml(sticker.path)}" alt="${escapeHtml(sticker.label || '感情イラスト')}" loading="lazy" decoding="async">`;
    const inlineText = compactSticker && !String(msg.content || '').startsWith('[感情イラスト]')
      ? `<span class="bubble-text">${renderContentWithMentions(msg.content, msg.mentions)}</span>` : '';
    const struck = compactSticker ? renderStruckEditHistory(msg) : '';
    bodyHtml = compactSticker
      ? `<div class="message-bubble">${struck}<div class="inline-sticker-message">${stickerImage}${inlineText}</div></div>`
      : stickerImage;
  } else {
    bodyHtml = `<div class="message-bubble">${renderStruckEditHistory(msg)}<span class="bubble-text">${renderContentWithMentions(msg.content, msg.mentions)}</span>${renderLinkPreview(msg.content)}</div>`;
  }

  let quoteHtml = '';
  if (msg.reply_to_id) {
    const quoted = resolveQuoted(msg.reply_to_id);
    // 余計な空白が入らないよう1行で組み立てる。
    quoteHtml = `<div class="quote" data-jump-to="${msg.reply_to_id}">`
      + `<div class="quote-name">${escapeHtml(quoted ? speakerName(quoted.user_id || quoted.id, quoted.username) : '')}</div>`
      + `<div class="quote-text">${escapeHtml(quotePreviewText(quoted))}</div>`
      + `</div>`;
    // 引用は吹き出しの中に入れる。画像・カードのときは上に置く。
    if (!cards && !image && !file && !sticker) {
      bodyHtml = `<div class="message-bubble">${quoteHtml}`
        + renderStruckEditHistory(msg)
        + `<span class="bubble-text">${renderContentWithMentions(msg.content, msg.mentions)}</span>${renderLinkPreview(msg.content)}</div>`;
      quoteHtml = '';
    }
  }

  div.innerHTML = `
    <div class="message-content">
      ${quoteHtml}
      ${bodyHtml}
      ${renderReactions(msg)}
      <div class="message-meta">
        ${isOwn ? '' : `<span class="username">${escapeHtml(speakerName(msg.user_id, msg.username))}</span>`}
        <span>${formatTime(msg.created_at)}</span>
        ${msg.edited_at ? '<span class="edited-mark">編集済み</span>' : ''}
        ${msg.is_silent ? '<span class="silent-mark" title="通知なしで送信されました">🔕</span>' : ''}
        ${isOwn ? readMarkHtml(msg) : ''}
      </div>
    </div>
    <div class="msg-actions">
      <button class="msg-actions-btn" type="button" data-menu-for="${msg.id}" aria-label="操作">⋯</button>
    </div>
  `;
  if (image) {
    const width = safeImageDimension(image.w);
    const height = safeImageDimension(image.h);
    const imageElement = div.querySelector('.msg-image');
    if (imageElement && width && height) {
      imageElement.style.aspectRatio = `${width} / ${height}`;
    }
  }
  if (file) {
    // 札そのものを押したら開く。右端の「保存」だけ従来どおり保存する。
    const card = div.querySelector('a.file-attachment');
    if (card) {
      card.addEventListener('click', (event) => {
        if (event.target.closest('.file-attachment-download')) return;
        event.preventDefault();
        openFileViewer(card.dataset.filePath, {
          mime: card.dataset.fileMime,
          name: card.dataset.fileName,
        });
      });
    }
  }
  return div;
}

function buildDayDivider(iso) {
  const div = document.createElement('div');
  div.className = 'day-divider';
  div.dataset.dayKey = dayKey(iso);
  div.textContent = formatDayLabel(iso);
  return div;
}

// 送信されない私的な注記。誰からも自分にしか見えないことが一目でわかるよう、
// 通常の吹き出しとは別の見た目（中央寄せ・破線・付箋色）にする。
function buildNoteNode(note) {
  const div = document.createElement('div');
  div.className = 'private-note';
  div.dataset.noteId = String(note.id);
  div.innerHTML = `
    <span class="note-pin" aria-hidden="true">📌</span>
    <span class="note-body">
      <span class="note-label">個人メモ（自分だけに表示・送信されません）</span>
      <span class="note-text">${escapeHtml(note.content)}</span>
      <span class="note-time">${formatTime(note.created_at)}</span>
    </span>
    <button class="note-delete" type="button" data-delete-note="${note.id}" title="このメモを削除" aria-label="このメモを削除">✕</button>
  `;
  return div;
}

// メッセージと個人メモを時系列で1本にまとめる。メッセージ側の配列・状態は
// 一切変更しない（返信・引用・削除・転送などが個人メモを巻き込まないため）。
function buildTimeline() {
  const items = currentMessages.map((m) => ({ ts: m.created_at, kind: 'message', data: m }));
  currentPrivateNotes.forEach((n) => items.push({ ts: n.created_at, kind: 'note', data: n }));
  items.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return items;
}

function renderMessageList() {
  const el = $('messages');
  el.innerHTML = '';
  let lastDay = '';
  buildTimeline().forEach((item) => {
    const key = dayKey(item.ts);
    if (key !== lastDay) {
      el.appendChild(buildDayDivider(item.ts));
      lastDay = key;
    }
    const node = item.kind === 'note' ? buildNoteNode(item.data) : buildMessageNode(item.data);
    if (node) el.appendChild(node);
  });
  hydrateMessageImages();
  hydrateMessageFiles();
  watchStickerLayout(el);
  requestAnimationFrame(resolveUnloadedLatestGap);
}

async function fillLatestGap() {
  if (fillingLatestGap || jumpingToLatest || viewHasLatest || !currentGroupId) return viewHasLatest;
  fillingLatestGap = true;
  const groupId = currentGroupId;
  const el = $('messages');
  const keepNode = el
    ? [...el.querySelectorAll('.message')].find((node) => {
        const rect = node.getBoundingClientRect();
        const viewport = el.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      })
    : null;
  const keepId = keepNode?.dataset.messageId;
  const keepOffset = keepNode ? keepNode.getBoundingClientRect().top : 0;
  const prevTop = el ? el.scrollTop : 0;
  try {
    for (let page = 0; page < 20; page++) {
      const last = currentMessages.at(-1);
      if (!last || !last.created_at) {
        viewHasLatest = true;
        break;
      }
      const { data, error } = await sb.from('chat_messages')
        .select(MESSAGE_COLUMNS)
        .eq('group_id', groupId)
        .gt('created_at', last.created_at)
        .order('created_at', { ascending: true })
        .limit(MESSAGE_PAGE_SIZE);
      if (error) throw error;
      if (Number(currentGroupId) !== Number(groupId)) return false;
      const rows = data || [];
      const batch = rows.filter((msg) => !seenMessageIds.has(msg.id));
      if (batch.length) {
        currentMessages = currentMessages.concat(batch);
        batch.forEach((msg) => seenMessageIds.add(msg.id));
        await Promise.all([
          loadReactions(batch.map((msg) => msg.id)),
          loadQuotedMessages(batch)
        ]);
      }
      if (rows.length < MESSAGE_PAGE_SIZE) {
        viewHasLatest = true;
        break;
      }
    }
    const latest = lastMessages[groupId];
    if (latest && !seenMessageIds.has(latest.id)) viewHasLatest = false;
    renderMessageList();
    if (keepId && el) {
      const node = el.querySelector(`.message[data-message-id="${keepId}"]`);
      if (node) el.scrollTop += node.getBoundingClientRect().top - keepOffset;
    } else if (el) {
      el.scrollTop = prevTop;
    }
    snapshotRoomView(groupId);
    updateJumpLatestButton();
    return viewHasLatest;
  } catch (error) {
    console.error('Fill latest gap error:', error);
    return false;
  } finally {
    fillingLatestGap = false;
  }
}

// 新着1件だけを末尾に足す（全体を描き直さずスクロール位置を保つ）。
function addMessageToUI(msg) {
  if (Number(msg.group_id) !== currentGroupId) return;
  if (shouldHideAdminNotice(msg)) return;
  if (seenMessageIds.has(msg.id)) return;
  // 途中へジャンプしている間は、間の発言を読み足してから末尾へつなぐ。
  // 見ていた位置は fillLatestGap が維持する。
  if (!viewHasLatest || fillingLatestGap) {
    updateJumpLatestButton();
    void fillLatestGap();
    return;
  }
  seenMessageIds.add(msg.id);
  currentMessages.push(msg);
  if (!reactionsByMessage.has(msg.id)) reactionsByMessage.set(msg.id, []);
  if (msg.reply_to_id) {
    loadQuotedMessages([msg]).then(() => refreshMessageNode(msg.id));
  }

  const el = $('messages');
  const dividers = el.querySelectorAll('.day-divider');
  const lastDay = dividers.length ? dividers[dividers.length - 1].dataset.dayKey : '';
  if (dayKey(msg.created_at) !== lastDay) el.appendChild(buildDayDivider(msg.created_at));
  const node = buildMessageNode(msg);
  if (node) el.appendChild(node);

  hydrateMessageImages();
  hydrateMessageFiles();
  watchStickerLayout(el);
  if (followNewMessages) scrollMessagesToBottom();
}

// --- 操作メニュー（返信・リアクション） ---

function closeMessageMenu() {
  const open = document.querySelector('.msg-menu');
  if (open) open.remove();
}

function openMessageMenu(messageId, anchor) {
  closeMessageMenu();
  const msg = currentMessages.find((m) => m.id === Number(messageId));
  if (!msg) return;

  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  const canDelete = currentUser && String(msg.user_id) === String(currentUser.id);
  const canEdit = canDelete && canCurrentUserSend() && messageIsEditable(msg);
  const canInteract = canCurrentUserSend();
  menu.innerHTML = `
    ${canInteract ? `<div class="msg-menu-emojis">
      ${REACTION_CHOICES.map((e) => `<button type="button" data-emoji="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')}
    </div>` : ''}
    <div class="msg-menu-actions">
      ${canInteract ? '<button class="msg-menu-reply" type="button" data-action="reply"><span class="msg-menu-action-icon">↩</span><span>返信</span></button>' : ''}
      <button class="msg-menu-reply" type="button" data-action="copy"><span class="msg-menu-action-icon">⧉</span><span>コピー</span></button>
      <button class="msg-menu-reply" type="button" data-action="keep"><span class="msg-menu-action-icon">📌</span><span>Keepに保存</span></button>
      <button class="msg-menu-reply" type="button" data-action="forward"><span class="msg-menu-action-icon">➜</span><span>転送</span></button>
      ${canEdit ? '<button class="msg-menu-reply" type="button" data-action="edit"><span class="msg-menu-action-icon">✎</span><span>編集</span></button>' : ''}
      ${canDelete ? '<button class="msg-menu-reply msg-menu-delete" type="button" data-action="delete"><span class="msg-menu-action-icon">⌫</span><span>削除</span></button>' : ''}
    </div>
  `;
  document.body.appendChild(menu);

  // アンカーの近くに出す。画面外へはみ出さないよう寄せる。
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, rect.left - menuRect.width / 2),
    window.innerWidth - menuRect.width - 8
  );
  const preferredTop = rect.top - menuRect.height - 8 < 8
    ? rect.bottom + 8
    : rect.top - menuRect.height - 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.min(preferredTop, window.innerHeight - menuRect.height - 8)}px`;

  menu.addEventListener('click', (e) => {
    const emojiBtn = e.target.closest('[data-emoji]');
    if (emojiBtn) {
      toggleReaction(msg.id, emojiBtn.dataset.emoji);
      closeMessageMenu();
      return;
    }
    if (e.target.closest('[data-action="reply"]')) {
      setReplyTarget(msg);
      closeMessageMenu();
      return;
    }
    if (e.target.closest('[data-action="copy"]')) {
      copyMessage(msg);
      closeMessageMenu();
      return;
    }
    if (e.target.closest('[data-action="keep"]')) {
      saveMessageToKeep(msg);
      closeMessageMenu();
      return;
    }
    if (e.target.closest('[data-action="forward"]')) {
      closeMessageMenu();
      openForward(msg);
      return;
    }
    if (e.target.closest('[data-action="edit"]')) {
      closeMessageMenu();
      startMessageEdit(msg);
      return;
    }
    if (e.target.closest('[data-action="delete"]')) {
      closeMessageMenu();
      deleteMessage(msg);
    }
  });
}

// --- リアクション ---

async function toggleReaction(messageId, emoji) {
  if (!requireCurrentRoomSend()) return;
  const list = reactionsByMessage.get(messageId) || [];
  const mine = list.find((r) => r.user_id === currentUser.id);
  const removing = mine && mine.emoji === emoji;

  // 通信を待たずに見た目を先に変える。失敗したら元に戻す。
  const rollback = list.slice();
  reactionsByMessage.set(
    messageId,
    removing
      ? list.filter((r) => r.user_id !== currentUser.id)
      : list.filter((r) => r.user_id !== currentUser.id).concat([{ user_id: currentUser.id, emoji }])
  );
  refreshMessageNode(messageId);

  try {
    const query = removing
      ? sb.from('chat_message_reactions').delete()
          .eq('message_id', messageId).eq('user_id', currentUser.id)
      : sb.from('chat_message_reactions')
          .upsert(
            { message_id: messageId, user_id: currentUser.id, emoji },
            { onConflict: 'message_id,user_id' }
          );
    const { error } = await query;
    if (error) throw error;
  } catch (error) {
    console.error('Reaction error:', error);
    reactionsByMessage.set(messageId, rollback);
    refreshMessageNode(messageId);
  }
}

// 1件だけ差し替える（全体を描き直すとスクロールが飛ぶため）。
function refreshMessageNode(messageId) {
  const node = $('messages').querySelector(`.message[data-message-id="${messageId}"]`);
  const msg = currentMessages.find((m) => m.id === Number(messageId));
  if (!node || !msg) return;
  const replacement = buildMessageNode(msg);
  if (!replacement) {
    node.remove();
    return;
  }
  node.replaceWith(replacement);
  hydrateMessageImages();
}

function refreshReadMarks() {
  currentMessages.forEach((msg) => {
    if (msg.user_id !== currentUser.id) return;
    const node = $('messages').querySelector(`.message[data-message-id="${msg.id}"] .read-mark`);
    const html = readMarkHtml(msg);
    if (!node && html) {
      refreshMessageNode(msg.id);
    } else if (node) {
      const next = html.replace(/<[^>]*>/g, '');
      if (node.textContent !== next) node.textContent = next;
    }
  });
}

// --- 返信 ---

function setReplyTarget(msg) {
  if (!requireCurrentRoomSend()) return;
  replyTarget = msg;
  $('replyBar').classList.remove('hidden');
  $('replyBarName').textContent = `${speakerName(msg.user_id, msg.username)} にリプライ`;
  $('replyBarText').textContent = quotePreviewText(msg);
  $('messageInput').focus();
}

function clearReplyTarget() {
  replyTarget = null;
  $('replyBar').classList.add('hidden');
}

function messageCopyText(msg) {
  if (!msg) return '';
  if (msg.kind === 'image') return '[画像]';
  if (msg.kind === 'file') return `[ファイル] ${fileFromMessage(msg)?.name || ''}`;
  return String(msg.content || '');
}

async function copyMessage(msg) {
  const text = messageCopyText(msg);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showNotice('コピーしました');
  } catch (error) {
    console.error('Copy error:', error);
    alert('コピーに失敗しました');
  }
}

async function deleteMessage(msg) {
  if (!msg || !currentUser || String(msg.user_id) !== String(currentUser.id)) return;
  if (!confirm('このメッセージを削除しますか？')) return;
  try {
    const { error } = await sb.from('chat_messages')
      .delete()
      .eq('id', msg.id)
      .eq('user_id', currentUser.id);
    if (error) throw error;
    if (editingMessage && Number(editingMessage.id) === Number(msg.id)) cancelMessageEdit();
    handleDeletedMessage({ id: msg.id, group_id: msg.group_id });
  } catch (error) {
    console.error('Delete message error:', error);
    alert(error.message || '削除に失敗しました');
  }
}

function messageIsEditable(msg) {
  if (!msg || !currentUser || String(msg.user_id) !== String(currentUser.id)) return false;
  if (isGroupTrashed(findMineGroup(msg.group_id || currentGroupId))) return false;
  if (String(msg.kind || 'text') === 'text') return true;
  const sticker = stickerFromMessage(msg);
  return !!(sticker && sticker.display === 'compact');
}

function editableMessageText(msg) {
  if (!msg) return '';
  const sticker = stickerFromMessage(msg);
  if (sticker && sticker.display === 'compact') {
    const text = String(msg.content || '');
    if (text.startsWith('[感情イラスト]')) return '';
    return text;
  }
  return String(msg.content || '');
}

function startMessageEdit(msg) {
  if (!messageIsEditable(msg) || !requireCurrentRoomSend()) return;
  editingMessage = msg;
  isSilentSendActive = false;
  isPrivateNoteMode = false;
  pendingInlineSticker = null;
  renderInlineStickerPreview();
  composerSheetOpen = false;
  clearReplyTarget();
  const input = $('messageInput');
  if (input) {
    input.value = editableMessageText(msg);
    input.focus();
  }
  syncComposerModeUi();
  resizeComposer();
  showChatToast('編集中');
}

function cancelMessageEdit() {
  if (!editingMessage) return;
  editingMessage = null;
  const input = $('messageInput');
  if (input) input.value = '';
  syncComposerModeUi();
  resizeComposer();
}

async function saveEditedMessage(content) {
  const msg = editingMessage;
  if (!msg || !currentUser) return false;
  if (!requireCurrentRoomSend()) return false;
  if (isGroupTrashed(findMineGroup(currentGroupId))) {
    alert('ゴミ箱のルームでは編集できません。復元してから使ってください。');
    return false;
  }
  const sticker = stickerFromMessage(msg);
  const compact = !!(sticker && sticker.display === 'compact');
  const text = String(content || '').trim();
  if (!compact && !text) return false;
  try {
    const { data, error } = await sb.from('chat_messages')
      .update({
        content: text,
        mentions: collectMentions(text)
      })
      .eq('id', msg.id)
      .eq('user_id', currentUser.id)
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    editingMessage = null;
    handleUpdatedMessage(data);
    return true;
  } catch (error) {
    console.error('Edit message error:', error);
    alert(error.message || '編集に失敗しました');
    return false;
  }
}

async function openForward(msg) {
  if (!msg || !currentUser) return;
  if (!chatAccessAllows('can_browse_users') || !chatAccessAllows('can_start_direct')) {
    alert('転送先のユーザーを選ぶ権限がありません');
    return;
  }
  forwardMessage = msg;
  if (!registeredUsers.length) await loadRegisteredUsers();
  $('forwardSearch').value = '';
  $('forwardOverlay').classList.remove('hidden');
  renderForwardUsers();
}

function closeForward() {
  $('forwardOverlay').classList.add('hidden');
  forwardMessage = null;
}

function renderForwardUsers() {
  const list = $('forwardUserList');
  if (!list) return;
  list.innerHTML = '';
  const q = ($('forwardSearch').value || '').trim().toLowerCase();
  const users = registeredUsers.filter((u) => (
    u.id !== currentUser.id
    && !isBotUser(u)
    && sharesAffiliationWith(u)
    && (!q || String(u.username || '').toLowerCase().includes(q))
  ));
  if (!users.length) {
    list.innerHTML = '<div class="empty-note">所属店舗が同じ転送先はいません</div>';
    return;
  }
  users.forEach((user) => {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <div class="talk-avatar" style="background:${user.icon_url ? '#2c2c2e' : avatarStyle(user.username)}">${avatarHtml(user.username, user.icon_url, isStoreBot(user))}</div>
      <div class="talk-body">
        <div class="group-item-name"><span>${escapeHtml(user.username)}</span></div>
      </div>
    `;
    row.onclick = () => forwardToUser(user);
    list.appendChild(row);
  });
}

async function insertForwardedMessage(msg, groupId) {
  const sticker = stickerFromMessage(msg);
  if (sticker && sticker.id) {
    const { data, error } = await sb.from('chat_messages').insert({
      group_id: groupId,
      user_id: currentUser.id,
      username: currentUser.username,
      content: '[感情イラスト]',
      kind: 'sticker',
      payload: { v: 1, kind: 'sticker', sticker: { id: sticker.id } }
    }).select('id').single();
    if (error) throw error;
    return data;
  }
  const image = imageFromMessage(msg);
  if (image && image.path) {
    const { data: signed, error: signedError } = await sb.storage
      .from('chat-images')
      .createSignedUrl(image.path, 60);
    if (signedError) throw signedError;
    const res = await fetch(signed.signedUrl);
    if (!res.ok) throw new Error('画像の取得に失敗しました');
    const blob = await res.blob();
    const path = `groups/${groupId}/${crypto.randomUUID()}.jpg`;
    const { error: uploadError } = await sb.storage
      .from('chat-images')
      .upload(path, blob, { contentType: blob.type || 'image/jpeg', cacheControl: '3600' });
    if (uploadError) throw uploadError;
    const { data, error } = await sb.from('chat_messages').insert({
      group_id: groupId,
      user_id: currentUser.id,
      username: currentUser.username,
      content: '[画像]',
      kind: 'image',
      payload: { v: 1, kind: 'image', image: { path, w: image.w, h: image.h } }
    }).select('id').single();
    if (error) throw error;
    return data;
  }
  const content = messageCopyText(msg).slice(0, 2000) || '[メッセージ]';
  const { data, error } = await sb.from('chat_messages').insert({
    group_id: groupId,
    user_id: currentUser.id,
    username: currentUser.username,
    content
  }).select('id').single();
  if (error) throw error;
  return data;
}

async function forwardToUser(user) {
  const msg = forwardMessage;
  if (!msg || !user) return;
  if (!chatAccessAllows('can_start_direct')) {
    alert('1対1トークを開始する権限がありません');
    return;
  }
  closeForward();
  try {
    const { data: groupId, error } = await sb.rpc('chat_open_direct', { p_other: user.id });
    if (error) throw error;
    await loadGroups();
    const group = myGroups.find((item) => Number(item.id) === Number(groupId));
    if (!canCurrentUserSend(group)) throw new Error('転送先のトークは閲覧専用です');
    const inserted = await insertForwardedMessage(msg, groupId);
    if (inserted && inserted.id) dispatchPushForMessage(inserted.id);
    showNotice(`${user.username} に転送しました`);
  } catch (error) {
    console.error('Forward error:', error);
    alert(error.message || '転送に失敗しました');
  }
}

function jumpToLoadedMessage(messageId) {
  const node = $('messages').querySelector(`.message[data-message-id="${messageId}"]`);
  if (node) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    return;
  }
  // まだ読み込んでいない古い発言なら、その位置を読み直して飛ぶ。
  const quoted = quotedMessages.get(Number(messageId));
  if (quoted && quoted.created_at) openMessageAt(currentGroupId, quoted.created_at, messageId);
}

// --- メンション ---

// 本文を参加者名と突き合わせて、実際に名指しされた人のIDを拾う。
// サーバー側でも参加者で絞り直すので、ここは入力補助に過ぎない。
function collectMentions(text) {
  const names = groupMembers
    .filter((u) => u.id !== currentUser.id)
    .sort((a, b) => b.username.length - a.username.length);
  const found = new Set();
  const body = String(text ?? '');
  names.forEach((user) => {
    if (body.includes(`@${user.username}`) || body.includes(`＠${user.username}`)) {
      found.add(user.id);
    }
  });
  return [...found];
}

// 入力欄のカーソル直前が「@なにか」なら、その断片を返す。
function currentMentionFragment() {
  const input = $('messageInput');
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const hit = upto.match(/[@＠]([^\s@＠]*)$/);
  return hit ? { query: hit[1], start: upto.length - hit[0].length } : null;
}

function updateMentionPicker() {
  const pop = $('mentionPop');
  const fragment = currentMentionFragment();
  if (!fragment) {
    pop.classList.add('hidden');
    mentionCandidates = [];
    return;
  }

  const query = fragment.query.toLowerCase();
  mentionCandidates = groupMembers
    .filter((u) => u.id !== currentUser.id && (
      String(u.username || '').toLowerCase().includes(query)
      || personName(u).toLowerCase().includes(query)
    ))
    .slice(0, 8);

  if (!mentionCandidates.length) {
    pop.classList.add('hidden');
    return;
  }

  mentionActiveIndex = Math.min(mentionActiveIndex, mentionCandidates.length - 1);
  pop.innerHTML = mentionCandidates.map((user, index) => {
    const iconUrl = personIconUrl(user);
    return `
      <div class="mention-row ${index === mentionActiveIndex ? 'active' : ''}" data-index="${index}">
        <div class="talk-avatar" style="background:${iconUrl ? '#2c2c2e' : avatarStyle(personAvatarKey(user))}">${avatarHtml(personAvatarKey(user), iconUrl, isStoreBot(user))}</div>
        <span>${escapeHtml(personName(user))}</span>
      </div>
    `;
  }).join('');
  pop.classList.remove('hidden');
}

function applyMention(index) {
  const user = mentionCandidates[index];
  const fragment = currentMentionFragment();
  if (!user || !fragment) return;
  const input = $('messageInput');
  const caret = input.selectionStart ?? input.value.length;
  input.value = `${input.value.slice(0, fragment.start)}@${user.username} ${input.value.slice(caret)}`;
  const next = fragment.start + user.username.length + 2;
  input.setSelectionRange(next, next);
  input.focus();
  $('mentionPop').classList.add('hidden');
  mentionCandidates = [];
  mentionActiveIndex = 0;
}

// --- 過去メッセージの読み込み（上端まで遡ったとき） ---

async function loadOlderMessages() {
  if (loadingHistory || historyExhausted || !currentGroupId || !currentMessages.length) return;
  loadingHistory = true;

  const el = $('messages');
  $('historySpinner').classList.remove('hidden');
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;

  try {
    const { data, error } = await sb
      .from('chat_messages')
      .select(MESSAGE_COLUMNS)
      .eq('group_id', currentGroupId)
      .lt('created_at', currentMessages[0].created_at)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_PAGE_SIZE);
    if (error) throw error;

    const older = (data || []).reverse();
    if (older.length < MESSAGE_PAGE_SIZE) historyExhausted = true;
    if (older.length) {
      currentMessages = older.concat(currentMessages);
      older.forEach((m) => seenMessageIds.add(m.id));
      await Promise.all([
        loadReactions(older.map((m) => m.id)),
        loadQuotedMessages(older)
      ]);
      renderMessageList();
      snapshotRoomView(currentGroupId);
      // 読み込み前に見ていた位置を保つ。
      el.scrollTop = el.scrollHeight - prevHeight + prevTop;
    }
  } catch (error) {
    console.error('Load older messages error:', error);
  } finally {
    $('historySpinner').classList.add('hidden');
    loadingHistory = false;
  }
}

function handleMessagesScroll() {
  const el = $('messages');
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  // 下端付近にいるかどうかで、新着を自動追尾するか決める。
  followNewMessages = distanceFromBottom < 80;
  updateJumpLatestButton();
  if (!viewHasLatest && distanceFromBottom < 80) {
    void jumpToLatest();
    return;
  }
  if (el.scrollTop < 120) loadOlderMessages();
  requestAnimationFrame(resolveUnloadedLatestGap);
}

async function jumpToLatest() {
  if (jumpingToLatest) return;
  const group = myGroups.find((g) => g.id === currentGroupId);
  if (!group) return;
  jumpingToLatest = true;
  try {
    await selectGroup(group);
  } finally {
    jumpingToLatest = false;
  }
}

// 通知カードは Bot（service_role）だけが作れる。payload が壊れていたら
// content のテキスト版へ黙って落とす（表示が消えるより読めた方がよい）。
