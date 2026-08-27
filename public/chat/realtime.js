'use strict';

async function dropRealtimeChannel(existing) {
  if (!existing) return;
  try { await sb.removeChannel(existing); } catch (_) { /* 破棄できなくても新規チャンネルで続行 */ }
}

async function subscribeRealtime() {
  const previous = channel;
  channel = null;
  await dropRealtimeChannel(previous);

  try {
    const { data } = await sb.auth.getSession();
    if (data?.session?.access_token) sb.realtime.setAuth(data.session.access_token);
  } catch (error) {
    console.error('Realtime auth error:', error);
  }

  channel = sb
    .channel(`chat-global-${currentUser.id}-${Date.now()}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'chat_user_access', filter: `user_id=eq.${currentUser.id}` },
      () => handleCurrentChatAccessChange())
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'chat_user_stores' },
      () => {
        loadUserStores().then(() => renderGroups()).catch((error) => console.error('Store update error:', error));
      })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'chat_store_change_requests', filter: `user_id=eq.${currentUser.id}` },
      () => {
        loadPendingStoreRequest().then(() => {
          if (!$('profileSettingsOverlay').classList.contains('hidden')) openProfileSettings();
        }).catch((error) => console.error('Store request update error:', error));
      })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_messages' },
      (payload) => handleIncomingMessage(payload.new))
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'chat_messages' },
      (payload) => handleUpdatedMessage(payload.new))
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_private_notes', filter: `user_id=eq.${currentUser.id}` },
      (payload) => handleIncomingNote(payload.new))
    .on('postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'chat_private_notes', filter: `user_id=eq.${currentUser.id}` },
      (payload) => handleDeletedNote(payload.old))
    .on('postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'chat_messages' },
      (payload) => handleDeletedMessage(payload.old))
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_groups' },
      () => loadGroups())
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_group_members' },
      (payload) => {
        if (payload.new.user_id === currentUser.id) loadGroups();
        else {
          if (Number(payload.new.group_id) === currentGroupId) loadGroupContext(currentGroupId);
          loadMemberCounts().then(() => renderGroups());
        }
      })
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'chat_group_members' },
      (payload) => handleMembershipChanged(payload.new))
    .on('postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'chat_group_members' },
      (payload) => handleMemberRemoved(payload.old))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'chat_message_reactions' },
      (payload) => handleReactionChange(payload))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'chat_read_states' },
      (payload) => handleReadStateChange(payload.new || payload.old))
    .subscribe((status) => {
      const ok = status === 'SUBSCRIBED';
      $('connectionStatus').classList.toggle('disconnected', !ok);
    });
}

async function handleCurrentChatAccessChange() {
  try {
    await loadCurrentChatAccess();
    if (chatAccessIsBlocked(currentChatAccess)) {
      closeInvite();
      closeChat();
      showChatAccessBlocked();
      return;
    }
    const blockedPanelWasOpen = !$('chatAccessBlocked').classList.contains('hidden');
    hideChatAccessBlocked();
    if (blockedPanelWasOpen) startSession();
    else {
      syncGlobalCapabilityUi();
      renderGroups();
    }
  } catch (error) {
    console.error('M-talk access refresh error:', error);
  }
}

async function handleMembershipChanged(row) {
  if (!row || !currentUser) return;
  const groupId = Number(row.group_id);
  if (String(row.user_id) === String(currentUser.id)) {
    if (groupId === Number(currentGroupId)) {
      currentRoomMembership = row;
      if (row.can_view !== true) {
        closeInvite();
        closeChat();
      } else {
        syncComposerForGroup(currentGroup());
        paintChatHeader(currentGroup());
      }
    }
    await loadGroups();
    return;
  }
  if (groupId === Number(currentGroupId)) await loadGroupContext(currentGroupId);
}

// 他の人のリアクション増減を画面へ反映する。
function handleReactionChange(payload) {
  const row = payload.new && payload.new.message_id ? payload.new : payload.old;
  if (!row || !row.message_id) return;
  const messageId = Number(row.message_id);
  if (!reactionsByMessage.has(messageId)) return;

  const list = reactionsByMessage.get(messageId) || [];
  const without = list.filter((r) => r.user_id !== row.user_id);
  // 自分の操作は楽観更新で反映済みなので、ここでは配列を作り直すだけにする。
  reactionsByMessage.set(
    messageId,
    payload.eventType === 'DELETE' ? without : without.concat([{ user_id: row.user_id, emoji: row.emoji }])
  );
  refreshMessageNode(messageId);
}

// 他の人が読んだら既読表示を更新する。
function handleReadStateChange(row) {
  if (!row || Number(row.group_id) !== currentGroupId) return;
  groupReadStates = groupReadStates
    .filter((entry) => entry.user_id !== row.user_id)
    .concat([{ user_id: row.user_id, last_read_at: row.last_read_at }]);
  refreshReadMarks();
}

function handleMemberRemoved(row) {
  if (!row || !currentUser) return;
  const groupId = Number(row.group_id);
  if (String(row.user_id) === String(currentUser.id)) {
    const wasMine = myGroups.some((g) => Number(g.id) === groupId);
    myGroups = myGroups.filter((g) => Number(g.id) !== groupId);
    if (Number(currentGroupId) === groupId) {
      closeInvite();
      closeChat();
    }
    if (wasMine) showNotice('ルームから退出しました');
    renderGroups();
    return;
  }
  if (Number(currentGroupId) === groupId) {
    loadGroupContext(currentGroupId);
    if ($('inviteOverlay') && !$('inviteOverlay').classList.contains('hidden')) {
      loadInviteLists();
    }
  }
  loadMemberCounts().then(() => renderGroups());
}

// 別端末・別タブから同じ個人メモを追加/削除したときに同期する。
function handleIncomingNote(row) {
  if (!row || Number(row.group_id) !== Number(currentGroupId)) return;
  if (currentPrivateNotes.some((n) => n.id === row.id)) return;
  currentPrivateNotes = currentPrivateNotes.concat([row])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  renderMessageList();
}

function handleDeletedNote(row) {
  const id = Number(row && row.id);
  if (!Number.isSafeInteger(id)) return;
  const before = currentPrivateNotes.length;
  currentPrivateNotes = currentPrivateNotes.filter((n) => n.id !== id);
  if (currentPrivateNotes.length !== before) renderMessageList();
}

function handleUpdatedMessage(msg) {
  if (!msg || !msg.id) return;
  const id = Number(msg.id);
  if (!Number.isSafeInteger(id)) return;
  const idx = currentMessages.findIndex((item) => Number(item.id) === id);
  if (idx >= 0) {
    currentMessages[idx] = Object.assign({}, currentMessages[idx], msg);
    quotedMessages.set(id, currentMessages[idx]);
    refreshMessageNode(id);
    currentMessages.forEach((item) => {
      if (Number(item.reply_to_id) === id) refreshMessageNode(item.id);
    });
  } else if (quotedMessages.has(id)) {
    quotedMessages.set(id, Object.assign({}, quotedMessages.get(id), msg));
  }
  if (replyTarget && Number(replyTarget.id) === id) {
    replyTarget = Object.assign({}, replyTarget, msg);
    if ($('replyBarText')) $('replyBarText').textContent = quotePreviewText(replyTarget);
  }
  if (editingMessage && Number(editingMessage.id) === id) {
    editingMessage = Object.assign({}, editingMessage, msg);
  }
  const last = lastMessages[msg.group_id];
  if (last && Number(last.id) === id) {
    lastMessages[msg.group_id] = Object.assign({}, last, msg);
    renderGroups();
  }
}

function handleDeletedMessage(row) {
  const id = Number(row && row.id);
  if (!Number.isSafeInteger(id)) return;
  if (editingMessage && Number(editingMessage.id) === id) cancelMessageEdit();
  currentMessages = currentMessages.filter((m) => Number(m.id) !== id);
  quotedMessages.delete(id);
  const node = $('messages') && $('messages').querySelector(`.message[data-message-id="${id}"]`);
  if (node) node.remove();
  loadLastMessages().then(() => renderGroups());
}

function handleIncomingMessage(msg) {
  if (shouldHideAdminNotice(msg, myGroups.find((g) => Number(g.id) === Number(msg.group_id)))) return;
  lastMessages[msg.group_id] = msg;
  const group = myGroups.find((g) => Number(g.id) === Number(msg.group_id));
  if (group && group.hidden_at && msg.user_id !== currentUser.id) {
    group.hidden_at = null;
    patchMineGroup(group.id, { hidden_at: null });
    sb.rpc('chat_set_hidden', { p_group_id: group.id, p_hidden: false })
      .then(({ error }) => { if (error) console.error('Unhide error:', error); });
  }
  if (Number(msg.group_id) === currentGroupId) {
    addMessageToUI(msg);
    if (msg.user_id !== currentUser.id) {
      // 開いていてもバックグラウンド中は読んだ扱いにしない。
      if (!document.hidden) markGroupRead(currentGroupId);
      else loadUnread();
    }
  } else {
    loadUnread();
  }
  renderGroups();
}

async function loadGroups() {
  if (!currentUser) return;
  try {
    const [mineRes, allRes] = await Promise.all([
      sb.from('chat_group_members')
        .select('pinned_at, muted_at, hidden_at, can_view, can_send, can_invite, can_manage, chat_groups(id, group_name, created_at, created_by, icon_url, is_direct, direct_key, store_key, is_store_room, is_admin_notice_room, trashed_at)')
        .eq('user_id', currentUser.id),
      sb.from('chat_groups')
        .select('id, group_name, created_at, created_by, icon_url, is_direct, direct_key, store_key, is_store_room, is_admin_notice_room, trashed_at')
        .order('created_at', { ascending: false })
    ]);

    if (mineRes.error) throw mineRes.error;
    if (allRes.error) throw allRes.error;

    const mine = (mineRes.data || [])
      .filter((row) => row.can_view === true)
      .map((row) => row.chat_groups
        ? Object.assign({}, row.chat_groups, {
            pinned_at: row.pinned_at || null,
            muted_at: row.muted_at || null,
            hidden_at: row.hidden_at || null,
            membership: {
              user_id: currentUser.id,
              group_id: row.chat_groups.id,
              can_view: row.can_view === true,
              can_send: row.can_send === true,
              can_invite: row.can_invite === true,
              can_manage: row.can_manage === true
            }
          })
        : null)
      .filter(Boolean);
    const mineIds = new Set(mine.map((g) => g.id));

    myGroups = mine;
    otherGroups = (allRes.data || []).filter((g) => !mineIds.has(g.id) && !g.is_direct && !g.is_admin_notice_room && !g.trashed_at);
    if (currentGroupId && !mineIds.has(currentGroupId)) closeChat();
    await attachDirectPeers(myGroups);
    await loadLastMessages();
    await loadMemberCounts();
    renderGroups();
    loadUnread();
    syncGlobalCapabilityUi();
  } catch (error) {
    console.error('Load groups error:', error);
  }
}
