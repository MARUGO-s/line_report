import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,CAP,state,receipt,tick,deferred,groupsQuery,standardRpc} from './fixture.mjs';
const post={id:101,group_id:10,user_id:OWNER,username:'合成利用者',content:'失効前の秘密本文',created_at:'2026-01-01T00:00:00Z'};
const trace=(id,data)=>console.log('OBSERVATION '+JSON.stringify({id,...data}));

for(const mode of ['poll-omission','realtime-delete'])test('SAFE membership ABA permanently invalidates held actual search: '+mode,async()=>{
 const f=await fixture();try{
  const held=deferred();f.rpc(standardRpc);
  const rawSelector=async(table,ops)=>table==='chat_messages'&&ops.find(o=>o[0]==='select')?.[1].startsWith('id, group_id')?held.promise:groupsQuery(false)(table,ops);
  f.query(rawSelector);f.run("$('talkSearch').value='秘密'");
  const old=f.run("runMessageSearch('秘密')");await tick();
  const gen=f.run('ownHistoryGeneration');
  if(mode==='poll-omission')await f.run('loadGroups()');else f.run('handleMemberRemoved({group_id:10,user_id:currentUser.id})');
  const denied=f.run('ownHistoryReadable(10)');
  f.query(async(table,ops)=>table==='chat_messages'&&ops.find(o=>o[0]==='select')?.[1].startsWith('id, group_id')?held.promise:groupsQuery(true)(table,ops));
  await f.run('loadGroups()');await tick();
  held.resolve({data:[post]});await old;
  const output=f.run('JSON.stringify(messageSearchHits)');
  trace('membership-ABA-'+mode,{wasDenied:!denied,generationBefore:gen,generationAfter:f.run('ownHistoryGeneration'),hits:JSON.parse(output),searchDom:f.w.document.getElementById('messageSearchList')?.textContent});
  assert.equal(output.includes(post.content),false,'observed denial must latch; regrant cannot revive a pre-denial read');
 }finally{await f.close();}
});

test('SAFE cached search plaintext disappears on observed membership revocation',async()=>{
 const f=await fixture();try{
  f.rpc(standardRpc);f.query(async(table)=>table==='chat_messages'?{data:[post]}:undefined);
  f.run("$('talkSearch').value='秘密'");await f.run("runMessageSearch('秘密')");
  assert.ok(f.w.document.body.textContent.includes(post.content),'positive actual search rendering');
  f.query(groupsQuery(false));
  await f.run('handleMembershipChanged({group_id:10,user_id:currentUser.id,can_view:false})');await tick();
  trace('rendered-membership-denial',{readable:f.run('ownHistoryReadable(10)'),bodyRetains:f.w.document.body.textContent.includes(post.content),cacheRetains:f.run('messageSearchHits.length')});
  assert.equal(f.w.document.body.textContent.includes(post.content),false,'revoked plaintext must be redacted, not merely disable click');
 }finally{await f.close();}
});

test('SAFE authoritative v1 cannot downgrade to legacy after denial/regrant with missing fields',async()=>{
 const f=await fixture();try{
  f.rpc(standardRpc);f.query(groupsQuery(false));await f.run('loadGroups()');
  f.query(groupsQuery(true,{legacy:true}));const accepted=await f.run('loadGroups()');await tick();
  const v1=f.run('ownHistoryV1(myGroups[0])');
  trace('v1-downgrade',{accepted,v1,groups:JSON.parse(f.run('JSON.stringify(myGroups)'))});
  assert.equal(accepted,false,'missing fields after known-v1 room must fail closed even across membership omission');
 }finally{await f.close();}
});

for(const sending of ["sendChatText('送信済み',{withReply:true})","sendSticker('synthetic','compact','送信済み')"])test('SAFE held receipt must not clear newer room reply target: '+sending,async()=>{
 const f=await fixture();try{
  const held=deferred();let inserted;f.rpc(standardRpc);f.query(async(table,ops)=>{
   if(table!=='chat_messages')return undefined;
   const insert=ops.find(o=>o[0]==='insert');
   if(insert){inserted={...post,...insert[1]};return held.promise;}
   return {data:[inserted]};
  });
  f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;dispatchPushForMessage=()=>{};");
  const send=f.run(sending);await tick();
  f.run("myGroups.push({id:11,group_name:'合成B',membership:{can_view:true,can_send:true},own_history_revision:'0',own_history_suppressed:false});currentGroupId=11;currentRoomMembership=myGroups[1].membership;++selectGroupSeq;replyTarget={id:222,group_id:11,content:'新しい引用'};$('replyBarText').textContent='新しい引用';$('messageInput').value='新しい下書き';");
  const reply=f.run('replyTarget');held.resolve({data:inserted});const ok=await send;
  trace('cross-room-reply',{ok,currentRoom:f.run('currentGroupId'),replyAfter:f.run('replyTarget'),messages:f.run('currentMessages.length'),input:f.w.document.getElementById('messageInput').value});
  assert.equal(f.run('currentMessages.length'),0,'receipt body must not enter other room');
  assert.equal(f.run('replyTarget'),reply,'old receipt must not settle a new room editor');
 }finally{await f.close();}
});

test('SAFE actual sendMessage preserves newer draft modes after masked held success',async()=>{
 const f=await fixture();try{
  const held=deferred();let inserts=0;f.rpc(async(name,body)=>name==='chat_own_history_states_v1'?{data:state(body.p_group_ids,'1',true)}:undefined);
  f.query(async(table,ops)=>{
   if(table==='chat_private_notes' && JSON.stringify(ops)===JSON.stringify([['insert',{group_id:10,user_id:OWNER,content:'次の個人メモ'}],['select','id, group_id, content, created_at'],['single']])) return {data:{id:501,group_id:10,content:'次の個人メモ',created_at:post.created_at}};
   if(table!=='chat_messages')return undefined;
   const insert=ops.find(o=>o[0]==='insert');
   if(!insert)return {data:[]};
   return ++inserts===1?held.promise:{data:{...post,id:102,content:insert[1].content}};
  });
  f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;dispatchPushForMessage=()=>{};$('messageInput').value='以前の送信';");
  const send=f.run('sendMessage()');await tick();
  f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}]);$('messageInput').value='次の個人メモ';togglePrivateNoteMode();");
  assert.equal(f.run('isPrivateNoteMode'),true,'actual toggle initially sets private mode');
  held.resolve({data:post});await send;
  const modeAfter=f.run('isPrivateNoteMode');
  await f.run('sendMessage()');
  const outgoing=f.calls.filter(c=>c.ops?.some(o=>o[0]==='insert')).map(c=>c.ops.find(o=>o[0]==='insert')[1]);
  trace('newer-draft-mode',{privateNoteAfterOldCommit:modeAfter,outgoing});
  assert.equal(modeAfter,true,'new private note must not become a public-send draft after old commit');
 }finally{await f.close();}
});

