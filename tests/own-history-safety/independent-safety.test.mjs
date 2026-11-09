import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,CAP,state,receipt,tick,deferred,groupsQuery,standardRpc} from './fixture.mjs';
const post={id:101,group_id:10,user_id:OWNER,username:'合成利用者',content:'合成・古い投稿本文',created_at:'2026-01-01T00:00:00Z'};
const trace=(id,data)=>console.log('OBSERVATION '+JSON.stringify({id,...data}));

test('SAFE concurrent actual reviewer refresh cannot revive held pre-denial search via stale allow',async()=>{
 const f=await fixture();try{
  const a=deferred(),b=deferred(),raw=deferred();let n=0;
  f.rpc(standardRpc);f.query(async(table,ops)=>{
   if(table==='chat_user_access')return (++n===1?a:b).promise;
   if(table==='chat_messages')return raw.promise;
   return undefined;
  });
  f.run('currentChatAccess.can_review_access=true');
  const older=f.run('handleCurrentChatAccessChange()');await tick();
  const newer=f.run('handleCurrentChatAccessChange()');await tick();
  f.run("$('talkSearch').value='古い'");const search=f.run("runMessageSearch('古い')");await tick();
  const gen=f.run('ownHistoryGeneration');
  b.resolve({data:{access_enabled:true,signup_status:'approved',can_review_access:false}});await newer;
  assert.equal(f.run('currentChatAccess.can_review_access'),false,'denial observed by actual handler');
  a.resolve({data:{access_enabled:true,signup_status:'approved',can_review_access:true}});await older;
  raw.resolve({data:[post]});await search;
  const hits=f.run('JSON.stringify(messageSearchHits)');
  trace('reviewer-ABA-real-handlers',{generationBefore:gen,generationAfter:f.run('ownHistoryGeneration'),reviewer:f.run('currentChatAccess.can_review_access'),hits:JSON.parse(hits)});
  assert.equal(hits.includes(post.content),false,'old allow completion must not revive a lease that crossed observed reviewer denial');
 }finally{await f.close();}
});

for(const mutate of ['session-exchange','logout-same-owner','jwt-inplace','reviewer-event'])test('SAFE actual held search rejects '+mutate,async()=>{
 const f=await fixture();try{
  const raw=deferred();f.rpc(standardRpc);f.query(async(table)=>{
   if(table==='chat_messages')return raw.promise;
   if(table==='chat_user_access')return {data:{access_enabled:true,signup_status:'approved',can_review_access:false}};
   return undefined;
  });
  f.run("currentChatAccess.can_review_access=true;$('talkSearch').value='古い'");
  const search=f.run("runMessageSearch('古い')");await tick();
  if(mutate==='session-exchange')f.run('ownHistorySetSession({...ownHistorySession})');
  if(mutate==='logout-same-owner'){f.listeners.forEach(fn=>fn('SIGNED_OUT',null));f.listeners.forEach(fn=>fn('SIGNED_IN',{...f.session}));}
  if(mutate==='jwt-inplace')f.session.access_token='synthetic-replaced-jwt';
  if(mutate==='reviewer-event')await f.run('handleCurrentChatAccessChange()');
  raw.resolve({data:[post]});await search;
  assert.equal(f.run('JSON.stringify(messageSearchHits)').includes(post.content),false);
 }finally{await f.close();}
});

for(const change of ["$('talkSearch').value='変更';handleTalkSearchInput()","talkTab='groups'","renderGroups()"] )test('SAFE held capability cannot start row write after '+change,async()=>{
 const f=await fixture();try{
  const held=deferred();f.rpc(async(name)=>name==='chat_own_history_capabilities_v1'?held.promise:undefined);
  f.run('renderGroups()');f.w.document.querySelector('.swipe-clear').click();await tick();
  f.run(change);held.resolve({data:CAP});await tick();await tick();
  assert.equal(f.calls.filter(x=>x.rpc==='chat_clear_own_history_v1').length,0);
  assert.equal(f.w.localStorage.length,0);
 }finally{await f.close();}
});

for(const send of ["sendChatText('返却待ち',{withReply:true})","sendSticker('synthetic')","sendChatImage({name:'synthetic.png',type:'image/png'})","sendChatFile({name:'synthetic.txt',type:'text/plain'})","sendCardCommand('合成要求')"])test('SAFE all five senders settle masked committed receipt once, no body/pending loss: '+send,async()=>{
 const f=await fixture();try{
  const held=deferred();let states=0;
  f.rpc(async(name,body)=>name==='chat_own_history_states_v1'?(states++,{data:state(body.p_group_ids,'1',true)}):undefined);
  f.query(async(table,ops)=>table==='chat_messages'?(ops.some(o=>o[0]==='insert')?held.promise:{data:[]}):undefined);
  f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;uploadChatImage=async()=>({path:'synthetic/a',width:1,height:1});uploadChatFile=async()=>({path:'synthetic/b',name:'synthetic.txt'});archiveChatImageInMediaLibrary=async()=>{};dispatchPushForMessage=()=>{};pendingSendFiles=[{id:'preserve'}];currentPrivateNotes=[{id:7,content:'独立メモ'}];keepItems=[{id:8,content:'独立Keep'}];albums=[{id:9,name:'独立アルバム'}];");
  const refs=f.run('[pendingSendFiles,currentPrivateNotes,keepItems,albums]');
  const sent=f.run(send);await tick();f.run("$('messageInput').value='次の下書き';replyTarget={id:222,content:'次の引用'};isPrivateNoteMode=true");
  const reply=f.run('replyTarget');held.resolve({data:post});const ok=await sent;
  assert.equal(ok,true,'committed receipt is not an unsent failure');
  assert.equal(f.calls.filter(x=>x.ops?.some(o=>o[0]==='insert')).length,1,'no second INSERT');
  assert.ok(states>=2,'state-before and state-after');
  assert.equal(f.run('currentMessages.length'),0);assert.equal(f.run('lastMessages[10]'),undefined);
  assert.equal(f.run('replyTarget'),reply);assert.equal(f.run('isPrivateNoteMode'),true);
  assert.equal(f.w.document.getElementById('messageInput').value,'次の下書き');
  for(let i=0;i<4;i++)assert.equal(f.run('[pendingSendFiles,currentPrivateNotes,keepItems,albums]')[i],refs[i]);
 }finally{await f.close();}
});

test('SAFE failed authoritative state never falls into raw SELECT or legacy acceptance',async()=>{
 const f=await fixture();try{
  f.rpc(async(name)=>name==='chat_own_history_states_v1'?{error:{code:'synthetic',message:'read failed'}}:undefined);
  await assert.rejects(f.run('ownHistoryRead([10],()=>sb.from("chat_messages").select("id").eq("group_id",10))'));
  assert.equal(f.calls.some(x=>x.table),false);assert.equal(f.run('myGroups[0].own_history_unverified'),true);
  assert.equal(f.run('ownHistoryV1(myGroups[0])'),true);
 }finally{await f.close();}
});

test('SAFE not_found while first request is still possible retains immutable journal and excludes new operation',async()=>{
 const f=await fixture();try{
  let first;f.rpc(async(name,body)=>{
   if(name==='chat_own_history_capabilities_v1')return {data:CAP};
   if(name==='chat_clear_own_history_v1'){first=body;throw Error('lost after server admission');}
   if(name==='chat_own_history_operation_v1')return {data:{contract_version:1,user_id:OWNER,group_id:'10',request_id:body.p_request_id,status:'not_found'}};
   return undefined;
  });
  await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));
  const intent=f.run('ownHistoryScope(10).intent');
  const status=await f.run('ownHistoryOperationStatus(10)');assert.equal(status.status,'not_found');
  assert.equal(f.run('ownHistoryAcknowledge(10,ownHistoryScope(10).proof)'),false);
  assert.equal(await f.run("ownHistoryCommand(10,'clear')"),false);
  assert.equal(f.run('ownHistoryScope(10).intent'),intent);assert.equal(intent.request_id,first.p_request_id);
  f.run('ownHistoryScopes.clear()');assert.equal(f.run('ownHistoryScope(10).intent.request_id'),first.p_request_id);
  assert.equal(f.w.localStorage.length,2);
 }finally{await f.close();}
});

for(const variant of ['wrong-owner','numeric-revision','duplicate-room'])test('SAFE malformed typed states rejected before raw reader: '+variant,async()=>{
 const f=await fixture();try{
  f.rpc(async(name,body)=>{
   if(name!=='chat_own_history_states_v1')return undefined;
   const rows=state(body.p_group_ids);
   if(variant==='wrong-owner')rows[0].user_id='22222222-2222-4222-8222-222222222222';
   if(variant==='numeric-revision')rows[0].revision=0;
   if(variant==='duplicate-room')rows.push(rows[0]);
   return {data:rows};
  });
  await assert.rejects(f.run('ownHistoryRead([10],()=>sb.from("chat_messages").select("id").eq("group_id",10))'));
  assert.equal(f.calls.some(x=>x.table),false);
 }finally{await f.close();}
});

test('SAFE frozen journal survives later state-read failure without touching saved data or pending objects',async()=>{
 const f=await fixture();try{
  f.run("pendingSendFiles=[{id:'pending'}];keepItems=[{id:1,content:'Keep'}];albums=[{id:2,name:'album'}];currentPrivateNotes=[{id:3,content:'memo'}];currentGroupId=10;currentRoomMembership=myGroups[0].membership;$('messageInput').value='draft';");
  const refs=f.run('[pendingSendFiles,keepItems,albums,currentPrivateNotes]');
  f.rpc(async(name)=>name==='chat_own_history_capabilities_v1'?{data:CAP}:name==='chat_clear_own_history_v1'?{error:Error('unknown')}:name==='chat_own_history_states_v1'?{error:Error('state unavailable')}:undefined);
  await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));const intent=f.run('ownHistoryScope(10).intent');
  await assert.rejects(f.run('ownHistoryStates([10])'));
  assert.equal(f.run('ownHistoryScope(10).intent'),intent);assert.equal(f.run('myGroups.length'),1);
  assert.equal(f.w.document.getElementById('messageInput').value,'draft');
  for(let i=0;i<4;i++)assert.equal(f.run('[pendingSendFiles,keepItems,albums,currentPrivateNotes]')[i],refs[i]);
 }finally{await f.close();}
});
