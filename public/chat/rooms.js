'use strict';

function captureRequestedGroup() {
  try {
    const url = new URL(location.href);
    const raw = url.searchParams.get('group');
    const groupId = Number(raw);
    if (Number.isSafeInteger(groupId) && groupId > 0) pendingOpenGroupId = groupId;
    if (raw) {
      url.searchParams.delete('group');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch (error) {
    console.error('Requested group URL error:', error);
  }
}

async function openRequestedGroup() {
  if (!pendingOpenGroupId) return;
  const requested = pendingOpenGroupId;
  pendingOpenGroupId = null;
  const group = myGroups.find((item) => Number(item.id) === requested);
  if (group) await selectGroup(group);
}

async function attachDirectPeers(groups) {
  const dms = (groups || []).filter((g) => g.is_direct);
  if (!dms.length) return;
  try {
    const { data, error } = await sb
      .from('chat_group_members')
      .select('group_id, user_id, chat_users(id, username, icon_url, is_bot, store_key)')
      .in('group_id', dms.map((g) => g.id));
    if (error) throw error;
    const peers = {};
    (data || []).forEach((row) => {
      if (row.user_id === currentUser.id || !row.chat_users) return;
      peers[row.group_id] = row.chat_users;
    });
    groups.forEach((g) => {
      if (g.is_direct) g.peer = peers[g.id] || null;
    });
  } catch (error) {
    console.error('Direct peer error:', error);
  }
}

function roomTitle(group) {
  if (group && group.is_direct && group.peer) return personName(group.peer);
  return (group && group.group_name) || 'M-talk';
}

function roomIcon(group) {
  if (group && group.is_direct && group.peer) return personIconUrl(group.peer);
  if (group && group.is_store_room) return storeBotLogoForKey(group.store_key) || group.icon_url;
  return group && group.icon_url;
}

// ルームのアイコンが店舗Botのロゴとして出ているときだけ bot バッジを付ける。
// 通常のグループが店舗ロゴを選んだ場合はBotではないので付けない。
function roomAvatarIsBot(group) {
  if (!group) return false;
  if (group.is_direct && group.peer) return isStoreBot(group.peer);
  return !!(group.is_store_room && storeBotLogoForKey(group.store_key));
}

async function registerDirectFriend(user) {
  if (!user || user.id === currentUser.id) return;
  if (!chatAccessAllows('can_start_direct')) {
    alert('1対1トークを開始する権限がありません');
    return;
  }
  if (!sharesAffiliationWith(user)) {
    alert('1対1トークは所属店舗が同じ相手だけ始められます');
    return;
  }
  try {
    const { data, error } = await sb.rpc('chat_open_direct', { p_other: user.id });
    if (error) throw error;
    await loadGroups();
    const group = myGroups.find((g) => Number(g.id) === Number(data));
    if (group) selectGroup(group);
  } catch (error) {
    alert(error.message || '友だちの登録に失敗しました');
  }
}

async function loadLastMessages() {
  const ids = myGroups.map((g) => g.id);
  if (!ids.length) {
    lastMessages = {};
    return;
  }
  try {
    const { data, error } = await sb
      .from('chat_messages')
      .select('group_id, content, created_at, username, user_id')
      .in('group_id', ids)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const next = {};
    (data || []).forEach((row) => {
      if (!next[row.group_id]) next[row.group_id] = row;
    });
    lastMessages = next;
  } catch (error) {
    console.error('Load last messages error:', error);
  }
}

async function loadUnread() {
  if (!currentUser) return;
  try {
    const { data, error } = await sb.rpc('chat_unread_counts');
    if (error) throw error;

    const counts = {};
    (data || []).forEach((row) => { counts[row.group_id] = Number(row.unread_count) || 0; });
    unread = counts;
    renderGroups();
    updateTitle();
    await syncAppBadge();
  } catch (error) {
    console.error('Load unread error:', error);
  }
}

async function markGroupRead(groupId) {
  if (!currentUser || !groupId) return;
  // 先に画面を軽くしつつ、DB保存後は必ずサーバーの未読集計へ戻す。
  // upsert失敗時も同じ再取得を行い、画面だけ既読になる乖離を残さない。
  delete unread[groupId];
  renderGroups();
  updateTitle();
  await syncAppBadge();
  try {
    const { error } = await sb.from('chat_read_states').upsert({
      group_id: groupId,
      user_id: currentUser.id,
      last_read_at: new Date().toISOString()
    }, { onConflict: 'group_id,user_id' });
    if (error) throw error;
  } catch (error) {
    console.error('Mark read error:', error);
  } finally {
    await loadUnread();
  }
}

function updateTitle() {
  const total = unreadTotal();
  document.title = total > 0 ? `(${total}) M-talk` : 'M-talk';
}

function setTalkTab(tab) {
  talkTab = tab;
  document.querySelectorAll('.talk-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  const search = $('talkSearch');
  if (tab === 'users') {
    search.placeholder = '登録ユーザーを検索';
    $('fab').classList.add('hidden');
    loadRegisteredUsers();
  } else if (tab === 'bots') {
    search.placeholder = 'Botを検索';
    $('fab').classList.add('hidden');
    loadRegisteredUsers();
  } else if (tab === 'friends') {
    search.placeholder = '友だちを検索';
    $('fab').classList.add('hidden');
    loadRegisteredUsers();
  } else if (tab === 'trash') {
    search.placeholder = 'ゴミ箱を検索';
    $('fab').classList.add('hidden');
    renderGroups();
  } else {
    search.placeholder = 'トークルームとメッセージ検索';
    $('fab').classList.remove('hidden');
    renderGroups();
  }
  // タブを移ると検索の対象が変わるので、本文ヒットは出し直す。
  const query = (search.value || '').trim();
  if (tab === 'users' || tab === 'bots') renderMessageSearch('');
  else runMessageSearch(query);
  syncGlobalCapabilityUi();
}

async function loadRegisteredUsers() {
  if (!currentUser) return;
  if (!chatAccessAllows('can_browse_users')) {
    registeredUsers = [];
    renderGroups();
    return;
  }
  try {
    const { data, error } = await sb
      .from('chat_users')
      .select(CHAT_USER_COLUMNS)
      .is('bot_deleted_at', null)
      .order('username');
    if (error) throw error;
    registeredUsers = data || [];
    await loadUserStores();
  } catch (error) {
    console.error('Load users error:', error);
    registeredUsers = [];
  }
  renderGroups();
}

function toggleUserSelect(userId) {
  if (!chatAccessAllows('can_browse_users')) return;
  if (userId === currentUser.id) return;
  if (selectedUserIds.has(userId)) selectedUserIds.delete(userId);
  else selectedUserIds.add(userId);
  renderRegisteredUsers();
}

function isDirectoryUser(user) {
  if (talkTab === 'bots') return isStoreBot(user) && sharesAffiliationWith(user);
  return !isBotUser(user);
}

function directoryUsers() {
  const q = ($('talkSearch').value || '').trim().toLowerCase();
  return (registeredUsers || []).filter((u) => {
    if (!isDirectoryUser(u)) return false;
    if (!q) return true;
    return String(u.username || '').toLowerCase().includes(q)
      || personName(u).toLowerCase().includes(q);
  });
}

function renderRegisteredUsers() {
  const list = $('registeredUsersList');
  list.innerHTML = '';
  if (talkTab === 'bots') {
    $('userInviteBar').classList.add('hidden');
    const users = directoryUsers();
    if (!users.length) {
      list.innerHTML = '<div class="empty-note">所属店舗の店舗Botはいません</div>';
      return;
    }
    const canInviteSomewhere = myGroups.some((group) => !group.is_direct && !group.trashed_at && canCurrentUserInvite(group));
    users.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'user-row';
      const iconUrl = personIconUrl(user);
      row.innerHTML = `
        <div class="talk-avatar" style="background:${iconUrl ? '#2c2c2e' : avatarStyle(personAvatarKey(user))}">${avatarHtml(personAvatarKey(user), iconUrl, isStoreBot(user))}</div>
        <div class="talk-body">
          <div class="group-item-name"><span>${escapeHtml(personName(user))}</span>${botMarkHtml()}</div>
          <div class="group-item-info">${canInviteSomewhere ? '1対1、またはルームへ招待' : '所属店舗の店舗Bot'}</div>
        </div>
      `;
      const talkBtn = document.createElement('button');
      talkBtn.className = 'join-btn';
      talkBtn.textContent = '1対1';
      const sameStore = sharesAffiliationWith(user);
      talkBtn.disabled = !chatAccessAllows('can_start_direct') || !sameStore;
      talkBtn.title = !chatAccessAllows('can_start_direct')
        ? '1対1トークを開始する権限がありません'
        : (sameStore ? '' : '所属店舗が同じ相手だけ1対1を始められます');
      talkBtn.onclick = (e) => { e.stopPropagation(); registerDirectFriend(user); };
      row.appendChild(talkBtn);
      if (canInviteSomewhere) {
        const inviteBtn = document.createElement('button');
        inviteBtn.className = 'join-btn';
        inviteBtn.textContent = '招待';
        inviteBtn.onclick = (e) => {
          e.stopPropagation();
          selectedUserIds = new Set([user.id]);
          openUserInviteTarget();
        };
        row.appendChild(inviteBtn);
      }
      list.appendChild(row);
    });
    return;
  }

  const users = directoryUsers();
  if (!users.length) {
    list.innerHTML = '<div class="empty-note">登録ユーザーはいません</div>';
  } else {
    users.forEach((user) => {
      const mine = user.id === currentUser.id;
      const selected = selectedUserIds.has(user.id);
      const row = document.createElement('div');
      row.className = 'user-row' + (selected ? ' selected' : '');
      row.innerHTML = `
        ${mine ? '' : '<div class="user-check"></div>'}
        <div class="talk-avatar" style="background:${user.icon_url ? '#2c2c2e' : avatarStyle(user.username)}">${avatarHtml(user.username, user.icon_url, isStoreBot(user))}</div>
        <div class="talk-body">
          <div class="group-item-name"><span>${escapeHtml(user.username)}</span>${mine ? '（自分）' : ''}</div>
        </div>
      `;
      if (!mine) row.onclick = () => toggleUserSelect(user.id);
      list.appendChild(row);
    });
  }

  const count = [...selectedUserIds].filter((id) => (
    (registeredUsers || []).some((u) => u.id === id && isDirectoryUser(u))
  )).length;
  $('userInviteCount').textContent = `${count}人を選択`;
  $('userInviteBar').classList.toggle('hidden', count === 0);
}

function openUserInviteTarget() {
  if (!selectedUserIds.size) return;
  if (!chatAccessAllows('can_browse_users')) {
    alert('登録ユーザーを参照する権限がありません');
    return;
  }
  const invitingBots = [...selectedUserIds].some((id) => (
    (registeredUsers || []).some((u) => u.id === id && isStoreBot(u))
  ));
  const newGroupBtn = $('inviteNewGroupBtn');
  if (newGroupBtn) newGroupBtn.classList.toggle('hidden', invitingBots);
  const list = $('userInviteGroupList');
  list.innerHTML = '';
  const rooms = myGroups.filter((group) => !group.is_direct && canCurrentUserInvite(group));
  if (!rooms.length) {
    list.innerHTML = invitingBots
      ? '<div class="empty-note">招待できるルームがありません</div>'
      : '<div class="empty-note">先にグループを作るか、下から新しいグループを作って招待してください</div>';
  } else {
    rooms.forEach((group) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'target-group';
      button.textContent = group.group_name;
      button.onclick = () => inviteSelectedToGroup(group);
      list.appendChild(button);
    });
  }
  $('userInviteTarget').classList.remove('hidden');
}

function closeUserInviteTarget() {
  $('userInviteTarget').classList.add('hidden');
}

async function inviteSelectedToGroup(group) {
  if (!group || !selectedUserIds.size) return;
  if (group.is_direct) {
    alert('1対1トークには招待できません');
    return;
  }
  if (!canCurrentUserInvite(group)) {
    alert('このルームへ招待する権限がありません');
    return;
  }
  try {
    const userIds = [...selectedUserIds]
      .filter((id) => (registeredUsers || []).some((u) => u.id === id && isDirectoryUser(u)))
    if (!userIds.length) return;
    const { error } = await sb.rpc('chat_add_members', {
      p_group_id: group.id,
      p_user_ids: userIds
    });
    if (error) throw error;
    selectedUserIds = new Set();
    closeUserInviteTarget();
    renderRegisteredUsers();
    await loadGroups();
    selectGroup(group);
    alert(group.group_name + ' に招待しました');
  } catch (error) {
    alert(error.message || '招待に失敗しました');
  }
}

async function inviteSelectedToNewGroup() {
  if (!selectedUserIds.size) return;
  if (!chatAccessAllows('can_create_group')) {
    alert('グループを作成する権限がありません');
    return;
  }
  if ([...selectedUserIds].some((id) => (registeredUsers || []).some((u) => u.id === id && isBotUser(u)))) {
    alert('Botは新しいグループのメンバーにできません。既存のルームへ招待するか、1対1で話してください。');
    return;
  }
  const name = prompt('新しいグループ名');
  if (!name || !name.trim()) return;
  try {
    const memberIds = [...selectedUserIds]
      .filter((id) => (registeredUsers || []).some((user) => user.id === id && isDirectoryUser(user)));
    const { data, error } = await sb.rpc('chat_create_group', {
      p_group_name: name.trim(),
      p_member_ids: memberIds
    });
    if (error) throw error;
    const groupId = Number(data?.group_id ?? data?.id ?? data);
    selectedUserIds = new Set();
    closeUserInviteTarget();
    await loadGroups();
    const group = myGroups.find((item) => Number(item.id) === groupId);
    if (group) selectGroup(group);
    renderRegisteredUsers();
  } catch (error) {
    alert(error.message || 'グループ作成に失敗しました');
  }
}

function toggleNewGroup() {
  if (!chatAccessAllows('can_create_group')) {
    alert('グループを作成する権限がありません');
    return;
  }
  $('newGroupPop').classList.toggle('hidden');
  if (!$('newGroupPop').classList.contains('hidden')) {
    $('newGroupInput').focus();
  }
}

function inviteLink(token) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('invite', token);
  return url.toString();
}

function captureInviteFromUrl() {
  try {
    const token = new URLSearchParams(location.search).get('invite');
    if (token) {
      sessionStorage.setItem(INVITE_KEY, token);
      const clean = new URL(location.href);
      clean.searchParams.delete('invite');
      history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
    }
  } catch (error) {
    console.error('Invite URL error:', error);
  }
}

async function consumeInvite() {
  let token = '';
  try { token = sessionStorage.getItem(INVITE_KEY) || ''; } catch (_) {}
  if (!token || !currentUser) return;
  try { sessionStorage.removeItem(INVITE_KEY); } catch (_) {}

  const { data, error } = await sb.rpc('chat_join_by_invite', { p_token: token });
  if (error) {
    alert(error.message || '招待リンクが無効です');
    return;
  }
  await loadGroups();
  const group = myGroups.find((g) => Number(g.id) === Number(data));
  if (group) selectGroup(group);
}

function closeInvite() {
  $('inviteOverlay').classList.add('hidden');
}

function openRoomSettings(groupId) {
  const id = Number(groupId || (talkMenuGroup && talkMenuGroup.id) || currentGroupId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  const group = findMineGroup(id);
  if (!canCurrentUserManage(group)) {
    alert('このルームを管理する権限がありません');
    return;
  }
  if (isGroupTrashed(group)) {
    alert('ゴミ箱のルームは設定できません。復元してから開いてください。');
    return;
  }
  closeTalkContextMenu();
  closeInvite();
  const url = new URL('room_settings.html', window.location.href);
  url.searchParams.set('from', 'chat');
  url.searchParams.set('group_id', String(id));
  url.searchParams.set('v', '202608201340');
  window.open(url.href, '_blank', 'noopener');
}

// 1対1であることに加えて、店舗Botがいること。店舗が決まらないルームでは
// サーバ側が必ず弾くので、入口の時点で出さない。
// is_direct（自動作成のDMかどうか）ではなく「人間メンバーが自分1人だけか」で見る。
// 利用者が自分でBotを招待して作った2人部屋（is_direct=false）も対象にするため。
// サーバ側(issueChatJournalLoginLink)も同じ基準で判定する。
function currentRoomHasOnlyMeAndBots() {
  const humans = groupMembers.filter((user) => user && !user.is_bot);
  return humans.length === 1 && humans[0] && humans[0].id === currentUser?.id;
}

function currentRoomAllowsJournalAi() {
  if (!chatAccessAllows('can_use_journal_ai')) return false;
  if (!currentRoomHasOnlyMeAndBots()) return false;
  return groupMembers.some((user) => user && user.is_bot && user.store_key);
}

// 電子ジャーナルAIは、自分以外の人間がいないトーク専用。売上の質問と回答が
// 他の参加者に見えるのを避ける。
function openJournalAi() {
  const id = Number(currentGroupId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (!currentRoomHasOnlyMeAndBots()) {
    alert('電子ジャーナルへの質問は、自分以外の人がいないトークでのみ使えます。');
    return;
  }
  if (!currentRoomAllowsJournalAi()) {
    alert('このトークには店舗Botがいないため、電子ジャーナルへ質問できません。\n店舗Botとのトークから開いてください。');
    return;
  }
  // M-talk 内の画面を開く。中身はジャーナルレポートのAIチャットを
  // そのまま埋め込むので、答えは向こうのシステムと同一になる。
  const url = new URL('mtalk_journal_ai.html', window.location.href);
  url.searchParams.set('from', 'chat');
  url.searchParams.set('group_id', String(id));
  window.location.href = url.href;
}

function openReservationSchedule(groupId, tab) {
  const id = Number(groupId || (talkMenuGroup && talkMenuGroup.id) || currentGroupId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (!canCurrentUserManage(findMineGroup(id))) {
    alert('予定・予約を管理する権限がありません');
    return;
  }
  closeTalkContextMenu();
  const url = new URL('mtalk_schedule.html', window.location.href);
  url.searchParams.set('from', 'chat');
  url.searchParams.set('group_id', String(id));
  if (tab === 'events' || tab === 'reservations') url.searchParams.set('tab', tab);
  window.location.href = url.href;
}

async function openInvite() {
  if (!currentGroupId) return;
  const current = myGroups.find((g) => g.id === currentGroupId);
  if (current && current.is_direct) {
    alert('1対1トークには招待できません');
    return;
  }
  if (!canCurrentUserInvite(current)) {
    alert('このルームへ招待する権限がありません');
    return;
  }
  $('inviteOverlay').classList.remove('hidden');
  const leaveBtn = document.querySelector('.invite-leave');
  if (leaveBtn) leaveBtn.classList.toggle('hidden', !!(current && current.is_store_room));
  if ($('inviteRoomSettingsBtn')) $('inviteRoomSettingsBtn').classList.toggle('hidden', !canCurrentUserManage(current));
  $('inviteUrl').value = '作成中...';
  $('inviteSearch').value = '';
  try {
    const { data, error } = await sb.rpc('chat_ensure_invite', { p_group_id: currentGroupId });
    if (error) throw error;
    inviteToken = data;
    $('inviteUrl').value = inviteLink(inviteToken);
  } catch (error) {
    $('inviteUrl').value = '';
    alert(error.message || '招待リンクを作れませんでした');
    return;
  }
  await loadInviteLists();
}

async function loadInviteLists() {
  if (!currentGroupId) return;
  try {
    const [memberRes, userRes] = await Promise.all([
      sb.from('chat_group_members')
        .select('user_id, chat_users(id, username, icon_url, is_bot, store_key)')
        .eq('group_id', currentGroupId),
      sb.from('chat_users').select(CHAT_USER_COLUMNS).is('bot_deleted_at', null).order('username')
    ]);
    if (memberRes.error) throw memberRes.error;
    if (userRes.error) throw userRes.error;
    inviteMembers = (memberRes.data || []).map((row) => row.chat_users).filter(Boolean);
    const memberIds = new Set(inviteMembers.map((u) => u.id));
    invitePeople = (userRes.data || []).filter((u) => (
      u.id !== currentUser.id
      && !memberIds.has(u.id)
      && !isReservationBot(u)
      && sharesAffiliationWith(u)
    ));
    renderInviteLists();
  } catch (error) {
    console.error('Invite list error:', error);
  }
}

function renderInviteLists() {
  const members = $('inviteMemberList');
  members.innerHTML = '';
  if (!inviteMembers.length) {
    members.innerHTML = '<div class="empty-note">メンバーはいません</div>';
  } else {
    const current = myGroups.find((g) => Number(g.id) === Number(currentGroupId));
    const canKick = current && !current.is_direct && canCurrentUserManage(current);
    inviteMembers.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'invite-person';
      const mine = String(user.id) === String(currentUser.id);
      const bot = isBotUser(user);
      const lockedBot = isReservationBot(user) || (isStoreBot(user) && current && current.is_store_room);
      const iconUrl = personIconUrl(user);
      row.innerHTML = `
        <div class="talk-avatar" style="width:36px;height:36px;font-size:14px;background:${iconUrl ? '#2c2c2e' : avatarStyle(personAvatarKey(user))}">${avatarHtml(personAvatarKey(user), iconUrl, isStoreBot(user))}</div>
        <div>${escapeHtml(personName(user))}${mine ? '（自分）' : ''}${bot ? botMarkHtml() : ''}</div>
      `;
      if (canKick && !mine && !lockedBot) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'kick-btn';
        button.textContent = '退出させる';
        button.onclick = () => kickMember(user);
        row.appendChild(button);
      }
      members.appendChild(row);
    });
  }
  renderInvitePeople();
}

function renderInvitePeople() {
  const q = ($('inviteSearch').value || '').trim().toLowerCase();
  const list = $('invitePeopleList');
  list.innerHTML = '';
  const people = invitePeople.filter((u) => (
    !q
    || String(u.username || '').toLowerCase().includes(q)
    || personName(u).toLowerCase().includes(q)
  ));
  if (!people.length) {
    list.innerHTML = '<div class="empty-note">招待できる友だちはいません</div>';
    return;
  }
  people.forEach((user) => {
    const row = document.createElement('div');
    row.className = 'invite-person';
    const iconUrl = personIconUrl(user);
    row.innerHTML = `
      <div class="talk-avatar" style="width:36px;height:36px;font-size:14px;background:${iconUrl ? '#2c2c2e' : avatarStyle(personAvatarKey(user))}">${avatarHtml(personAvatarKey(user), iconUrl, isStoreBot(user))}</div>
      <div>${escapeHtml(personName(user))}${isBotUser(user) ? botMarkHtml() : ''}</div>
    `;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '招待';
    button.onclick = () => inviteUser(user);
    row.appendChild(button);
    list.appendChild(row);
  });
}

async function kickMember(user) {
  if (!currentGroupId || !user) return;
  if (!canCurrentUserManage(currentGroup())) {
    alert('メンバーを退出させる権限がありません');
    return;
  }
  if (!confirm(`${personName(user)} をルームから退出させますか？`)) return;
  try {
    const { error } = await sb.rpc('chat_kick_member', {
      p_group_id: currentGroupId,
      p_user_id: user.id
    });
    if (error) throw error;
    await loadInviteLists();
    await loadGroupContext(currentGroupId);
    showNotice(`${personName(user)} を退出しました`);
  } catch (error) {
    alert(error.message || '退出させられませんでした');
  }
}

async function leaveCurrentRoom() {
  const group = myGroups.find((g) => Number(g.id) === Number(currentGroupId));
  if (!group) return;
  closeInvite();
  try {
    await leaveTalk(group);
  } catch (error) {
    alert(error.message || '退出に失敗しました');
  }
}

async function inviteUser(user) {
  if (!currentGroupId || !user) return;
  if (!canCurrentUserInvite(currentGroup())) {
    alert('このルームへ招待する権限がありません');
    return;
  }
  try {
    const { error } = await sb.rpc('chat_add_members', {
      p_group_id: currentGroupId,
      p_user_ids: [user.id]
    });
    if (error) throw error;
    await loadInviteLists();
    await loadGroupContext(currentGroupId);
  } catch (error) {
    alert(error.message || '招待に失敗しました');
  }
}

async function copyInvite() {
  const value = $('inviteUrl').value.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    alert('招待リンクをコピーしました');
  } catch (_) {
    $('inviteUrl').select();
    document.execCommand('copy');
    alert('招待リンクをコピーしました');
  }
}

async function shareInvite() {
  const value = $('inviteUrl').value.trim();
  if (!value) return;
  const name = $('chatGroupName').textContent || 'M-talk';
  if (navigator.share) {
    try {
      await navigator.share({ title: name, text: name + ' に招待します', url: value });
      return;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }
  }
  copyInvite();
}

async function rotateInvite() {
  if (!currentGroupId) return;
  if (!canCurrentUserInvite(currentGroup())) {
    alert('招待リンクを再発行する権限がありません');
    return;
  }
  if (!confirm('今の招待リンクは使えなくなります。再発行しますか？')) return;
  try {
    const { data, error } = await sb.rpc('chat_rotate_invite', { p_group_id: currentGroupId });
    if (error) throw error;
    inviteToken = data;
    $('inviteUrl').value = inviteLink(inviteToken);
    alert('新しい招待リンクを発行しました');
  } catch (error) {
    alert(error.message || '再発行に失敗しました');
  }
}

function closeChat() {
  if (editingMessage) cancelMessageEdit();
  if (currentGroupId) snapshotRoomView(currentGroupId);
  currentGroupId = null;
  currentRoomMembership = null;
  hideMemberStrip();
  document.body.classList.remove('chat-open');
  $('placeholder').classList.remove('hidden');
  $('chatHeader').classList.add('hidden');
  $('messagesWrap').classList.add('hidden');
  $('inputArea').classList.add('hidden');
  if ($('trashBanner')) $('trashBanner').classList.add('hidden');
  if ($('scheduleBar')) $('scheduleBar').classList.add('hidden');
  closeScheduleSend();
  closeSendMode();
  $('stickerPicker')?.classList.add('hidden');
  resetMessageView();
  renderGroups();
}

function avatarStyle(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// bot バッジは「その相手が Bot か」で決める。アイコンのパスでは判定しない。
// 店舗ロゴは一般ユーザーやグループも選べるため、パスで見ると人に bot が付く。
function avatarHtml(name, iconUrl, showBotMark = false) {
  const letter = escapeHtml((name || '?').trim().slice(0, 1) || '?');
  if (iconUrl) {
    return `<img src="${escapeHtml(iconUrl)}" alt="" loading="lazy" decoding="async">${showBotMark ? '<span class="store-bot-avatar-mark" aria-hidden="true">bot</span>' : ''}`;
  }
  return letter;
}

function paintAvatar(el, name, iconUrl, showBotMark = false) {
  if (!el) return;
  el.style.background = iconUrl ? '#2c2c2e' : avatarStyle(name || '?');
  el.innerHTML = avatarHtml(name, iconUrl, showBotMark);
}

function roomHasStoreBot(group) {
  if (group && group.is_store_room) return true;
  return (groupMembers || []).some(isStoreBot);
}

function paintChatHeader(group) {
  if (!group) return;
  $('chatGroupName').textContent = roomTitle(group);
  paintAvatar($('chatGroupAvatar'), roomTitle(group), roomIcon(group), roomAvatarIsBot(group));
  if ($('chatGroupAvatar')) $('chatGroupAvatar').disabled = !canCurrentUserManage(group);
  if ($('inviteHeaderBtn')) $('inviteHeaderBtn').classList.toggle('hidden', !!group.is_direct || !canCurrentUserInvite(group));
  // スマホ・タブレット幅ではPC専用のShift+Enter注釈を出さず、1行で読める文言にする。
  const compactComposer = isMobileLayout() || window.innerWidth <= 1024;
  if ($('messageInput') && roomHasStoreBot(group)) {
    $('messageInput').placeholder = compactComposer
      ? 'メッセージを入力（#メモ対応）'
      : 'メッセージ（#メモ で資料保存・Shift+Enterで改行）';
  } else if ($('messageInput')) {
    $('messageInput').placeholder = compactComposer
      ? 'メッセージを入力'
      : 'メッセージ（Shift+Enterで改行）';
  }
  // プレースホルダーが折り返す幅では、注釈全体が見える行数まで入力欄を広げる。
  resizeComposer();
  updateChatHeaderMeta();
}

function isMultiMemberGroup(group) {
  return !!(group && !group.is_direct && groupMembers.length >= 2);
}

function hideMemberStrip() {
  memberStripOpen = false;
  const strip = $('memberStrip');
  if (strip) strip.classList.add('hidden');
}

function toggleMemberStrip() {
  const group = myGroups.find((g) => Number(g.id) === Number(currentGroupId));
  if (!isMultiMemberGroup(group)) return;
  memberStripOpen = !memberStripOpen;
  $('memberStrip').classList.toggle('hidden', !memberStripOpen);
}

function renderMemberStrip() {
  const strip = $('memberStrip');
  if (!strip) return;
  strip.innerHTML = '';
  groupMembers.forEach((user) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'member-strip-item';
    item.title = personName(user) + (isBotUser(user) ? '（Bot）' : '');
    const iconUrl = personIconUrl(user);
    item.innerHTML = `<div class="talk-avatar" style="background:${iconUrl ? '#2c2c2e' : avatarStyle(personAvatarKey(user))}">${avatarHtml(personAvatarKey(user), iconUrl, isStoreBot(user))}</div>`;
    strip.appendChild(item);
  });
}

function updateChatHeaderMeta() {
  const group = myGroups.find((g) => Number(g.id) === Number(currentGroupId));
  const countEl = $('chatMemberCount');
  const titleBtn = $('chatTitleBtn');
  const show = isMultiMemberGroup(group);
  if (countEl) {
    countEl.textContent = show ? `(${groupMembers.length})` : '';
    countEl.classList.toggle('hidden', !show);
  }
  if (titleBtn) titleBtn.disabled = !show;
  if (show) renderMemberStrip();
  else hideMemberStrip();
}

function renderUserAvatars() {
  const name = currentUser ? currentUser.username : '?';
  const icon = currentUser && currentUser.icon_url;
  paintAvatar($('userAvatar'), name, icon);
  paintAvatar($('talkUserAvatar'), name, icon);
  paintAvatar($('headerUserAvatar'), name, icon);
  paintAvatar($('profileIconPreview'), name || '?', pendingUserIconFile ? null : (pendingPresetUserIconUrl || icon));
}

// アバター表示は最大80px程度。Retina分を含む192pxへ縮小し、WebPで保存する。
const ICON_SIZE = 192;
const ICON_SOURCE_MAX_BYTES = 15 * 1024 * 1024;

function assertIconFile(file) {
  if (!file) throw new Error('ファイルを選んでください');
  const type = String(file.type || '');
  const name = String(file.name || '').toLowerCase();
  if (type === 'image/svg+xml' || name.endsWith('.svg')) {
    throw new Error('SVGは安全のため使用できません。JPEG / PNG / WebP / GIF を選んでください');
  }
  const okType = /^image\/(jpeg|png|webp|gif)$/.test(type);
  const okName = /\.(jpe?g|png|webp|gif)$/.test(name);
  if (!okType && !okName) {
    throw new Error('JPEG / PNG / WebP / GIF を選んでください');
  }
  if (file.size > ICON_SOURCE_MAX_BYTES) throw new Error('画像は 15MB 以下にしてください');
}

function loadIconImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

async function resizeIconFile(file) {
  const img = await loadIconImage(file);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (!width || !height) throw new Error('画像サイズを取得できませんでした');

  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  const src = Math.min(width, height);
  const sx = (width - src) / 2;
  const sy = (height - src) / 2;
  ctx.drawImage(img, sx, sy, src, src, 0, 0, ICON_SIZE, ICON_SIZE);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
  if (!blob) throw new Error('画像の変換に失敗しました');
  return new File([blob], 'icon.webp', { type: 'image/webp' });
}

async function prepareIconFile(file) {
  assertIconFile(file);
  return resizeIconFile(file);
}

async function uploadIcon(folder, file) {
  const prepared = await prepareIconFile(file);
  const path = `${folder}/icon.webp`;
  const { error } = await sb.storage.from('chat-icons').upload(path, prepared, {
    upsert: true,
    contentType: 'image/webp',
    cacheControl: '31536000'
  });
  if (error) throw error;
  const { data } = sb.storage.from('chat-icons').getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;
}

function openAccountMenu() {
  const nameEl = $('accountMenuUser');
  if (nameEl) nameEl.textContent = (currentUser && currentUser.username) || 'アカウント';
  syncAccountAdminLink();
  $('accountMenu').classList.remove('hidden');
}

function closeAccountMenu() {
  $('accountMenu').classList.add('hidden');
}

async function openProfileSettings() {
  closeAccountMenu();
  try {
    await loadUserStores();
    await loadPendingStoreRequest();
  } catch (error) {
    console.error('Profile settings load error:', error);
  }
  const current = myStoreKeys();
  $('profileSettingsCurrent').textContent = current.length
    ? `現在の所属: ${formatStoreLabels(current)}`
    : '現在の所属: 未設定。設定して管理者の許可を受けてください。';
  const pending = pendingStoreRequest;
  const pendingEl = $('profileSettingsPending');
  const saveBtn = $('profileSettingsSave');
  const fullAdmin = currentChatAccess?.is_full_admin === true;
  if (fullAdmin) {
    pendingEl.textContent = '全権管理者として全店舗に所属しています。所属店舗は自動同期されるため、ここでは変更できません。';
    pendingEl.classList.remove('hidden');
    saveBtn.disabled = true;
    saveBtn.textContent = '全店舗所属';
    renderStorePicker('settingsStorePick', current);
    $('settingsStorePick').querySelectorAll('input').forEach((input) => { input.disabled = true; });
  } else if (pending && pending.kind === 'change') {
    pendingEl.textContent = `変更を申請中です（${formatStoreLabels(pending.requested_store_keys || [])}）。許可されるまで今の所属のままです。`;
    pendingEl.classList.remove('hidden');
    saveBtn.disabled = true;
    saveBtn.textContent = '申請中';
    renderStorePicker('settingsStorePick', pending.requested_store_keys || current);
  } else {
    pendingEl.textContent = '';
    pendingEl.classList.add('hidden');
    saveBtn.disabled = false;
    saveBtn.textContent = '変更を申請する';
    renderStorePicker('settingsStorePick', current);
  }
  $('profileSettingsOverlay').classList.remove('hidden');
}

function closeProfileSettings() {
  $('profileSettingsOverlay').classList.add('hidden');
}

async function submitStoreChange() {
  if (currentChatAccess?.is_full_admin === true) {
    alert('全権管理者は全店舗へ自動所属するため、所属店舗は変更できません');
    return;
  }
  const keys = selectedStoreKeys('settingsStorePick');
  if (!keys.length) {
    alert('所属店舗を1つ以上選んでください');
    return;
  }
  const saveBtn = $('profileSettingsSave');
  saveBtn.disabled = true;
  try {
    const { error } = await sb.rpc('chat_request_store_change', { p_store_keys: keys });
    if (error) throw error;
    await loadPendingStoreRequest();
    alert('所属店舗の変更を申請しました。管理者の許可後に反映されます。');
    await openProfileSettings();
  } catch (error) {
    console.error('Store change request error:', error);
    alert(error.message || '申請に失敗しました');
    saveBtn.disabled = false;
  }
}

async function openPresetIconPicker(target = 'user') {
  iconPickerTarget = target === 'group' ? 'group' : 'user';
  closeAccountMenu();
  $('profileIconPickerTitle').textContent = iconPickerTarget === 'group'
    ? 'トークルームのアイコンを選ぶ'
    : 'アイコンを選ぶ';
  $('profileIconOverlay').classList.remove('hidden');
  const grid = $('profileIconGrid');
  grid.innerHTML = '<p class="login-note">読み込み中…</p>';
  try {
    if (!profileIconCatalog) {
      const response = await fetch('profile-icons/catalog.json', { cache: 'force-cache' });
      if (!response.ok) throw new Error('アイコン一覧を読み込めませんでした');
      profileIconCatalog = await response.json();
    }
    grid.innerHTML = [
      '<p class="profile-icon-group-label">イラスト</p>',
      ...profileIconCatalog.map(iconOptionHtml),
      '<p class="profile-icon-group-label">店舗ロゴ</p>',
      ...storeIconOptions().map(iconOptionHtml)
    ].join('');
  } catch (error) {
    grid.innerHTML = `<p class="error">${escapeHtml(error.message || error)}</p>`;
  }
}

// 店舗ロゴは STORE_BOT_LOGOS を唯一の出所にする。カタログへ複製すると
// 店舗の追加時に二重管理になり、表示名も実際の店舗名からずれる。
function storeIconOptions() {
  return Object.entries(STORE_BOT_LOGOS).map(([storeKey, path]) => ({
    label: storeDisplayLabel(storeKey),
    path
  }));
}

function iconOptionHtml(icon) {
  return `
      <button type="button" class="profile-icon-option" title="${escapeHtml(icon.label)}"
        aria-label="${escapeHtml(icon.label)}" data-icon-path="${escapeHtml(icon.path)}" onclick="choosePresetIcon(this.dataset.iconPath)">
        <img src="${escapeHtml(icon.path)}" alt="" loading="lazy" decoding="async">
      </button>`;
}

function pickUserIcon() {
  return openPresetIconPicker('user');
}

function closeUserIconPicker() {
  $('profileIconOverlay').classList.add('hidden');
}

function pickUploadedIcon() {
  closeUserIconPicker();
  $(iconPickerTarget === 'group' ? 'groupIconInput' : 'userIconInput').click();
}

async function choosePresetIcon(url) {
  closeUserIconPicker();
  if (iconPickerTarget === 'group') {
    if (!currentGroupId) return;
    if (!canCurrentUserManage(currentGroup())) {
      alert('ルームアイコンを変更する権限がありません');
      return;
    }
    try {
      await applyGroupIconUrl(currentGroupId, url);
    } catch (error) {
      alert(error.message || 'アイコンの保存に失敗しました');
    }
    return;
  }
  pendingUserIconFile = null;
  if (!currentUser) {
    pendingPresetUserIconUrl = url;
    paintAvatar($('profileIconPreview'), $('usernameInput').value.trim() || '?', url);
    return;
  }
  const { error } = await sb.from('chat_users').update({ icon_url: url }).eq('id', currentUser.id);
  if (error) {
    alert(error.message || 'アイコンの保存に失敗しました');
    return;
  }
  currentUser.icon_url = url;
  renderUserAvatars();
}

function pickGroupIcon() {
  if (!currentGroupId) return;
  const group = myGroups.find((g) => g.id === currentGroupId);
  if (group && group.is_direct) return;
  if (isGroupTrashed(group)) return;
  if (!canCurrentUserManage(group)) {
    alert('ルームアイコンを変更する権限がありません');
    return;
  }
  openPresetIconPicker('group');
}

async function saveUserIcon(file) {
  if (!currentUser) return;
  const url = await uploadIcon(`users/${currentUser.id}`, file);
  const { error } = await sb.from('chat_users').update({ icon_url: url }).eq('id', currentUser.id);
  if (error) throw error;
  currentUser.icon_url = url;
  renderUserAvatars();
}

async function saveGroupIcon(groupId, file) {
  const url = await uploadIcon(`groups/${groupId}`, file);
  await applyGroupIconUrl(groupId, url);
  return url;
}

async function applyGroupIconUrl(groupId, url) {
  if (!canCurrentUserManage(findMineGroup(groupId))) throw new Error('ルームアイコンを変更する権限がありません');
  const { error } = await sb.from('chat_groups').update({ icon_url: url }).eq('id', groupId);
  if (error) throw error;
  const apply = (list) => {
    const found = list.find((g) => g.id === groupId);
    if (found) found.icon_url = url;
  };
  apply(myGroups);
  apply(otherGroups);
  renderGroups();
  if (currentGroupId === groupId) {
    const group = myGroups.find((g) => g.id === groupId) || { group_name: $('chatGroupName').textContent, icon_url: url };
    paintAvatar($('chatGroupAvatar'), group.group_name, url);
  }
}

function previewLocalIcon(el, file, fallbackName) {
  if (!el || !file) return;
  const reader = new FileReader();
  reader.onload = () => {
    el.style.background = '#2c2c2e';
    el.innerHTML = `<img src="${reader.result}" alt="">`;
  };
  reader.readAsDataURL(file);
  if (fallbackName) el.title = fallbackName;
}

let talkSearchTimer = 0;

function handleTalkSearchInput() {
  if (talkTab === 'users' || talkTab === 'bots') {
    renderRegisteredUsers();
    return;
  }
  renderGroups();
  // 1文字打つごとに検索を投げない。
  clearTimeout(talkSearchTimer);
  const query = ($('talkSearch').value || '').trim();
  talkSearchTimer = setTimeout(() => runMessageSearch(query), 250);
}

// --- メッセージ本文の検索 ---

// ILIKE のワイルドカードを打ち消す。検索語の % や _ は文字として扱う。
function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// 検索語の前後だけを切り出し、ヒット箇所を <mark> で囲む。
function buildSearchSnippet(content, query) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return escapeHtml(text.slice(0, 80));
  const start = Math.max(0, index - 24);
  const head = start > 0 ? '…' : '';
  const before = text.slice(start, index);
  const hit = text.slice(index, index + query.length);
  const after = text.slice(index + query.length, index + query.length + 56);
  return `${escapeHtml(head + before)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(after)}`;
}

async function runMessageSearch(query) {
  const seq = ++messageSearchSeq;
  const ids = myGroups.map((g) => g.id);
  if (!query || query.length < 2 || !ids.length) {
    messageSearchHits = [];
    renderMessageSearch(query);
    return;
  }

  try {
    const { data, error } = await sb
      .from('chat_messages')
      .select('id, group_id, content, username, created_at')
      .in('group_id', ids)
      .ilike('content', `%${escapeLikePattern(query)}%`)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    // 入力が進んで別の検索が始まっていたら、古い結果は捨てる。
    if (seq !== messageSearchSeq) return;
    messageSearchHits = data || [];
  } catch (error) {
    console.error('Message search error:', error);
    messageSearchHits = [];
  }
  renderMessageSearch(query);
}

function renderMessageSearch(query) {
  const wrap = $('messageSearchWrap');
  const list = $('messageSearchList');
  const show = talkTab !== 'users' && talkTab !== 'bots' && !!query && query.length >= 2;
  wrap.classList.toggle('hidden', !show);
  if (!show) {
    list.innerHTML = '';
    return;
  }

  $('messageSearchLabel').textContent = `メッセージ（${messageSearchHits.length}件）`;
  list.innerHTML = '';
  if (!messageSearchHits.length) {
    list.innerHTML = '<div class="empty-note">一致するメッセージはありません</div>';
    return;
  }

  messageSearchHits.forEach((hit) => {
    const group = myGroups.find((g) => g.id === hit.group_id);
    const row = document.createElement('div');
    row.className = 'search-hit';
    row.innerHTML = `
      <div class="search-hit-top">
        <span class="search-hit-room">${escapeHtml(group ? roomTitle(group) : 'M-talk')}</span>
        <span class="search-hit-time">${formatTalkTime(hit.created_at)}</span>
      </div>
      <div class="search-hit-text">${escapeHtml(hit.username)}: ${buildSearchSnippet(hit.content, query)}</div>
    `;
    row.onclick = () => openMessageAt(hit.group_id, hit.created_at, hit.id);
    list.appendChild(row);
  });
}

// 検索結果をタップしたとき、その発言の前後を読み込んで該当位置まで飛ぶ。
async function openMessageAt(groupId, createdAt, messageId) {
  const group = myGroups.find((g) => g.id === groupId);
  if (!group) return;
  if (currentGroupId && Number(currentGroupId) !== Number(groupId)) {
    snapshotRoomView(currentGroupId);
  }

  currentGroupId = groupId;
  currentRoomMembership = group.membership || null;
  markGroupRead(groupId);
  document.body.classList.add('chat-open');
  syncChatViewport();
  $('placeholder').classList.add('hidden');
  $('chatHeader').classList.remove('hidden');
  $('messagesWrap').classList.remove('hidden');
  hideMemberStrip();
  paintChatHeader(group);
  syncComposerForGroup(group);
  resetMessageView();
  await loadGroupContext(groupId);
  paintChatHeader(group);
  loadScheduledMessages();

  try {
    const [olderRes, newerRes] = await Promise.all([
      sb.from('chat_messages').select(MESSAGE_COLUMNS)
        .eq('group_id', groupId).lte('created_at', createdAt)
        .order('created_at', { ascending: false }).limit(25),
      sb.from('chat_messages').select(MESSAGE_COLUMNS)
        .eq('group_id', groupId).gt('created_at', createdAt)
        .order('created_at', { ascending: true }).limit(25)
    ]);
    if (olderRes.error) throw olderRes.error;
    if (newerRes.error) throw newerRes.error;

    const older = (olderRes.data || []).reverse();
    if (older.length < 25) historyExhausted = true;
    await setMessages(older.concat(newerRes.data || []));
    // 新しい側を取り切れていなければ、この画面は最新まで届いていない。
    viewHasLatest = (newerRes.data || []).length < 25;
    followNewMessages = viewHasLatest;
    updateJumpLatestButton();

    const target = $('messages').querySelector(`[data-message-id="${messageId}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
      requestAnimationFrame(resolveUnloadedLatestGap);
    } else {
      scrollMessagesToBottom();
    }
  } catch (error) {
    console.error('Open message error:', error);
  }

  renderGroups();
}

function matchesQuery(group, preview) {
  const q = ($('talkSearch').value || '').trim().toLowerCase();
  if (!q) return true;
  const title = roomTitle(group).toLowerCase();
  return title.includes(q) || String(preview || '').toLowerCase().includes(q);
}

function pinMarkHtml() {
  return `<span class="pin-mark" title="ピン留め" aria-hidden="true">`
    + `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">`
    + `<path d="M16 3h-2V2h-4v1H8v2h1.1l1.2 8.1A3 3 0 0 0 12 16.9V22h2v-5.1a3 3 0 0 0 2.7-2.8L17.9 5H19V3h-3z"/></svg></span>`;
}

function muteMarkHtml() {
  return `<span class="mute-mark" title="非通知" aria-hidden="true">`
    + `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">`
    + `<path d="M4.3 3 3 4.3 7.7 9H4v6h4l5 5v-6.7l5.7 5.7 1.3-1.3L4.3 3zM16.5 12c0-.7-.2-1.4-.5-2l-1.5 1.5c.10.10.0.3.2.5H16.5zM14 3.2v2.1c1.8.7 3 2.5 3 4.7h2c0-3.2-1.9-6-5-7z"/></svg></span>`;
}

async function loadMemberCounts() {
  const ids = myGroups.concat(otherGroups).map((g) => g.id).filter(Boolean);
  if (!ids.length) {
    memberCounts = {};
    botRoomIds = new Set();
    return;
  }
  try {
    const { data, error } = await sb
      .from('chat_group_members')
      .select('group_id, chat_users(is_bot)')
      .in('group_id', ids);
    if (error) throw error;
    const next = {};
    const nextBotRoomIds = new Set();
    (data || []).forEach((row) => {
      const id = row.group_id;
      next[id] = (next[id] || 0) + 1;
      if (row.chat_users && row.chat_users.is_bot === true) nextBotRoomIds.add(Number(id));
    });
    memberCounts = next;
    botRoomIds = nextBotRoomIds;
  } catch (error) {
    console.error('Load member counts error:', error);
  }
}

function roomBotMarkHtml(group) {
  return group && botRoomIds.has(Number(group.id))
    ? '<span class="room-bot-mark" title="Bot参加ルーム" aria-label="Bot参加ルーム">BOT</span>'
    : '';
}

function talkListCountLabel(group) {
  if (!group || group.is_direct) return '';
  const n = Number(memberCounts[group.id]) || 0;
  return n >= 2 ? `(${n})` : '';
}

function lastTalkAt(group) {
  return lastMessages[group.id] ? lastMessages[group.id].created_at : group.created_at;
}

function patchMineGroup(groupId, patch) {
  const mine = myGroups.find((g) => Number(g.id) === Number(groupId));
  if (mine) Object.assign(mine, patch);
  return mine;
}

function closeOpenSwipe() {
  if (!openSwipeWrap) return;
  setSwipeX(openSwipeWrap, 0, true);
  openSwipeWrap = null;
}

function isPcPointer() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function closeTalkContextMenu() {
  $('talkContextMenu').classList.add('hidden');
  talkMenuGroup = null;
}

function openTalkContextMenu(group, x, y) {
  if (!group || !currentUser) return;
  closeOpenSwipe();
  talkMenuGroup = group;
  $('talkCtxPin').textContent = group.pinned_at ? 'ピン留めを解除' : 'ピン留め';
  $('talkCtxMute').textContent = group.muted_at ? '通知する' : '非通知';
  const trashed = !!group.trashed_at;
  if ($('talkCtxPin')) $('talkCtxPin').classList.toggle('hidden', trashed);
  if ($('talkCtxMute')) $('talkCtxMute').classList.toggle('hidden', trashed);
  if ($('talkCtxSettings')) $('talkCtxSettings').classList.toggle('hidden', trashed || !canCurrentUserManage(group));
  if ($('talkCtxHide')) $('talkCtxHide').classList.toggle('hidden', trashed);
  if ($('talkCtxDelete')) $('talkCtxDelete').classList.toggle('hidden', trashed || !!group.is_store_room);
  if ($('talkCtxTrash')) $('talkCtxTrash').classList.toggle('hidden', trashed || !canTrashTalk(group));
  if ($('talkCtxRestore')) $('talkCtxRestore').classList.toggle('hidden', !trashed || !canTrashTalk(group));
  if ($('talkCtxPurge')) $('talkCtxPurge').classList.toggle('hidden', !trashed || !canPurgeTalk(group));
  const overlay = $('talkContextMenu');
  const panel = $('talkContextPanel');
  overlay.classList.remove('hidden');
  const pad = 8;
  const left = Math.min(Math.max(pad, x), window.innerWidth - panel.offsetWidth - pad);
  const top = Math.min(Math.max(pad, y), window.innerHeight - panel.offsetHeight - pad);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

async function runTalkAction(fn) {
  closeTalkContextMenu();
  closeOpenSwipe();
  try {
    await fn();
    renderGroups();
  } catch (error) {
    console.error('Talk action error:', error);
    alert(error.message || '操作に失敗しました');
  }
}

function setSwipeX(wrap, x, animate) {
  const front = wrap.querySelector('.swipe-front');
  if (!front) return;
  wrap._swipeX = x;
  front.style.transition = animate ? 'transform 180ms ease' : 'none';
  front.style.transform = `translateX(${x}px)`;
}

function bindTalkSwipe(wrap, group) {
  const front = wrap.querySelector('.swipe-front');
  let pid = null;
  let x0 = 0;
  let y0 = 0;
  let startX = 0;
  let axis = null;
  let moved = false;

  const onDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (openSwipeWrap && openSwipeWrap !== wrap) closeOpenSwipe();
    pid = e.pointerId;
    x0 = e.clientX;
    y0 = e.clientY;
    startX = wrap._swipeX || 0;
    axis = null;
    moved = false;
    try { front.setPointerCapture(pid); } catch (_err) { /* noop */ }
  };

  const onMove = (e) => {
    if (pid == null || e.pointerId !== pid) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') {
        try { front.releasePointerCapture(pid); } catch (_err) { /* noop */ }
        pid = null;
        return;
      }
    }
    if (axis !== 'x') return;
    e.preventDefault();
    moved = Math.abs(dx) > 6;
    const next = Math.max(-SWIPE_OPEN, Math.min(SWIPE_OPEN, startX + dx));
    setSwipeX(wrap, next, false);
  };

  const onUp = (e) => {
    if (pid == null || e.pointerId !== pid) return;
    const x = wrap._swipeX || 0;
    pid = null;
    axis = null;
    let snap = 0;
    if (x > 48) snap = SWIPE_OPEN;
    else if (x < -48) snap = -SWIPE_OPEN;
    setSwipeX(wrap, snap, true);
    openSwipeWrap = snap ? wrap : null;
    if (moved) {
      wrap._ignoreClick = true;
      setTimeout(() => { wrap._ignoreClick = false; }, 250);
    }
  };

  front.addEventListener('pointerdown', onDown);
  front.addEventListener('pointermove', onMove, { passive: false });
  front.addEventListener('pointerup', onUp);
  front.addEventListener('pointercancel', onUp);
  front.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!isPcPointer()) return;
    openTalkContextMenu(group, e.clientX, e.clientY);
  });
  front.addEventListener('click', (e) => {
    if (wrap._ignoreClick) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (wrap._swipeX) {
      e.preventDefault();
      closeOpenSwipe();
      return;
    }
    selectGroup(group);
  });
}

async function setTalkPinned(group, pinned) {
  if (pinned) {
    const pinnedCount = myGroups.filter((g) => g.pinned_at && g.id !== group.id).length;
    if (pinnedCount >= TALK_PIN_LIMIT) {
      alert('ピン留めは5件までです');
      return;
    }
  }
  const { error } = await sb.rpc('chat_set_pin', { p_group_id: group.id, p_pinned: pinned });
  if (error) throw error;
  group.pinned_at = pinned ? new Date().toISOString() : null;
  patchMineGroup(group.id, { pinned_at: group.pinned_at });
}

async function setTalkMuted(group, muted) {
  const { error } = await sb.rpc('chat_set_mute', { p_group_id: group.id, p_muted: muted });
  if (error) throw error;
  group.muted_at = muted ? new Date().toISOString() : null;
  patchMineGroup(group.id, { muted_at: group.muted_at });
}

async function setTalkHidden(group, hidden) {
  const { error } = await sb.rpc('chat_set_hidden', { p_group_id: group.id, p_hidden: hidden });
  if (error) throw error;
  group.hidden_at = hidden ? new Date().toISOString() : null;
  patchMineGroup(group.id, { hidden_at: group.hidden_at });
}

async function leaveTalk(group) {
  if (group && group.is_store_room) {
    alert('店舗固定ルームは退出・削除できません');
    return;
  }
  if (!confirm('このルームから退出しますか？')) return;
  const { error } = await sb.rpc('chat_leave_group', { p_group_id: group.id });
  if (error) throw error;
  myGroups = myGroups.filter((g) => Number(g.id) !== Number(group.id));
  if (Number(currentGroupId) === Number(group.id)) {
    closeInvite();
    closeChat();
  }
  showNotice('ルームから退出しました');
}

function findMineGroup(groupId) {
  return myGroups.find((g) => Number(g.id) === Number(groupId));
}

function isGroupTrashed(group) {
  return !!(group && group.trashed_at);
}

function canTrashTalk(group) {
  return !!(group && !group.is_store_room && !group.is_admin_notice_room && currentUser && canCurrentUserManage(group));
}

function canPurgeTalk(group) {
  return !!(canTrashTalk(group) && group.created_by === currentUser.id);
}

function syncComposerForGroup(group) {
  const trashed = isGroupTrashed(group);
  const canView = !!(group && membershipFor(group)?.can_view === true);
  const readOnly = canView && !canCurrentUserSend(group);
  if ($('inputArea')) {
    $('inputArea').classList.toggle('hidden', !group || trashed || !canView);
    $('inputArea').classList.toggle('composer-read-only', readOnly);
  }
  if ($('readOnlyNotice')) $('readOnlyNotice').classList.toggle('hidden', !readOnly);
  if ($('trashBanner')) $('trashBanner').classList.toggle('hidden', !trashed);
  if ($('roomSettingsHeaderBtn')) $('roomSettingsHeaderBtn').classList.toggle('hidden', trashed || !canCurrentUserManage(group));
  if ($('inviteHeaderBtn')) $('inviteHeaderBtn').classList.toggle('hidden', trashed || !!(group && group.is_direct) || !canCurrentUserInvite(group));
  if ($('composerSheet')) $('composerSheet').classList.toggle('hidden', trashed || !canView);
  syncComposerModeUi();
  if ((trashed || readOnly) && $('replyBar')) $('replyBar').classList.add('hidden');
  if ((trashed || readOnly) && $('scheduleBar')) $('scheduleBar').classList.add('hidden');
  if ($('trashBannerRestore')) $('trashBannerRestore').classList.toggle('hidden', !canTrashTalk(group));
  if ($('trashBannerPurge')) $('trashBannerPurge').classList.toggle('hidden', !canPurgeTalk(group));
  if (trashed || readOnly) {
    closeScheduleSend();
    closeSendMode();
    $('stickerPicker')?.classList.add('hidden');
  }
  // 初回は入力欄が hidden の状態で viewport 計測が走るため、
  // 表示状態を切り替えた後の実寸で予約領域を更新する。
  syncChatViewport();
}

async function trashTalk(group) {
  if (!canTrashTalk(group)) {
    alert('ゴミ箱へ移す権限がありません');
    return;
  }
  if (!confirm('「' + roomTitle(group) + '」をゴミ箱へ移します。\nあとから復元できます。完全削除はゴミ箱から行います。')) {
    return;
  }
  const { error } = await sb.rpc('chat_trash_group', { p_group_id: group.id });
  if (error) throw error;
  group.trashed_at = new Date().toISOString();
  patchMineGroup(group.id, { trashed_at: group.trashed_at });
  if (Number(currentGroupId) === Number(group.id)) {
    closeInvite();
    closeChat();
  }
  showNotice('ゴミ箱へ移しました');
}

async function restoreTalk(group) {
  if (!canTrashTalk(group)) {
    alert('ルームを復元する権限がありません');
    return;
  }
  const { error } = await sb.rpc('chat_restore_group', { p_group_id: group.id });
  if (error) throw error;
  group.trashed_at = null;
  patchMineGroup(group.id, { trashed_at: null });
  if (Number(currentGroupId) === Number(group.id)) {
    paintChatHeader(group);
    syncComposerForGroup(group);
    loadScheduledMessages();
  }
  showNotice('ルームを復元しました');
}

async function purgeTalk(group) {
  if (!canPurgeTalk(group)) {
    alert('ルームを完全に削除できるのは作成者だけです');
    return;
  }
  if (!group.trashed_at) {
    alert('先にゴミ箱へ移してください。');
    return;
  }
  const title = roomTitle(group);
  const confirmName = String(group.group_name || '').trim() || String(group.id);
  if (!confirm('「' + title + '」を完全に削除します。\nメッセージ・画像・このルームの予定も消えます。\n他のルームや店舗の予約・売上には影響しません。\nこの操作は取り消せません。')) {
    return;
  }
  const typed = window.prompt('削除するには次を入力してください。\n' + confirmName);
  if (typed == null) return;
  if (String(typed).trim() !== confirmName) {
    alert('入力が一致しません。削除しませんでした。');
    return;
  }
  const { data: sessionData } = await sb.auth.getSession();
  const token = sessionData && sessionData.session && sessionData.session.access_token;
  if (!token) throw new Error('ログインしてください。');
  const url = CONFIG.adminApiUrl
    ? CONFIG.adminApiUrl('/chat-room-purge')
    : (SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/admin-api/chat-room-purge');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ group_id: group.id, confirm_name: confirmName }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || ('HTTP ' + response.status));
  myGroups = myGroups.filter((g) => Number(g.id) !== Number(group.id));
  if (Number(currentGroupId) === Number(group.id)) {
    closeInvite();
    closeChat();
  }
  showNotice('ルームを完全に削除しました');
}

function renderTalkRow(group, options) {
  const last = lastMessages[group.id];
  const title = roomTitle(group);
  const icon = roomIcon(group);
  const preview = last
    ? ((last.username && last.user_id !== currentUser.id ? speakerName(last.user_id, last.username) + ': ' : '') + last.content)
    : (options.preview || '');
  const when = last ? last.created_at : group.created_at;
  const count = unread[group.id] || 0;
  const pinned = !options.joinable && group.pinned_at;
  const muted = !options.joinable && group.muted_at;

  const front = document.createElement('div');
  front.className = 'group-item swipe-front' + (currentGroupId === group.id ? ' active' : '');
  front.innerHTML = `
    <div class="talk-avatar" style="background:${icon ? '#2c2c2e' : avatarStyle(title)}">${avatarHtml(title, icon, roomAvatarIsBot(group))}</div>
    <div class="talk-body">
      <div class="talk-row">
        <div class="group-item-name">${pinned ? pinMarkHtml() : ''}${muted ? muteMarkHtml() : ''}${group.is_store_room ? '<span class="store-room-mark">店舗</span>' : ''}${roomBotMarkHtml(group)}${group.trashed_at ? '<span class="trash-room-mark">ゴミ箱</span>' : ''}<span>${escapeHtml(title)}</span>${talkListCountLabel(group) ? `<span class="talk-list-count">${escapeHtml(talkListCountLabel(group))}</span>` : ''}</div>
        <div class="talk-time">${formatTalkTime(when)}</div>
      </div>
      <div class="talk-preview-row">
        <div class="group-item-info">${escapeHtml(preview)}</div>
        ${options.joinable || group.trashed_at ? '' : (count > 0 ? `<span class="badge">${count > 99 ? '99+' : count}</span>` : '')}
      </div>
    </div>
  `;

  if (options.joinable) {
    const button = document.createElement('button');
    button.className = 'join-btn';
    button.textContent = '招待で参加';
    button.onclick = (e) => { e.stopPropagation(); joinGroup(group.id); };
    front.appendChild(button);
    front.onclick = () => {};
    return front;
  }

  const wrap = document.createElement('div');
  wrap.className = 'swipe-row';
  if (group.trashed_at) {
    wrap.innerHTML = `
      <div class="swipe-actions swipe-actions-left"></div>
      <div class="swipe-actions swipe-actions-right">
        ${canTrashTalk(group) ? '<button class="swipe-btn swipe-restore" type="button">復元</button>' : ''}${canPurgeTalk(group) ? '<button class="swipe-btn swipe-delete" type="button">完全削除</button>' : ''}
      </div>
    `;
    wrap.appendChild(front);
    const restoreBtn = wrap.querySelector('.swipe-restore');
    const purgeBtn = wrap.querySelector('.swipe-delete');
    if (restoreBtn) restoreBtn.onclick = (e) => { e.stopPropagation(); runTalkAction(() => restoreTalk(group)); };
    if (purgeBtn) purgeBtn.onclick = (e) => { e.stopPropagation(); runTalkAction(() => purgeTalk(group)); };
    bindTalkSwipe(wrap, group);
    return wrap;
  }
  wrap.innerHTML = `
    <div class="swipe-actions swipe-actions-left">
      <button class="swipe-btn swipe-pin" type="button" aria-label="${pinned ? 'ピン留めを解除' : 'ピン留め'}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3h-2V2h-4v1H8v2h1.1l1.2 8.1A3 3 0 0 0 12 16.9V22h2v-5.1a3 3 0 0 0 2.7-2.8L17.9 5H19V3h-3z"/></svg>
      </button>
      <button class="swipe-btn swipe-mute" type="button" aria-label="${muted ? '通知する' : '非通知'}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="${muted
          ? 'M4 9v6h4l5 5V4L8 9H4zm11.5 3A4.5 4.5 0 0 0 13 8.2v7.6a4.5 4.5 0 0 0 2.5-3.8z'
          : 'M4.3 3 3 4.3 7.7 9H4v6h4l5 5v-6.7l5.7 5.7 1.3-1.3L4.3 3zM16.5 12c0-.7-.2-1.4-.5-2l-1.5 1.5c.10.10.0.3.2.5H16.5z'}"/></svg>
      </button>
    </div>
    <div class="swipe-actions swipe-actions-right">
      <button class="swipe-btn swipe-hide" type="button">非表示</button>
      <button class="swipe-btn swipe-delete" type="button">退出</button>
    </div>
  `;
  wrap.appendChild(front);

  wrap.querySelector('.swipe-pin').onclick = (e) => {
    e.stopPropagation();
    runTalkAction(() => setTalkPinned(group, !group.pinned_at));
  };
  wrap.querySelector('.swipe-mute').onclick = (e) => {
    e.stopPropagation();
    runTalkAction(() => setTalkMuted(group, !group.muted_at));
  };
  wrap.querySelector('.swipe-hide').onclick = (e) => {
    e.stopPropagation();
    runTalkAction(() => setTalkHidden(group, true));
  };
  wrap.querySelector('.swipe-delete').onclick = (e) => {
    e.stopPropagation();
    runTalkAction(() => leaveTalk(group));
  };
  bindTalkSwipe(wrap, group);
  return wrap;
}

function renderGroups() {
  const usersWrap = $('registeredUsersWrap');
  const inviteBar = $('userInviteBar');
  const showUsers = talkTab === 'users' || talkTab === 'bots';
  usersWrap.classList.toggle('hidden', !showUsers);
  if (!showUsers) inviteBar.classList.add('hidden');
  if (showUsers) {
    $('myGroupsList').innerHTML = '';
    $('otherGroupsWrap').classList.add('hidden');
    renderRegisteredUsers();
    return;
  }

  const mineList = $('myGroupsList');
  mineList.innerHTML = '';

  const showMine = talkTab === 'all' || talkTab === 'groups' || talkTab === 'friends' || talkTab === 'trash';
  const showOther = talkTab === 'all';

  const searchQ = ($('talkSearch').value || '').trim();
  const mineVisible = showMine
    ? myGroups.filter((g) => {
        if (isStoreBotDirect(g)) return false;
        if (talkTab === 'trash') return !!g.trashed_at && matchesQuery(g, lastMessages[g.id] && lastMessages[g.id].content);
        if (g.trashed_at) return false;
        if (talkTab === 'friends' && !g.is_direct) return false;
        if (talkTab === 'groups' && (g.is_direct || g.is_store_room)) return false;
        if (talkTab === 'all' && g.is_store_room && !searchQ) return false;
        if (g.hidden_at && !searchQ) return false;
        return matchesQuery(g, lastMessages[g.id] && lastMessages[g.id].content);
      })
    : [];

  mineVisible.sort((a, b) => {
    const ap = a.pinned_at ? 1 : 0;
    const bp = b.pinned_at ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return new Date(lastTalkAt(b)) - new Date(lastTalkAt(a));
  });

  if (showMine && mineVisible.length === 0 && talkTab !== 'friends') {
    mineList.innerHTML = talkTab === 'trash'
      ? '<div class="empty-note">ゴミ箱は空です</div>'
      : '<div class="empty-note">トークはまだありません</div>';
  } else {
    let splitDone = false;
    mineVisible.forEach((group, index) => {
      if (!splitDone && index > 0 && !group.pinned_at && mineVisible[0].pinned_at) {
        const split = document.createElement('div');
        split.className = 'talk-pin-split';
        mineList.appendChild(split);
        splitDone = true;
      }
      mineList.appendChild(renderTalkRow(group, {}));
    });
  }

  if (talkTab === 'friends') {
    const peerIds = new Set(
      myGroups.filter((g) => g.is_direct && g.peer).map((g) => g.peer.id)
    );
    const q = ($('talkSearch').value || '').trim().toLowerCase();
    const candidates = registeredUsers.filter((u) => (
      u.id !== currentUser.id
      && !isBotUser(u)
      && !peerIds.has(u.id)
      && sharesAffiliationWith(u)
      && (!q || u.username.toLowerCase().includes(q))
    ));
    const section = document.createElement('div');
    section.className = 'section-label';
    section.textContent = '登録ユーザーから友だちにする';
    mineList.appendChild(section);
    if (!candidates.length && !mineVisible.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = myStoreKeys().length
        ? '所属店舗が同じ登録ユーザーはいません'
        : '所属店舗を設定すると、同じ店舗の相手と1対1を始められます';
      mineList.appendChild(empty);
    }
    candidates.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.innerHTML = `
        <div class="talk-avatar" style="background:${user.icon_url ? '#2c2c2e' : avatarStyle(user.username)}">${avatarHtml(user.username, user.icon_url, isStoreBot(user))}</div>
        <div class="talk-body">
          <div class="group-item-name">${escapeHtml(user.username)}</div>
          <div class="group-item-info">1対1トークを始める</div>
        </div>
      `;
      const button = document.createElement('button');
      button.className = 'join-btn';
      button.textContent = '登録';
      button.disabled = !chatAccessAllows('can_start_direct');
      button.title = button.disabled ? '1対1トークを開始する権限がありません' : '';
      button.onclick = (e) => { e.stopPropagation(); registerDirectFriend(user); };
      row.appendChild(button);
      mineList.appendChild(row);
    });
  }

  const otherWrap = $('otherGroupsWrap');
  const otherList = $('otherGroupsList');
  otherList.innerHTML = '';
  const others = showOther
    ? otherGroups.filter((g) => !g.is_store_room && !isStoreBotDirect(g) && matchesQuery(g, ''))
    : [];
  otherWrap.classList.toggle('hidden', !showOther || others.length === 0);
  others.forEach((group) => {
    otherList.appendChild(renderTalkRow(group, { joinable: true, preview: '招待リンクで参加できます' }));
  });
}

async function createGroup() {
  const groupName = $('newGroupInput').value.trim();
  if (!groupName || !currentUser) return;
  if (!chatAccessAllows('can_create_group')) {
    alert('グループを作成する権限がありません');
    return;
  }

  try {
    const { data, error } = await sb.rpc('chat_create_group', {
      p_group_name: groupName,
      p_member_ids: []
    });
    if (error) throw error;
    const groupId = Number(data?.group_id ?? data?.id ?? data);

    if (pendingGroupIconFile) {
      try {
        await loadGroups();
        await saveGroupIcon(groupId, pendingGroupIconFile);
      } catch (iconError) {
        console.error('Group icon error:', iconError);
      }
      pendingGroupIconFile = null;
      paintAvatar($('newGroupIconPreview'), '＋', null);
      $('newGroupIconPreview').textContent = '＋';
    }

    $('newGroupInput').value = '';
    $('newGroupPop').classList.add('hidden');
    await loadGroups();
    const group = myGroups.find((item) => Number(item.id) === groupId);
    if (group) selectGroup(group);
  } catch (error) {
    console.error('Create group error:', error);
    alert(`グループ作成に失敗しました: ${error.message || error}`);
  }
}

function extractInviteToken(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    const fromQuery = String(url.searchParams.get('invite') || '').trim();
    if (fromQuery) return fromQuery;
  } catch (_) {}
  if (/^[A-Za-z0-9_-]{16,}$/.test(text)) return text;
  return '';
}

async function joinGroup(groupId) {
  if (!currentUser || !groupId) return;
  const pasted = prompt(
    'この一覧から直接入ることはできません。\n'
    + 'メンバーから届いた招待リンクを貼り付けてください。'
  );
  if (pasted === null) return;
  const token = extractInviteToken(pasted);
  if (!token) {
    alert('招待リンクが見つかりませんでした。リンク全体を貼り付けてください。');
    return;
  }
  try {
    const { data, error } = await sb.rpc('chat_join_by_invite', { p_token: token });
    if (error) throw error;
    await loadGroups();
    const joinedId = Number(data);
    const group = myGroups.find((item) => Number(item.id) === joinedId);
    if (group) selectGroup(group);
    else alert('参加しました。トーク一覧を確認してください。');
  } catch (error) {
    console.error('Join group error:', error);
    alert(error.message || '招待リンクが無効です');
  }
}

function pruneRoomViewCache() {
  while (roomViewCache.size > ROOM_VIEW_CACHE_LIMIT) {
    const first = roomViewCache.keys().next().value;
    roomViewCache.delete(first);
  }
}

function snapshotRoomView(groupId) {
  const id = Number(groupId);
  if (!id || !currentMessages.length) return;
  roomViewCache.delete(id);
  roomViewCache.set(id, {
    messages: currentMessages.slice(),
    notes: (currentPrivateNotes || []).slice(),
    reactions: new Map(reactionsByMessage),
    quoted: new Map(quotedMessages),
    members: (groupMembers || []).slice(),
    readStates: (groupReadStates || []).slice(),
    historyExhausted: !!historyExhausted,
    viewHasLatest: !!viewHasLatest,
  });
  pruneRoomViewCache();
}

function applyRoomViewCache(groupId) {
  const cached = roomViewCache.get(Number(groupId));
  if (!cached || !cached.messages.length) return false;
  currentMessages = cached.messages.slice();
  currentPrivateNotes = cached.notes ? cached.notes.slice() : [];
  reactionsByMessage = new Map(cached.reactions);
  quotedMessages = new Map(cached.quoted);
  groupMembers = cached.members.slice();
  groupReadStates = cached.readStates.slice();
  historyExhausted = cached.historyExhausted;
  viewHasLatest = cached.viewHasLatest;
  followNewMessages = true;
  loadingHistory = false;
  seenMessageIds = new Set(currentMessages.map((m) => m.id));
  renderMessageList();
  updateChatHeaderMeta();
  return true;
}

function latestMessageFingerprint(list) {
  if (!list || !list.length) return '';
  const last = list[list.length - 1];
  return `${list.length}:${last.id}:${last.created_at}`;
}

function mergeLatestPage(existing, latestPage) {
  if (!latestPage.length) return (existing || []).slice();
  const latestIds = new Set(latestPage.map((m) => m.id));
  const firstNew = latestPage[0];
  const older = (existing || []).filter((m) => (
    !latestIds.has(m.id)
    && String(m.created_at) < String(firstNew.created_at)
  ));
  return older.concat(latestPage);
}

function restoreSignedImageCache() {
  try {
    const raw = sessionStorage.getItem(SIGNED_URL_STORAGE_KEY);
    if (!raw) return;
    const now = Date.now();
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    rows.forEach((row) => {
      if (row && row.path && row.url && Number(row.expiresAt) > now + 60000) {
        signedImageUrls.set(row.path, { url: row.url, expiresAt: Number(row.expiresAt) });
      }
    });
  } catch (_) { /* ignore */ }
}

function persistSignedImageCache() {
  try {
    const now = Date.now();
    const rows = [];
    signedImageUrls.forEach((value, path) => {
      if (value && value.url && Number(value.expiresAt) > now + 60000) {
        rows.push({ path, url: value.url, expiresAt: value.expiresAt });
      }
    });
    sessionStorage.setItem(SIGNED_URL_STORAGE_KEY, JSON.stringify(rows.slice(-200)));
  } catch (_) { /* ignore */ }
}

restoreSignedImageCache();

async function selectGroup(group) {
  if (!group || group.membership?.can_view !== true) {
    await loadGroups();
    return;
  }
  if (editingMessage && Number(currentGroupId) !== Number(group.id)) cancelMessageEdit();
  if (currentGroupId && Number(currentGroupId) !== Number(group.id)) {
    snapshotRoomView(currentGroupId);
  }
  currentGroupId = group.id;
  currentRoomMembership = group.membership || null;
  const seq = ++selectGroupSeq;
  if (group.hidden_at) {
    group.hidden_at = null;
    setTalkHidden(group, false).catch((error) => console.error('Unhide error:', error));
  }
  markGroupRead(group.id);
  document.body.classList.add('chat-open');
  syncChatViewport();

  $('placeholder').classList.add('hidden');
  $('chatHeader').classList.remove('hidden');
  $('messagesWrap').classList.remove('hidden');
  hideMemberStrip();
  paintChatHeader(group);
  syncComposerForGroup(group);
  closeMessageMenu();
  clearReplyTarget();
  if ($('mentionPop')) $('mentionPop').classList.add('hidden');

  const fromCache = applyRoomViewCache(group.id);
  if (fromCache) {
    scrollMessagesToBottom();
  } else {
    resetMessageView();
  }

  const contextPromise = loadGroupContext(group.id);
  const notesPromise = loadPrivateNotes(group.id, seq);
  loadScheduledMessages();

  try {
    const { data, error } = await sb
      .from('chat_messages')
      .select(MESSAGE_COLUMNS)
      .eq('group_id', group.id)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_PAGE_SIZE);
    if (error) throw error;
    if (seq !== selectGroupSeq || Number(currentGroupId) !== Number(group.id)) return;

    const loaded = (data || []).reverse();
    if (loaded.length < MESSAGE_PAGE_SIZE) historyExhausted = true;
    const merged = fromCache ? mergeLatestPage(currentMessages, loaded) : loaded;
    const before = latestMessageFingerprint(currentMessages);
    const after = latestMessageFingerprint(merged);
    // この問い合わせは常に最新ページを取得している。検索・途中ジャンプ由来の
    // キャッシュが viewHasLatest=false でも、取得成功後は最新状態へ戻す。
    viewHasLatest = true;
    followNewMessages = true;
    if (!fromCache || before !== after) {
      await setMessages(merged);
      if (seq !== selectGroupSeq || Number(currentGroupId) !== Number(group.id)) return;
    }
    scrollMessagesToBottom();
    updateJumpLatestButton();
    snapshotRoomView(group.id);
  } catch (error) {
    console.error('Load messages error:', error);
  }

  await Promise.all([contextPromise, notesPromise]);
  if (seq !== selectGroupSeq || Number(currentGroupId) !== Number(group.id)) return;
  paintChatHeader(group);
  renderGroups();
  if (!isMobileLayout()) $('messageInput').focus();
}
