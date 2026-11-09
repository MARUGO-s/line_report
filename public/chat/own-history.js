'use strict';

// Account-private display state. This never changes room entitlement or source data.
let ownHistorySession = null;
let ownHistorySessionToken = null;
let ownHistorySessionOwner = null;
let ownHistoryOwnerEpoch = 0;
let ownHistoryAuthEpoch = 0;
let ownHistoryGeneration = 0;
let ownHistoryStateSequence = 0;
const ownHistoryScopes = new Map();
const ownHistoryKnownV1 = new Set();
const OWN_HISTORY_INTENT_PREFIX = 'mtalk-own-history-v1:';
const OWN_HISTORY_REJECTED_PREFIX = 'mtalk-own-history-rejected-v1:';
const ownHistoryDecimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n;
const ownHistoryGroupId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const ownHistoryUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function ownHistorySetSession(session, force = false) {
  const token = session?.access_token || null;
  const owner = session?.user?.id || null;
  if (session === ownHistorySession && token === ownHistorySessionToken && owner === ownHistorySessionOwner && !force) return;
  // A normal token refresh is not an account lifetime boundary. Sign-in/out
  // and observed owner ABA are, including mutation of the same session object.
  if (force || owner !== ownHistorySessionOwner) ++ownHistoryOwnerEpoch;
  ownHistorySessionOwner = owner;
  ownHistorySession = session;
  ownHistorySessionToken = token; // Retain only for equality; never log credentials.
  ++ownHistoryAuthEpoch;
  ++ownHistoryGeneration;
  ++unreadRequestSequence;
  ++messageSearchSeq;
  messageSearchHits = [];
  myGroups.forEach(group => ownHistoryInvalidate(group.id));
  // Initial auth may arrive before the later classic UI scripts are loaded.
  if (typeof renderMessageSearch === 'function') renderMessageSearch(($('talkSearch')?.value || '').trim());
}
sb.auth.onAuthStateChange((event, session) => ownHistorySetSession(session || null, event === 'SIGNED_IN' || event === 'SIGNED_OUT'));

function ownHistoryReadable(id) {
  const group = myGroups.find(g => String(g.id) === String(id));
  return !!(currentUser && ownHistorySession?.user?.id === currentUser.id
    && !chatAccessIsBlocked(currentChatAccess) && group
    && group.membership?.can_view === true && roomCapability(group, 'can_view'));
}
function ownHistoryAuthorized(id) {
  return ownHistoryReadable(id) && !findMineGroup(id)?.trashed_at;
}
function ownHistoryV1(group) {
  const valid = !!group && ownHistoryDecimal(group.own_history_revision) && typeof group.own_history_suppressed === 'boolean';
  if (valid && currentUser) ownHistoryKnownV1.add(currentUser.id + ':' + group.id);
  return valid;
}
function ownHistoryCheckVersion(group) {
  if (!group) return;
  const hasFields = group.own_history_revision !== undefined || group.own_history_suppressed !== undefined;
  if (!ownHistoryV1(group) && (hasFields || ownHistoryKnownV1.has(currentUser?.id + ':' + group.id))) {
    throw new Error('本人履歴状態の形式が不正です');
  }
}
function ownHistoryLease(ids) {
  const groups = ids.map(String);
  const lease = { owner: currentUser?.id, session: ownHistorySession, epoch: ownHistoryAuthEpoch,
    jwt: ownHistorySession?.access_token, access: JSON.stringify(currentChatAccess),
    generation: ownHistoryGeneration, groups,
    selection: currentGroupId, selectionSequence: selectGroupSeq, reply: replyTarget,
    revisions: groups.map(id => myGroups.find(g => String(g.id) === id)?.own_history_revision) };
  lease.identityValid = () => lease.owner === currentUser?.id && lease.session === ownHistorySession
    && lease.jwt === ownHistorySession?.access_token && lease.access === JSON.stringify(currentChatAccess)
    && lease.epoch === ownHistoryAuthEpoch;
  lease.valid = () => lease.identityValid() && lease.generation === ownHistoryGeneration
    && groups.every((id, index) => ownHistoryReadable(id)
      && myGroups.find(g => String(g.id) === id)?.own_history_revision === lease.revisions[index]);
  lease.editorValid = () => lease.selection === currentGroupId && lease.selectionSequence === selectGroupSeq
    && lease.reply === replyTarget;
  return lease;
}
let ownHistoryRenderGeneration = 0;
function ownHistoryRowLease(id) {
  const lease = ownHistoryLease([id]);
  const render = ownHistoryRenderGeneration, tab = talkTab, query = $('talkSearch').value;
  const group = myGroups.find(g => String(g.id) === String(id));
  return () => lease.valid() && render === ownHistoryRenderGeneration && tab === talkTab
    && query === $('talkSearch').value && group === myGroups.find(g => String(g.id) === String(id));
}
async function ownHistoryRowAction(id, valid, action) {
  if (!valid()) return false;
  closeTalkContextMenu(); closeOpenSwipe();
  let scope;
  let ownsSaving = false;
  try {
    if (!ownHistoryGroupId(id)) throw new Error('このルームの識別子を安全に扱えません');
    scope = ownHistoryScope(id);
    if (scope.saving || scope.intent) return false;
    if (action === 'clear' || action === 'read') return await ownHistoryCommand(id, action, false, valid);
    scope.saving = true;
    ownsSaving = true;
    const group = myGroups.find(g => String(g.id) === String(id));
    const field = {pin:'pinned_at', mute:'muted_at', hide:'hidden_at'}[action];
    if (!field || !valid()) return false;
    const value = action === 'hide' || !group[field];
    if (action === 'pin' && value && myGroups.filter(g => g.pinned_at && g !== group).length >= TALK_PIN_LIMIT) throw new Error('ピン留めは5件までです');
    const name = {pin:'chat_set_pin',mute:'chat_set_mute',hide:'chat_set_hidden'}[action];
    const parameter = {pin:'p_pinned',mute:'p_muted',hide:'p_hidden'}[action];
    const {error} = await sb.rpc(name, {p_group_id:group.id,[parameter]:value});
    if (!valid()) return false;
    if (error) throw error;
    group[field] = value ? new Date().toISOString() : null;
    return true;
  } catch (error) {
    if (valid()) alert(error.message || '操作結果を確認してください');
    return false;
  } finally {
    if (ownsSaving) scope.saving = false;
    if (ownsSaving && valid()) renderGroups();
  }
}
async function ownHistoryOperationStatus(id) {
  if (!ownHistoryAuthorized(id)) return null;
  const scope = ownHistoryScope(id);
  if (scope.saving || !scope.intent) return null;
  const intent = scope.intent, sequence = ++scope.statusSequence;
  scope.proof = null;
  const lease = ownHistoryLease([id]);
  const {data, error} = await sb.rpc('chat_own_history_operation_v1', {p_group_id:intent.group_id,p_request_id:intent.request_id});
  if (!lease.valid() || sequence !== scope.statusSequence || scope.intent !== intent) return null;
  if (error) throw error;
  ownHistoryReceipt(data, intent, true);
  if (data.status === 'applied') scope.proof = {intent,sequence,lease,data};
  return data;
}
function ownHistoryAcknowledge(id, proof) {
  const scope = ownHistoryScope(id);
  if (!proof || proof !== scope.proof || proof.sequence !== scope.statusSequence || !proof.lease.valid()
    || scope.saving || scope.intent !== proof.intent || proof.data.status !== 'applied') return false;
  ownHistoryRemoveIntent(scope, proof.intent);
  scope.intent = null; scope.proof = null; ++scope.statusSequence;
  return true;
}
function ownHistoryRenderRecovery(list) {
  myGroups.forEach(group => {
    if (!ownHistoryAuthorized(group.id)) return;
    let scope;
    try { scope = ownHistoryScope(group.id); } catch (_) { return; }
    if (!scope.intent && !scope.saving) return;
    const panel = document.createElement('div'); panel.className = 'own-history-recovery';
    const target = `${scope.intent?.target_name || roomTitle(group)} (ルーム ${group.id}) ・ ${scope.intent?.kind === 'clear' ? '自分の履歴削除' : scope.intent?.kind === 'read' ? '既読' : 'ルーム操作'}`;
    panel.setAttribute('aria-label', target);
    const heading = document.createElement('p'); heading.textContent = target; panel.appendChild(heading);
    const label = document.createElement('p');
    label.textContent = scope.saving ? '操作を保存中です' : '操作結果が未確認です。未実行とは限りません。';
    panel.appendChild(label);
    if (!scope.saving && scope.intent && ownHistoryRejection(scope.intent)) {
      label.textContent = 'この初回操作は履歴の版が古いため拒否され、適用されませんでした。新しい操作には別の確認が必要です。';
      const intent = scope.intent, valid = ownHistoryRowLease(group.id);
      const ack = document.createElement('button'); ack.textContent = '拒否を確認して閉じる';
      ack.onclick = async () => {
        if (!valid()) return;
        try {
          if (!await ownHistoryAcknowledgeRejection(group.id,intent)) return;
          await ownHistoryStates([group.id]);
          scope.needsFresh = false;
          renderGroups();
        } catch (error) { label.textContent = error.message; renderGroups(); }
      };
      panel.appendChild(ack);
      list.appendChild(panel);
      return;
    }
    if (!scope.saving && scope.intent) {
      const valid = ownHistoryRowLease(group.id);
      const check = document.createElement('button'); check.textContent = '操作結果を確認';
      check.onclick = async () => {
        if (!valid()) return;
        try {
          const data = await ownHistoryOperationStatus(group.id);
          if (!valid() || !data) return;
          label.textContent = data.status === 'applied' ? '保存済みの操作を確認しました' : 'まだ結果を確認できません。未実行とは断定できません。';
          if (scope.proof) {
            const proof = scope.proof;
            const ack = document.createElement('button'); ack.textContent = '確認して閉じる';
            ack.onclick = () => { if (valid() && ownHistoryAcknowledge(group.id,proof)) { renderGroups(); ownHistoryRefresh().catch(()=>{}); } };
            panel.appendChild(ack);
          }
        } catch (error) { if (valid()) label.textContent = error.message; }
      };
      const retry = document.createElement('button'); retry.textContent = '同じ操作を再確認・再試行';
      retry.onclick = async () => {
        if (!valid() || !scope.intent) return;
        try { await ownHistoryCommand(group.id,scope.intent.kind,true); }
        catch (error) { if (valid()) label.textContent = error.message; }
        if (valid()) renderGroups();
      };
      panel.append(check,retry);
    }
    list.appendChild(panel);
  });
}
function ownHistoryInvalidate(id) {
  ++ownHistoryGeneration;
  ++unreadRequestSequence;
  ++messageSearchSeq;
  messageSearchHits = [];
  closeMessageMenu();
  if (forwardMessage && Number(forwardMessage.group_id) === Number(id)) closeForward();
  delete lastMessages[id];
  roomViewCache.delete(Number(id));
  if (Number(currentGroupId) === Number(id)) {
    ++selectGroupSeq;
    currentMessages = [];
    seenMessageIds = new Set();
    quotedMessages = new Map();
    reactionsByMessage = new Map();
    loadingHistory = false;
    fillingLatestGap = false;
    jumpingToLatest = false;
    historyExhausted = false;
    // Keep notes, pending sends, edit/draft/options and the actual input node.
    renderMessageList();
    if ($('replyBarText')) $('replyBarText').textContent = '引用元を再確認してください';
  }
  renderMessageSearch(($('talkSearch')?.value || '').trim());
}
function ownHistoryApplyStates(rows) {
  rows.forEach(row => {
    const group = myGroups.find(g => String(g.id) === row.group_id);
    if (!group) return;
    if (group.own_history_revision !== row.revision || group.own_history_suppressed !== row.timeline_suppressed) ownHistoryInvalidate(group.id);
    group.own_history_revision = row.revision;
    group.own_history_suppressed = row.timeline_suppressed;
    group.own_history_unverified = false;
  });
}
async function ownHistoryStates(ids) {
  const unique = [...new Set(ids.map(String))];
  if (!unique.every(ownHistoryGroupId)) throw new Error('ルームの識別子が不正です');
  const identity = ownHistoryLease(unique);
  const valid = () => identity.valid() && unique.every(ownHistoryAuthorized);
  const sequence = ++ownHistoryStateSequence;
  if (!valid()) throw new Error('閲覧権限を再確認してください');
  const rows = [];
  try {
    for (let offset = 0; offset < unique.length; offset += 100) {
      if (!valid() || sequence !== ownHistoryStateSequence) throw new Error('古い状態確認です');
      const chunk = unique.slice(offset, offset + 100);
      const {data, error} = await sb.rpc('chat_own_history_states_v1', {p_group_ids: chunk});
      if (!valid() || sequence !== ownHistoryStateSequence) throw new Error('古い状態確認です');
      if (error) throw error;
      if (!Array.isArray(data) || data.length !== chunk.length) throw new Error('履歴状態を確認できません');
      const seen = new Set();
      data.forEach(row => {
        if (!row || row.contract_version !== 1 || row.user_id !== identity.owner
          || typeof row.group_id !== 'string' || !chunk.includes(row.group_id) || seen.has(row.group_id)
          || !ownHistoryDecimal(row.revision) || typeof row.timeline_suppressed !== 'boolean') throw new Error('履歴状態の形式が不正です');
        seen.add(row.group_id); rows.push(row);
      });
    }
    if (!valid() || sequence !== ownHistoryStateSequence) throw new Error('古い状態確認です');
    ownHistoryApplyStates(rows);
    return rows;
  } catch (error) {
    if (valid() && sequence === ownHistoryStateSequence) unique.forEach(id => {
      const group = myGroups.find(g => String(g.id) === id);
      if (group) { group.own_history_unverified = true; ownHistoryInvalidate(id); }
    });
    throw error;
  }
}
function ownHistoryListVisible(group) {
  return !!group && !group.own_history_unverified && group.own_history_suppressed !== true;
}
// State-before / raw RLS SELECT / state-after. Never consume a held body directly.
async function ownHistoryRead(ids, reader) {
  const unique = [...new Set(ids.map(String))];
  unique.forEach(id => ownHistoryCheckVersion(myGroups.find(g => String(g.id) === id)));
  const versioned = unique.filter(id => ownHistoryAuthorized(id) && ownHistoryV1(myGroups.find(g => String(g.id) === id)));
  if (versioned.length) await ownHistoryStates(versioned);
  const lease = ownHistoryLease(unique);
  if (!lease.valid()) throw new Error('古い履歴読取です');
  const result = await reader();
  if (!lease.valid()) throw new Error('古い履歴読取です');
  if (versioned.length) await ownHistoryStates(versioned);
  if (!lease.valid()) throw new Error('履歴状態が変更されました');
  return result;
}
async function ownHistoryAcceptMessage(message) {
  const id = message?.group_id;
  if (!ownHistoryAuthorized(id)) return false;
  const group = myGroups.find(g => String(g.id) === String(id));
  ownHistoryCheckVersion(group);
  if (!ownHistoryV1(group)) {
    if (shouldHideAdminNotice(message,group)) return false;
    lastMessages[id] = message;
    if (Number(currentGroupId) === Number(id)) addMessageToUI(message);
    renderGroups(); return true;
  }
  const result = await ownHistoryRead([id], () => sb.from('chat_messages').select(MESSAGE_COLUMNS)
    .eq('group_id',id).eq('id',message.id).limit(1));
  if (result.error) throw result.error;
  if (!Array.isArray(result.data) || result.data.length > 1) throw new Error('投稿を確認できません');
  const fresh = result.data[0];
  if (!fresh) return false;
  if (String(fresh.group_id) !== String(id) || String(fresh.id) !== String(message.id)) throw new Error('投稿の識別子が一致しません');
  if (shouldHideAdminNotice(fresh,group)) return false;
  lastMessages[id] = fresh;
  if (Number(currentGroupId) === Number(id)) {
    const index = currentMessages.findIndex(m=>String(m.id)===String(fresh.id));
    if (index >= 0) { currentMessages[index]=fresh; quotedMessages.delete(fresh.id); renderMessageList(); }
    else addMessageToUI(fresh);
  }
  renderGroups(); return fresh;
}
async function ownHistorySettleSend(message, lease, settleVisible = () => {}) {
  if (!ownHistoryV1(findMineGroup(message.group_id)) && lease.valid() && lease.editorValid()) return false;
  // Commit success is independent of display; never send a second INSERT or
  // consume a newer editor/pending object merely to repair this projection.
  if (!lease.identityValid() || !ownHistoryAuthorized(message.group_id)) return true;
  try { await ownHistoryAcceptMessage(message); } catch (_) { /* Read failure is not send failure. */ }
  if (lease.valid() && lease.editorValid()) settleVisible();
  if (lease.identityValid() && ownHistoryAuthorized(message.group_id)) dispatchPushForMessage(message.id);
  return true;
}
async function ownHistoryIncoming(message) {
  const fresh = await ownHistoryAcceptMessage(message);
  const group = findMineGroup(message.group_id);
  if (fresh && group?.hidden_at && fresh.user_id !== currentUser?.id) {
    const scope = ownHistoryScope(group.id), lease = ownHistoryLease([group.id]), hidden = group.hidden_at;
    if (!scope.saving && !scope.intent && lease.valid()) {
      const {error} = await sb.rpc('chat_set_hidden', {p_group_id:group.id,p_hidden:false});
      if (!error && lease.valid() && group === findMineGroup(group.id) && group.hidden_at === hidden) group.hidden_at = null;
    }
  }
  await loadUnread();
  renderGroups();
  return !!fresh;
}
async function ownHistoryRefresh() {
  const ids = myGroups.filter(g => ownHistoryV1(g) && ownHistoryAuthorized(g.id)).map(g=>g.id);
  if (!ids.length || !currentUser) return;
  await ownHistoryStates(ids);
  const id = currentGroupId;
  if (id && ids.includes(id) && ownHistoryAuthorized(id)) {
    const lease = ownHistoryLease([id]);
    const result = await ownHistoryRead([id], () => sb.from('chat_messages').select(MESSAGE_COLUMNS)
      .eq('group_id',id).order('created_at',{ascending:false}).limit(MESSAGE_PAGE_SIZE));
    if (result.error) throw result.error;
    if (lease.valid() && Number(currentGroupId)===Number(id)) await setMessages((result.data || []).slice().reverse());
  }
  await loadLastMessages();
  renderGroups();
  await loadUnread();
}
function ownHistoryIntentKey(owner, id) { return OWN_HISTORY_INTENT_PREFIX + owner + ':' + id; }
let ownHistoryResuming = false;
async function ownHistoryResume() {
  if (!currentUser || ownHistoryResuming || !myGroups.some(ownHistoryV1)) return;
  ownHistoryResuming = true;
  myGroups.filter(ownHistoryV1).forEach(group => {
    group.own_history_unverified = true; ownHistoryInvalidate(group.id);
  });
  try { if (await loadGroups()) await ownHistoryRefresh(); }
  catch (_) { /* Preserve the editor and fail closed until an authoritative read succeeds. */ }
  finally { ownHistoryResuming = false; }
}
window.addEventListener('online', () => { void ownHistoryResume(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void ownHistoryResume(); });
async function ownHistoryPoll() {
  if (!currentUser || ownHistoryResuming || !myGroups.some(ownHistoryV1)) return;
  ownHistoryResuming = true;
  const before = ownHistoryGeneration;
  try {
    if (!await loadGroups()) return;
    const ids = myGroups.filter(g => ownHistoryV1(g) && ownHistoryAuthorized(g.id)).map(g=>g.id);
    if (ids.length) await ownHistoryStates(ids);
    // An unchanged poll must not throw away older pages, scroll or the editor.
    if (before !== ownHistoryGeneration) await ownHistoryRefresh();
  } catch (_) { /* Authoritative readers already redact on failure. */ }
  finally { ownHistoryResuming = false; }
}
setInterval(() => { if (!document.hidden) void ownHistoryPoll(); }, 20000);
function ownHistoryStoredIntent(key, id) {
  let raw = localStorage.getItem(key);
  if (raw === null) {
    const journalKeys = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (name?.startsWith(key + ':')) journalKeys.push(name);
    }
    journalKeys.sort();
    if (journalKeys.length) raw = localStorage.getItem(journalKeys[0]);
  }
  if (raw === null) return null;
  const intent = JSON.parse(raw);
  if (!intent || intent.user_id !== currentUser?.id || intent.group_id !== String(id)
    || !ownHistoryUuid(intent.request_id) || !ownHistoryDecimal(intent.expected_revision)
    || !['clear','read'].includes(intent.kind) || intent.contract_version !== 1) throw new Error('保存済み操作の確認が必要です');
  return Object.freeze(intent);
}
function ownHistoryRejectedKey(intent) {
  return OWN_HISTORY_REJECTED_PREFIX + intent.user_id + ':' + intent.group_id + ':' + intent.request_id;
}
function ownHistoryRejection(intent) {
  if (!intent) return null;
  const raw = localStorage.getItem(ownHistoryRejectedKey(intent));
  if (raw === null) return null;
  const record = JSON.parse(raw);
  if (!record || JSON.stringify(record.intent) !== JSON.stringify(intent)
    || record.reason !== 'OWN_HISTORY_STALE_REVISION' || typeof record.acknowledged !== 'boolean') {
    throw new Error('拒否記録の確認が必要です');
  }
  return record;
}
function ownHistorySaveRejection(intent, acknowledged) {
  const key = ownHistoryRejectedKey(intent);
  const raw = JSON.stringify({intent,reason:'OWN_HISTORY_STALE_REVISION',acknowledged});
  localStorage.setItem(key,raw);
  if (localStorage.getItem(key) !== raw) throw new Error('拒否記録を端末に保存できませんでした');
}
async function ownHistoryAcknowledgeRejection(id, intent) {
  const scope = ownHistoryScope(id), lease = ownHistoryLease([id]);
  if (!intent || scope.intent !== intent || scope.saving || !lease.valid() || !ownHistoryRejection(intent)) return false;
  // This is an explicit acknowledgement of this initial rejected request only.
  // Archive before deleting its guard. Never use not_found as rejection proof.
  ownHistorySaveRejection(intent,true);
  ownHistoryRemoveIntent(scope,intent);
  scope.intent = null; scope.proof = null; scope.needsFresh = true; ++scope.statusSequence;
  return true;
}
function ownHistoryRemoveIntent(scope, intent) {
  localStorage.removeItem(scope.key + ':' + intent.request_id);
  if (localStorage.getItem(scope.key + ':' + intent.request_id) !== null) throw new Error('操作の保存状態を確認できません');
  const raw = localStorage.getItem(scope.key);
  if (raw !== null && JSON.parse(raw).request_id === intent.request_id) {
    localStorage.removeItem(scope.key);
    const remaining = localStorage.getItem(scope.key);
    if (remaining !== null && JSON.parse(remaining).request_id === intent.request_id) throw new Error('操作の保存状態を確認できません');
  }
}
function ownHistoryScope(id) {
  const key = ownHistoryIntentKey(currentUser?.id, id);
  if (!ownHistoryScopes.has(key)) ownHistoryScopes.set(key, {key,intent:null,saving:false,statusSequence:0,proof:null});
  const scope = ownHistoryScopes.get(key);
  if (!scope.intent && !scope.saving) scope.intent = ownHistoryStoredIntent(key,id);
  return scope;
}
function ownHistoryReceipt(data, intent, notFound = false) {
  if (!data || data.contract_version !== 1 || data.user_id !== intent.user_id || data.group_id !== intent.group_id
    || data.request_id !== intent.request_id) throw new Error('操作結果の識別子が一致しません');
  if (notFound && data.status === 'not_found') return data;
  if (data.status !== 'applied' || data.kind !== intent.kind || !ownHistoryDecimal(data.applied_revision)
    || BigInt(data.applied_revision) !== BigInt(intent.expected_revision) + (intent.kind === 'clear' ? 1n : 0n)) throw new Error('操作結果の形式が不正です');
  if (intent.kind === 'read') {
    const utc = value => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value));
    if (data.snapshot_latest !== null && (!data.snapshot_latest || !ownHistoryDecimal(data.snapshot_latest.id)
      || data.snapshot_latest.id === '0' || !utc(data.snapshot_latest.created_at))) throw new Error('既読境界が不正です');
    if (data.effective_last_read_at !== null && !utc(data.effective_last_read_at)) throw new Error('既読時刻が不正です');
    if (data.snapshot_latest && (!data.effective_last_read_at || Date.parse(data.effective_last_read_at) < Date.parse(data.snapshot_latest.created_at))) throw new Error('既読時刻が境界より前です');
  }
  return data;
}
async function ownHistoryCapability(lease) {
  const {data, error} = await sb.rpc('chat_own_history_capabilities_v1');
  if (!lease.valid()) throw new Error('操作の有効期限が切れました');
  if (error || !data || data.contract_version !== 1 || data.own_clear_supported !== true
    || data.mark_read_supported !== true || data.snapshot_semantics !== 'statement_visible_ids') throw new Error('このサーバーは本人履歴削除v1に対応していません');
}
async function ownHistoryCommand(id, kind, retry = false, queuedValid = () => true) {
  if (!ownHistoryGroupId(id)) throw new Error('このルームの識別子を安全に扱えません');
  if (!['clear','read'].includes(kind) || !ownHistoryAuthorized(id)) return false;
  const group = myGroups.find(g => String(g.id) === String(id));
  if (!ownHistoryV1(group)) throw new Error('旧形式のルームではこの操作を利用できません');
  if (!retry && group.own_history_unverified) throw new Error('履歴状態を再確認してから操作してください');
  const scope = ownHistoryScope(id);
  if (scope.saving || (scope.intent && !retry)) return false;
  if (retry && (!scope.intent || scope.intent.kind !== kind)) return false;
  if (scope.intent && ownHistoryRejection(scope.intent)) return false;
  if (!retry && scope.needsFresh) {
    await ownHistoryStates([id]);
    if (!queuedValid() || !ownHistoryAuthorized(id) || scope.saving || scope.intent) return false;
    scope.needsFresh = false;
  }
  const initialAttempt = !retry && !scope.intent;
  const lease = ownHistoryLease([id]);
  if (!lease.valid() || !queuedValid()) return false;
  const ownerEpoch = ownHistoryOwnerEpoch;
  const ownerContinuous = () => ownerEpoch === ownHistoryOwnerEpoch && lease.owner === currentUser?.id
    && lease.owner === ownHistorySessionOwner;
  if (!retry && kind === 'clear' && !confirm(`${roomTitle(group)} (ルーム ${group.id})\n自分の過去のトーク履歴を削除します。\n同じアカウントの端末に共有され、元に戻せません。新しい投稿が届くと新着から表示します。\n他の参加者・Keep・アルバム・個人メモ・下書きは削除しません。`)) return false;
  if (!lease.valid() || !queuedValid()) return false;
  scope.saving = true;
  scope.proof = null; ++scope.statusSequence;
  let sent = false;
  try {
    await ownHistoryCapability(lease);
    if (!lease.valid() || !queuedValid()) return false;
    if (!scope.intent) {
      scope.intent = Object.freeze({contract_version:1, user_id:lease.owner, group_id:String(id), kind,
        target_name: roomTitle(group),
        request_id:crypto.randomUUID(), expected_revision:group.own_history_revision});
      try {
        const frozen = JSON.stringify(scope.intent);
        const journalKey = scope.key + ':' + scope.intent.request_id;
        localStorage.setItem(journalKey, frozen);
        localStorage.setItem(scope.key, frozen);
        if (localStorage.getItem(journalKey) !== frozen) throw new Error('操作を端末に保存できませんでした');
      }
      catch (error) { scope.intent = null; throw error; }
    }
    if (!lease.valid() || !queuedValid()) return false;
    const intent = scope.intent;
    if (kind === 'clear') ownHistoryInvalidate(id);
    const afterStart = ownHistoryLease([id]);
    sent = true;
    const {data, error} = await sb.rpc(kind === 'clear' ? 'chat_clear_own_history_v1' : 'chat_mark_room_read_v1', {
      p_group_id:intent.group_id, p_request_id:intent.request_id,
      p_expected_revision:intent.expected_revision, p_contract_version:1
    });
    // Record exact initial refusal independently of an obsolete display lease.
    // Never lend this evidence to another account lifetime or a changed journal.
    if (error && initialAttempt && data === null && error.code === '22023'
      && error.message === 'OWN_HISTORY_STALE_REVISION' && error.details === null && error.hint === null
      && ownerContinuous() && scope.intent === intent
      && scope.key === ownHistoryIntentKey(intent.user_id,intent.group_id)
      && localStorage.getItem(scope.key + ':' + intent.request_id) === JSON.stringify(intent)) {
        ownHistorySaveRejection(intent,false);
    }
    if (!afterStart.valid()) return false;
    if (error) {
      throw error;
    }
    ownHistoryReceipt(data, intent);
    // A valid receipt settles only this fixed intent, not any later operation.
    ownHistoryRemoveIntent(scope, intent);
    scope.intent = null;
    ++unreadRequestSequence;
    await ownHistoryStates([id]);
    if (lease.owner === currentUser?.id && lease.session === ownHistorySession && lease.epoch === ownHistoryAuthEpoch) await loadUnread();
    return true;
  } finally {
    scope.saving = false;
    if (sent && ownerContinuous() && ownHistoryAuthorized(id)) renderGroups();
  }
}
