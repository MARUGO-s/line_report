'use strict';

function chatAccessIsBlocked(access) {
  if (!access || access.access_enabled !== true || access.deleted_at) return true;
  if (access.signup_status === 'pending' || access.signup_status === 'denied') return true;
  if (!access.restricted_until) return false;
  const until = new Date(access.restricted_until).getTime();
  return Number.isFinite(until) && until > Date.now();
}

function chatAccessSignupState(access) {
  if (!access) return '';
  if (access.deleted_at) return 'deleted';
  if (access.signup_status === 'pending') return 'pending';
  if (access.signup_status === 'denied') return 'denied';
  return 'blocked';
}

async function loadCurrentChatAccess() {
  if (!currentUser) return null;
  const { data, error } = await sb
    .from('chat_user_access')
    .select(CHAT_ACCESS_COLUMNS)
    .eq('user_id', currentUser.id)
    .maybeSingle();
  if (error) throw error;
  currentChatAccess = data || null;
  return currentChatAccess;
}

function chatAccessAllows(capability) {
  return !chatAccessIsBlocked(currentChatAccess) && currentChatAccess?.[capability] === true;
}

function currentGroup() {
  return myGroups.find((group) => Number(group.id) === Number(currentGroupId)) || null;
}

function membershipFor(group) {
  if (!group) return null;
  if (Number(group.id) === Number(currentGroupId) && currentRoomMembership) return currentRoomMembership;
  return group.membership || null;
}

function roomCapability(group, capability) {
  const membership = membershipFor(group);
  return !!(membership && membership.can_view === true && membership[capability] === true);
}

function canCurrentUserSend(group = currentGroup()) { return roomCapability(group, 'can_send'); }
function canCurrentUserInvite(group = currentGroup()) { return roomCapability(group, 'can_invite'); }
function canCurrentUserManage(group = currentGroup()) { return roomCapability(group, 'can_manage'); }

function currentUserIsSignupManager() {
  return (myGroups || []).some((group) => (
    group && !group.is_direct && !group.trashed_at && canCurrentUserManage(group)
  ));
}

function adminNoticeKindFromMessage(msg) {
  if (!msg || msg.kind !== 'card') return '';
  const payload = typeof msg.payload === 'string' ? safeParseJson(msg.payload) : msg.payload;
  return String((payload && payload.kind) || '').trim();
}

function isAdminNoticeMessage(msg) {
  return ['signup_approval', 'signup_reviewed', 'store_change', 'store_change_reviewed']
    .includes(adminNoticeKindFromMessage(msg));
}

function canSeeAdminNoticeMessage(msg, group) {
  const target = group || currentGroup() || myGroups.find((g) => Number(g.id) === Number(msg && msg.group_id));
  if (canCurrentUserManage(target)) return true;
  return !!(target && target.is_direct && currentUserIsSignupManager());
}

function shouldHideAdminNotice(msg, group) {
  return isAdminNoticeMessage(msg) && !canSeeAdminNoticeMessage(msg, group);
}

function requireCurrentRoomSend() {
  if (canCurrentUserSend()) return true;
  alert('このルームは閲覧専用です。メッセージは送信できません。');
  return false;
}

function requireCurrentRoomView() {
  if (currentGroup() && membershipFor(currentGroup())?.can_view === true) return true;
  alert('このルームは閲覧できません。');
  return false;
}

function syncGlobalCapabilityUi() {
  const canBrowse = chatAccessAllows('can_browse_users');
  const canCreate = chatAccessAllows('can_create_group');
  document.querySelectorAll('[data-tab="users"], [data-tab="bots"]').forEach((tab) => tab.classList.toggle('hidden', !canBrowse));
  if (!canBrowse && (talkTab === 'users' || talkTab === 'bots')) setTalkTab('all');
  if ($('fab')) $('fab').classList.toggle('hidden', !canCreate || !['all', 'groups'].includes(talkTab));
  if (!canCreate && $('newGroupPop')) $('newGroupPop').classList.add('hidden');
  if (!canBrowse) {
    selectedUserIds = new Set();
    if ($('userInviteBar')) $('userInviteBar').classList.add('hidden');
    if ($('userInviteTarget')) closeUserInviteTarget();
    if ($('forwardOverlay')) closeForward();
  }
}

function hideChatAccessBlocked() {
  if (chatAccessExpiryTimer) {
    clearTimeout(chatAccessExpiryTimer);
    chatAccessExpiryTimer = null;
  }
  if ($('chatAccessBlocked')) $('chatAccessBlocked').classList.add('hidden');
}

function scheduleChatAccessExpiryCheck() {
  if (chatAccessExpiryTimer) clearTimeout(chatAccessExpiryTimer);
  chatAccessExpiryTimer = null;
  const until = currentChatAccess?.restricted_until
    ? new Date(currentChatAccess.restricted_until).getTime()
    : 0;
  if (!Number.isFinite(until) || until <= Date.now()) return;
  const delay = Math.min(until - Date.now() + 250, 2147483000);
  chatAccessExpiryTimer = setTimeout(() => {
    chatAccessExpiryTimer = null;
    if (until > Date.now()) scheduleChatAccessExpiryCheck();
    else handleCurrentChatAccessChange();
  }, Math.max(250, delay));
}

function showChatAccessBlocked() {
  const access = currentChatAccess || {};
  $('loginForm').classList.add('hidden');
  $('signupForm').classList.add('hidden');
  $('profileForm').classList.add('hidden');
  $('chatAccessBlocked').classList.remove('hidden');
  $('loginScreen').classList.remove('hidden');
  $('navRail').classList.add('hidden');
  $('sidebar').classList.add('hidden');
  $('mainContent').classList.add('hidden');
  const signupState = chatAccessSignupState(access);
  $('chatAccessBlockedTitle').textContent =
    signupState === 'deleted' ? 'M-talkのユーザー登録が削除されています'
    : signupState === 'pending' ? '管理者の承認待ちです'
    : signupState === 'denied' ? '利用が許可されませんでした'
    : 'M-talkの利用が停止されています';
  $('chatAccessBlockedBody').textContent =
    signupState === 'pending'
      ? '登録は受け付けました。所属店舗を含む申請を、ルームの管理権限を持つ人が許可すると、閲覧だけできる状態で使い始められます。'
    : signupState === 'denied'
      ? 'このアカウントのM-talk利用は許可されていません。心当たりがある場合は管理者へ連絡してください。'
    : 'M-talk専用の管理設定により、現在はチャットを利用できません。';
  const reason = String(access.restriction_reason || '').trim();
  $('chatAccessBlockedReason').textContent = reason;
  $('chatAccessBlockedReason').classList.toggle('hidden', !reason);
  const until = access.restricted_until && new Date(access.restricted_until).getTime() > Date.now()
    ? `利用停止期限: ${new Date(access.restricted_until).toLocaleString('ja-JP')}`
    : '';
  $('chatAccessBlockedUntil').textContent = until;
  $('chatAccessBlockedUntil').classList.toggle('hidden', !until);
  scheduleChatAccessExpiryCheck();
}
