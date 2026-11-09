import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,state,standardRpc,tick,deferred,groupsQuery,CAP} from './fixture.mjs';
const post={id:101,group_id:10,user_id:OWNER,username:'合成',kind:'text',content:'古い秘密',created_at:'2026-01-01T00:00:00Z'};
test('S05 held openForward directory completion cannot reopen cleared source',async()=>{
 const f=await fixture();try{const held=deferred();f.w.__hold=held.promise;f.w.__post=post;
 f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentMessages=[__post];currentChatAccess.can_browse_users=true;currentChatAccess.can_start_direct=true;loadRegisteredUsers=()=>__hold;");
 const opening=f.run('openForward(__post)');await tick();f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");held.resolve();await opening;
 assert.equal(f.w.document.getElementById('forwardOverlay').classList.contains('hidden'),true);assert.equal(f.run('forwardMessage'),null);
 }finally{await f.close();}
});
for(const mode of ['same-room','other-room','room-ABA','input-ABA','option-ABA'])test('L03 actual outer send preserves newer option/draft identity '+mode,async()=>{
 const f=await fixture();try{const held=deferred();let payload;
 f.rpc(standardRpc);f.query(async(t,ops)=>{if(t!=='chat_messages')return undefined;const insert=ops.find(o=>o[0]==='insert');if(insert){payload=structuredClone(insert[1]);return held.promise;}return {data:[{...post,...payload}]};});
 f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;dispatchPushForMessage=()=>{};$('messageInput').value='元送信';isSilentSendActive=true;");
 const sending=f.run('sendMessage()');await tick();const frozen=JSON.stringify(payload);
 if(mode==='other-room'||mode==='room-ABA')f.run("myGroups.push({...myGroups[0],id:11});currentGroupId=11;++selectGroupSeq;");
 if(mode==='room-ABA')f.run('currentGroupId=10;++selectGroupSeq');
 if(mode==='option-ABA')f.run('toggleSilentSend();toggleSilentSend()');
 else if(mode==='input-ABA')f.run("$('messageInput').value='変更';$('messageInput').dispatchEvent(new Event('input'));$('messageInput').value='';$('messageInput').dispatchEvent(new Event('input'))");
 else f.run("$('messageInput').value='新しい下書き';$('messageInput').dispatchEvent(new Event('input'));togglePrivateNoteMode()");
 const note=f.run('isPrivateNoteMode'),silent=f.run('isSilentSendActive'),text=f.w.document.getElementById('messageInput').value;
 held.resolve({data:{...post,...payload}});await sending;
 assert.equal(f.run('isPrivateNoteMode'),note);assert.equal(f.run('isSilentSendActive'),silent);assert.equal(f.w.document.getElementById('messageInput').value,text);assert.equal(JSON.stringify(payload),frozen);assert.equal(f.calls.filter(c=>c.ops?.some(o=>o[0]==='insert')).length,1);
 }finally{await f.close();}
});
for(const send of ["sendChatText('固定',{withReply:true})","sendSticker('synthetic','compact','固定')"])test('L02 room ABA preserves original reply object even same room '+send,async()=>{
 const f=await fixture();try{const held=deferred();let payload;f.rpc(standardRpc);f.query(async(t,o)=>{if(t!=='chat_messages')return undefined;const op=o.find(x=>x[0]==='insert');if(op){payload=op[1];return held.promise;}return {data:[{...post,...payload}]};});
 f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;replyTarget={id:7,content:'元返信'};dispatchPushForMessage=()=>{}");const reply=f.run('replyTarget');const sending=f.run(send);await tick();f.run('currentGroupId=11;++selectGroupSeq;currentGroupId=10;++selectGroupSeq');held.resolve({data:{...post,...payload}});assert.equal(await sending,true);assert.equal(f.run('replyTarget'),reply);
 }finally{await f.close();}
});
test('S01 pending journal and entitlement survive failure -> suppression -> authorized refresh',async()=>{
 const f=await fixture();try{
 f.rpc(async(n,p)=>n==='chat_own_history_capabilities_v1'?{data:CAP}:n==='chat_clear_own_history_v1'?{error:Error('unknown')}:n==='chat_unread_counts'?{data:[]}:n==='chat_own_history_states_v1'?{data:state(p.p_group_ids)}:undefined);
 await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));const intent=f.run('ownHistoryScope(10).intent');
 f.query(async()=>({error:Error('offline')}));assert.equal(await f.run('loadGroups()'),false);assert.equal(f.run('ownHistoryScope(10).intent'),intent);
 f.query(groupsQuery(true));assert.equal(await f.run('loadGroups()'),true);assert.equal(f.run('ownHistoryScope(10).intent'),intent);f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}]);renderGroups()");assert.equal(f.run('myGroups.length'),1);assert.equal(f.run('ownHistoryScope(10).intent'),intent);
 }finally{await f.close();}
});
for(const stateName of ['bootstrap','recovery','same-session-old-error'])test('S02 actual access loader preserves '+stateName,async()=>{
 const f=await fixture();try{const a=deferred();let count=0;f.query(async(t)=>t==='chat_user_access'?(stateName==='same-session-old-error'&&++count===1?a.promise:{data:{access_enabled:true,signup_status:'approved',can_review_access:true}}):undefined);
 if(stateName==='bootstrap')f.run('currentChatAccess=null');if(stateName==='recovery')f.run('currentChatAccess={access_enabled:false}');
 let older;if(stateName==='same-session-old-error'){older=f.run('loadCurrentChatAccess()');await tick();}
 await f.run('loadCurrentChatAccess()');if(older){a.resolve({error:Error('obsolete')});await older;}
 assert.equal(f.run('currentChatAccess.can_review_access'),true);assert.equal(f.run('chatAccessIsBlocked(currentChatAccess)'),false);
 }finally{await f.close();}
});
