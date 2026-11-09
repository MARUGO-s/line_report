import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, OWNER, deferred, tick, standardRpc, exactPrivateNoteInsert} from './fixture.mjs';
for (const change of ['unchanged','input-ABA','option-ABA','room-ABA','session-refresh','selection','new-pending']) test('L03 actual private send editor settlement '+change, async()=>{
 const f=await fixture();try {
  const held=deferred();let payload;
  f.query(async(t,ops)=>{if(t==='chat_private_notes'&&exactPrivateNoteInsert(ops,'保存メモ')){payload=ops.find(o=>o[0]==='insert')[1];return held.promise;}});
  f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;$('messageInput').value='保存メモ';togglePrivateNoteMode()");
  const input=f.w.document.getElementById('messageInput');input.setSelectionRange(1,2,'backward');
  const sending=f.run('sendMessage()');await tick();assert.ok(payload);
  if(change==='input-ABA') f.run("$('messageInput').value='途中';$('messageInput').dispatchEvent(new Event('input'));$('messageInput').value='保存メモ';$('messageInput').dispatchEvent(new Event('input'))");
  if(change==='option-ABA') f.run('togglePrivateNoteMode();togglePrivateNoteMode()');
  if(change==='room-ABA') f.run('currentGroupId=11;++selectGroupSeq;currentGroupId=10;++selectGroupSeq');
  if(change==='session-refresh') f.listeners.forEach(fn=>fn('TOKEN_REFRESHED',{user:{id:OWNER},access_token:'synthetic-new'}));
  if(change==='selection') input.setSelectionRange(0,3,'forward');
  if(change==='new-pending') { f.w.__file=new f.w.File(['actual pending bytes'],'new.png',{type:'image/png'}); f.run('pendingSendFiles=[__file]'); }
  const pending=f.run('pendingSendFiles'), selection=[input.selectionStart,input.selectionEnd,input.selectionDirection];
  held.resolve({data:{id:901,...payload,created_at:'2026-01-01T00:00:00Z'}});await sending;
  assert.equal(f.calls.filter(c=>c.table==='chat_private_notes'&&c.ops.some(o=>o[0]==='insert')).length,1);
  assert.equal(f.run('pendingSendFiles'),pending);
  if(change==='unchanged'){assert.equal(input.value,'');assert.equal(f.run('isPrivateNoteMode'),false);assert.match(f.w.document.getElementById('messages').textContent,/保存メモ/);}
  else {assert.equal(input.value,'保存メモ');assert.equal(f.run('isPrivateNoteMode'),true);assert.deepEqual([input.selectionStart,input.selectionEnd,input.selectionDirection],selection);}
 }finally{await f.close();}
});
for(const change of ['new-draft','new-edit']) test('L03 actual edit branch does not settle newer editor '+change,async()=>{
 const f=await fixture();try{
 const held=deferred();let payload;
 f.rpc(standardRpc);
 f.query(async(t,ops)=>{if(t==='chat_messages'&&ops.some(o=>o[0]==='update')){payload=ops.find(o=>o[0]==='update')[1];return held.promise;}if(t==='chat_messages')return {data:[]};});
 f.run(`currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentMessages=[{id:101,group_id:10,user_id:'${OWNER}',content:'old',kind:'text'}];startMessageEdit(currentMessages[0]);$('messageInput').value='保存編集'`);
 const sending=f.run('sendMessage()');await tick();assert.ok(payload);
 f.run("$('messageInput').value='次のdraft';$('messageInput').dispatchEvent(new Event('input'))");
 if(change==='new-edit')f.run("editingMessage={id:202,group_id:10,user_id:currentUser.id,kind:'text',content:'次の編集'}");
 const editing=f.run('editingMessage');
 held.resolve({data:{id:101,group_id:10,user_id:OWNER,kind:'text',...payload}});await sending;
 assert.equal(f.w.document.getElementById('messageInput').value,'次のdraft');assert.equal(f.run('editingMessage'),editing);
 }finally{await f.close();}
});
