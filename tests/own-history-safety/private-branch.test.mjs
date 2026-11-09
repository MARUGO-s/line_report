import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,tick,deferred,exactPrivateNoteInsert} from './fixture.mjs';
const stamp='2026-01-01T00:00:00Z';
for(const scenario of ['newer-private','newer-silent','cross-room-note'])test('SAFE L03 adjacent outer private branch exact preservation '+scenario,async()=>{
 const f=await fixture();try{
 const held=deferred();let payload;f.query(async(t,ops)=>{if(t!=='chat_private_notes'||!exactPrivateNoteInsert(ops,'個人メモA'))return undefined;payload=ops.find(x=>x[0]==='insert')[1];return held.promise;});
 f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;$('messageInput').value='個人メモA';togglePrivateNoteMode()");const send=f.run('sendMessage()');await tick();assert.ok(payload);
 if(scenario==='cross-room-note')f.run("myGroups.push({...myGroups[0],id:11});currentGroupId=11;currentRoomMembership=myGroups[1].membership;++selectGroupSeq;currentPrivateNotes=[];");
 f.run("$('messageInput').value='新draftB';$('messageInput').dispatchEvent(new Event('input'))");
 if(scenario==='newer-silent')f.run('toggleSilentSend()');
 const expected={text:f.w.document.getElementById('messageInput').value,note:f.run('isPrivateNoteMode'),silent:f.run('isSilentSendActive')};
 held.resolve({data:{id:901,...payload,created_at:stamp}});await send;
 const actual={text:f.w.document.getElementById('messageInput').value,note:f.run('isPrivateNoteMode'),silent:f.run('isSilentSendActive')};
 console.log('PRIVATE_BRANCH_INDEPENDENT '+JSON.stringify({scenario,expected,actual,room:f.run('currentGroupId'),privateNotes:JSON.parse(f.run('JSON.stringify(currentPrivateNotes)')),rendered:f.w.document.getElementById('messages').textContent}));
 if(scenario==='cross-room-note')assert.equal(f.run('currentPrivateNotes.some(n=>n.group_id!==currentGroupId)'),false,'room10 note must not be appended/rendered in room11');
 else assert.deepEqual(actual,expected,'old private commit may not consume newer draft/options');
 }finally{await f.close();}
});
