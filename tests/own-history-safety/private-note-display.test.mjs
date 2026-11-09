import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,deferred,tick,exactPrivateNoteInsert} from './fixture.mjs';
for(const change of ['unchanged','other-room','room-ABA','owner','logout-login','refresh','modal-new-draft','modal-reopen'])test('L04 actual savePrivateNote commit/display ownership '+change,async()=>{
 const f=await fixture();try{
 const held=deferred();let payload;
 f.query(async(t,ops)=>{if(t==='chat_private_notes'&&exactPrivateNoteInsert(ops,'room10旧メモ')){payload=ops.find(o=>o[0]==='insert')[1];return held.promise;}});
 f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;openPrivateNoteComposer();$('privateNoteInput').value='room10旧メモ'");
 const saving=f.run('savePrivateNote()');await tick();assert.ok(payload);
 if(change==='other-room')f.run('currentGroupId=11;++selectGroupSeq;currentPrivateNotes=[]');
 if(change==='room-ABA')f.run('currentGroupId=11;++selectGroupSeq;currentGroupId=10;++selectGroupSeq;currentPrivateNotes=[]');
 if(change==='owner')f.run("currentUser={id:'22222222-2222-4222-8222-222222222222'};currentPrivateNotes=[]");
 if(change==='logout-login'){f.listeners.forEach(fn=>fn('SIGNED_OUT',null));f.listeners.forEach(fn=>fn('SIGNED_IN',f.session));}
 if(change==='refresh')f.listeners.forEach(fn=>fn('TOKEN_REFRESHED',{user:{id:OWNER},access_token:'synthetic-new'}));
 if(change==='modal-new-draft')f.run("$('privateNoteInput').value='新メモ';$('privateNoteInput').dispatchEvent(new Event('input'))");
 if(change==='modal-reopen')f.run("closePrivateNoteComposer();openPrivateNoteComposer();$('privateNoteInput').value='room10旧メモ'");
 const notes=f.run('currentPrivateNotes');
 held.resolve({data:{id:901,...payload,created_at:'2026-01-01T00:00:00Z'}});assert.equal(await saving,true,'committed note is not an unsaved retry');
 assert.equal(f.calls.filter(c=>c.table==='chat_private_notes'&&c.ops.some(o=>o[0]==='insert')).length,1);
 if(['unchanged','modal-new-draft','modal-reopen'].includes(change)){assert.equal(f.run('currentPrivateNotes.length'),1);assert.match(f.w.document.getElementById('messages').textContent,/room10旧メモ/);}
 else {assert.equal(f.run('currentPrivateNotes'),notes);assert.equal(f.run('currentPrivateNotes.length'),0);assert.doesNotMatch(f.w.document.getElementById('messages').textContent,/room10旧メモ/);}
 assert.equal(f.w.document.getElementById('privateNoteOverlay').classList.contains('hidden'),change==='unchanged');
 }finally{await f.close();}
});
