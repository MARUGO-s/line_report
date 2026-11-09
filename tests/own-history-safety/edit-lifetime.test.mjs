import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, OWNER, deferred, tick, standardRpc} from './fixture.mjs';

// Exercise real sendMessage -> saveEditedMessage. Only the database boundary is held.
for (const outcome of ['success', 'failure']) for (const change of [
  'normal', 'same-text-new-edit', 'same-edit-cancel-reopen', 'same-object-restart',
  'new-object-same-id', 'cancel-only', 'different-room', 'room-ABA',
  'session-refresh', 'owner-ABA', 'selection', 'IME-input', 'pending', 'option-ABA', 'row-access'
]) {
  test('L03 edit lifetime SAFE ' + outcome + ' ' + change, {timeout:5000}, async () => {
    const f = await fixture();
    try {
      const held = deferred();
      let payload;
      f.rpc(standardRpc);
      f.query(async (table, ops) => {
        if (table !== 'chat_messages') return undefined;
        const update = ops.find(o => o[0] === 'update');
        if (update) {
          payload = structuredClone(update[1]);
          assert.deepEqual(ops.slice(1, 3), [['eq', 'id', 101], ['eq', 'user_id', OWNER]]);
          assert.deepEqual(ops.slice(-2).map(o => o[0]), ['select', 'single']);
          return held.promise;
        }
        if (ops.some(o => o[0] === 'select')) return {data:[]};
      });
      f.run(`currentGroupId=10;currentRoomMembership=myGroups[0].membership;
        currentMessages=[101,202].map(id=>({id,group_id:10,user_id:'${OWNER}',content:'保存編集',kind:'text'}));
        startMessageEdit(currentMessages[0]);$('messageInput').dispatchEvent(new Event('input'));`);
      const input = f.w.document.getElementById('messageInput');
      const sending = f.run('sendMessage()');
      await tick();
      assert.deepEqual(payload, {content:'保存編集', mentions:[]});
      if (change === 'same-text-new-edit') f.run('startMessageEdit(currentMessages[1])');
      if (change === 'same-edit-cancel-reopen') f.run('cancelMessageEdit();startMessageEdit(currentMessages[0])');
      if (change === 'same-object-restart') f.run('startMessageEdit(currentMessages[0])');
      if (change === 'new-object-same-id') f.run('startMessageEdit({...currentMessages[0]})');
      if (change === 'cancel-only') f.run('cancelMessageEdit()');
      if (change === 'different-room') f.run('currentGroupId=11;++selectGroupSeq;currentMessages=[]');
      if (change === 'room-ABA') f.run('currentGroupId=11;++selectGroupSeq;currentGroupId=10;++selectGroupSeq');
      if (change === 'session-refresh') f.listeners.forEach(fn => fn('TOKEN_REFRESHED', {user:{id:OWNER},access_token:'synthetic-new'}));
      if (change === 'owner-ABA') for (const id of ['22222222-2222-4222-8222-222222222222', OWNER]) {
        f.w.__owner = id;
        f.run('currentUser={id:__owner};ownHistorySetSession({user:{id:__owner},access_token:"synthetic-owner"},true)');
      }
      if (change === 'selection') input.setSelectionRange(0, 1, 'backward');
      if (change === 'IME-input') f.run(`$('messageInput').dispatchEvent(new CompositionEvent('compositionstart'));
        $('messageInput').value='新しい変換中';$('messageInput').dispatchEvent(new InputEvent('input',{inputType:'insertCompositionText',isComposing:true,data:'中'}))`);
      if (change === 'pending') f.run("pendingSendFiles=[new File(['frozen bytes'],'new.txt')]");
      if (change === 'option-ABA') f.run('toggleSilentSend();toggleSilentSend()');
      if (change === 'row-access') f.run('currentChatAccess.can_review_access=true');
      const expected = {value:input.value, editing:f.run('editingMessage'), pending:f.run('pendingSendFiles'),
        silent:f.run('isSilentSendActive'), note:f.run('isPrivateNoteMode'),
        selection:[input.selectionStart,input.selectionEnd,input.selectionDirection]};
      held.resolve(outcome === 'success'
        ? {data:{id:101,group_id:10,user_id:OWNER,kind:'text',...payload}}
        : {data:null,error:{message:'synthetic edit failure'}});
      await sending;
      await tick();await tick();
      assert.equal(f.calls.filter(c => c.ops?.some(o => o[0] === 'update')).length, 1, 'exactly one commit; no automatic replay');
      assert.deepEqual(f.alerts, outcome === 'failure' && change === 'normal' ? ['synthetic edit failure'] : [],
        'obsolete completion must not show an error in the newer editor');
      if (change === 'normal' && outcome === 'success') {
        assert.equal(input.value, '', 'legitimate helper transition must allow outer settlement');
        assert.equal(f.run('editingMessage'), null);
        assert.equal(f.w.document.getElementById('composerModeChip').classList.contains('visible'), false);
        assert.equal(f.w.document.getElementById('composerSendBtn').getAttribute('aria-label'), '送信');
      } else {
        assert.equal(input.value, expected.value, 'older commit must not consume a newer equal-text editor');
        assert.equal(f.run('editingMessage'), expected.editing);
        assert.equal(f.run('pendingSendFiles'), expected.pending);
        assert.equal(f.run('isSilentSendActive'), expected.silent);
        assert.equal(f.run('isPrivateNoteMode'), expected.note);
        assert.deepEqual([input.selectionStart,input.selectionEnd,input.selectionDirection], expected.selection);
      }
    } finally { await f.close(); }
  });
}
