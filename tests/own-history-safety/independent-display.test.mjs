import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,state,standardRpc,tick,deferred} from './fixture.mjs';
const post={id:101,group_id:10,user_id:OWNER,username:'合成利用者',content:'削除前の引用秘密本文',kind:'text',created_at:'2026-01-01T00:00:00Z'};
const trace=(id,data)=>console.log('OBSERVATION '+JSON.stringify({id,...data}));

test('SAFE actual open message menu cannot resurrect cleared quote from captured msg',async()=>{
 const f=await fixture();try{
  f.w.__post=post;f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentMessages=[__post];renderMessageList();openMessageMenu(101,$('messages'));");
  const button=f.w.document.querySelector('.msg-menu [data-action="reply"]');assert.ok(button,'real reply menu present');
  f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");
  assert.equal(f.run('currentMessages.length'),0);
  button.click();
  const revived=f.w.document.getElementById('replyBarText').textContent;
  trace('quote-menu-after-clear',{quote:revived,reply:f.run('replyTarget'),currentMessages:f.run('currentMessages.length')});
  assert.equal(revived.includes(post.content),false,'captured old menu action must not put an excluded body back in reply UI');
 }finally{await f.close();}
});

test('SAFE displayed search is redacted when actual auth listener exchanges same-owner session',async()=>{
 const f=await fixture();try{
  f.rpc(standardRpc);f.query(async(table)=>table==='chat_messages'?{data:[post]}:undefined);
  f.run("$('talkSearch').value='引用'");await f.run("runMessageSearch('引用')");
  assert.ok(f.w.document.getElementById('messageSearchList').textContent.includes(post.content));
  f.listeners.forEach(fn=>fn('SIGNED_IN',{...f.session}));
  trace('cached-session-exchange',{readable:f.run('ownHistoryReadable(10)'),cacheLength:f.run('messageSearchHits.length'),text:f.w.document.getElementById('messageSearchList').textContent});
  assert.equal(f.w.document.getElementById('messageSearchList').textContent.includes(post.content),false,'session epoch invalidation must redact existing display until revalidation');
 }finally{await f.close();}
});

test('SAFE v1 actual cache/context and quote read refuse stale local source',async()=>{
 const f=await fixture();try{
  f.rpc(async(name,body)=>name==='chat_own_history_states_v1'?{data:state(body.p_group_ids,'1',true)}:undefined);
  f.query(async(table)=>table==='chat_messages'?{data:[]}:undefined);
  f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;myGroups[0].own_history_revision='1';myGroups[0].own_history_suppressed=true;roomViewCache.set(10,{messages:[{id:101,content:'削除前の引用秘密本文'}]})");
  assert.equal(f.run('applyRoomViewCache(10)'),false);
  await f.run('loadQuotedMessages([{reply_to_id:101}])');assert.equal(f.run('quotedMessages.size'),0);
  f.run('currentGroupId=null;currentRoomMembership=null');
  await f.run("openMessageAt(10,'2026-01-01T00:00:00Z',101)");assert.equal(f.run('currentGroupId'),null);
  assert.equal(f.calls.some(c=>c.table==='chat_read_states'),false);
 }finally{await f.close();}
});

test('SAFE refusing sibling row action cannot release owner-held saving guard',async()=>{
 const f=await fixture();try{
  const held=deferred();f.rpc(async(name)=>name==='chat_set_pin'?held.promise:undefined);
  const first=f.run("ownHistoryRowAction(10,ownHistoryRowLease(10),'pin')");await tick();
  assert.equal(await f.run("ownHistoryRowAction(10,ownHistoryRowLease(10),'mute')"),false);
  assert.equal(f.run('ownHistoryScope(10).saving'),true);
  held.resolve({data:null});await first;assert.equal(f.run('ownHistoryScope(10).saving'),false);
  assert.equal(f.calls.length,1);
 }finally{await f.close();}
});

test('SAFE allowed groups remain entitled on suppression and no forbidden preservation-table writes occur',async()=>{
 const f=await fixture();try{
  f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentPrivateNotes=[{id:77,content:'維持'}];pendingSendFiles=[{id:'P'}];$('messageInput').value='下書き';");
  const refs=f.run('[myGroups[0].membership,currentPrivateNotes,pendingSendFiles]');
  f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}]);renderGroups()");
  assert.equal(f.run('myGroups.length'),1);assert.equal(f.run('ownHistoryAuthorized(10)'),true);
  assert.equal(f.w.document.querySelectorAll('#myGroupsList .swipe-row').length,0);
  for(let i=0;i<3;i++)assert.equal(f.run('[myGroups[0].membership,currentPrivateNotes,pendingSendFiles]')[i],refs[i]);
  assert.equal(f.w.document.getElementById('messageInput').value,'下書き');assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
