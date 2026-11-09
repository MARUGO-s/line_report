import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,CAP,state,tick,deferred,groupsQuery,standardRpc} from './fixture.mjs';
import {fixture as earlyFixture} from './early-fixture.mjs';
const post={id:101,group_id:10,user_id:OWNER,username:'独立',kind:'text',content:'独立旧本文',created_at:'2026-01-01T00:00:00Z'};
const selected=f=>{f.w.__post=post;f.run('currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentMessages=[__post]');};
for(const kind of ['membership','ACL','token'])test('INDEPENDENT old lease permanently denied and fresh actual read recovers after observed '+kind+' ABA',async()=>{
 const f=await fixture();try{f.rpc(standardRpc);selected(f);const old=f.run('ownHistoryLease([10])');
 if(kind==='membership'){f.query(groupsQuery(false));await f.run('loadGroups()');f.query(groupsQuery(true));await f.run('loadGroups()');}
 if(kind==='ACL'){let allow=false;f.query(async t=>t==='chat_user_access'?{data:{access_enabled:allow,signup_status:'approved'}}:undefined);await f.run('loadCurrentChatAccess()');allow=true;await f.run('loadCurrentChatAccess()');}
 if(kind==='token'){const token=f.session.access_token;for(const v of ['independent-rotated',token]){f.session.access_token=v;f.listeners.forEach(fn=>fn('TOKEN_REFRESHED',f.session));}}
 assert.equal(old.valid(),false);f.query(async t=>t==='chat_messages'?{data:[post]}:undefined);
 f.run("$('talkSearch').value='独立'");await f.run("runMessageSearch('独立')");assert.ok(f.w.document.getElementById('messageSearchList').textContent.includes(post.content));assert.equal(old.valid(),false);
 }finally{await f.close();}
});
for(const result of ['error','throw'])test('INDEPENDENT obsolete state '+result+' and finally cannot poison newer successful reader or unknown journal',async()=>{
 const f=await fixture();try{f.rpc(async(n)=>n==='chat_own_history_capabilities_v1'?{data:CAP}:n==='chat_clear_own_history_v1'?{error:Error('unknown')}:undefined);await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));const intent=f.run('ownHistoryScope(10).intent');
 let reject;const held=new Promise((r,j)=>{f.w.__resolve=r;reject=j});let count=0;f.rpc(async(n,p)=>n==='chat_own_history_states_v1'?(++count===1?held:{data:state(p.p_group_ids)}):undefined);
 const first=f.run('ownHistoryStates([10])');const caught=first.catch(e=>e);await tick();await f.run('ownHistoryStates([10])');const generation=f.run('ownHistoryGeneration');
 if(result==='error')f.w.__resolve({error:Error('obsolete')});else reject(Error('obsolete'));await caught;
 assert.equal(f.run('ownHistoryGeneration'),generation);assert.equal(f.run('ownHistoryScope(10).intent'),intent);assert.equal(f.run('myGroups[0].own_history_unverified'),false);assert.equal(await f.run("ownHistoryCommand(10,'clear')"),false);
 }finally{await f.close();}
});
for(const change of ['same-room-new-object','room-ABA','close-reopen','mask'])test('INDEPENDENT stale real menu copy/reply callbacks refuse '+change,async()=>{
 const f=await fixture();try{selected(f);const copied=[];Object.defineProperty(f.w.navigator,'clipboard',{value:{writeText:async t=>copied.push(t)}});
 f.run("openMessageMenu(101,$('messages'))");const copy=f.w.document.querySelector('.msg-menu [data-action="copy"]'),reply=f.w.document.querySelector('.msg-menu [data-action="reply"]');assert.ok(copy&&reply);
 if(change==='same-room-new-object')f.run('currentMessages=[{...currentMessages[0]}]');
 if(change==='room-ABA')f.run('currentGroupId=11;++selectGroupSeq;currentGroupId=10;++selectGroupSeq');
 if(change==='close-reopen')f.run("closeMessageMenu();openMessageMenu(101,$('messages'))");
 if(change==='mask')f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");
 copy.click();reply.click();await tick();assert.deepEqual(copied,[]);assert.equal(f.run('replyTarget'),null);
 if(change==='close-reopen'){f.w.document.querySelector('.msg-menu [data-action="copy"]').click();await tick();assert.deepEqual(copied,[post.content]);}
 }finally{await f.close();}
});
for(const malformed of ['missing','invalid','partial'])test('INDEPENDENT known v1 '+malformed+' cannot fall back to old message body/cache',async()=>{
 const f=await fixture();try{selected(f);f.run('ownHistoryV1(myGroups[0])');f.run("delete myGroups[0].own_history_revision;delete myGroups[0].own_history_suppressed");
 if(malformed==='invalid')f.run("myGroups[0].own_history_revision=0;myGroups[0].own_history_suppressed=false");if(malformed==='partial')f.run("myGroups[0].own_history_revision='0'");
 let readerCalled=0;f.w.__reader=async()=>{++readerCalled;return {data:[post]}};await assert.rejects(f.run('ownHistoryRead([10],__reader)'));await assert.rejects(f.run('ownHistoryAcceptMessage(__post)'));assert.equal(readerCalled,0);assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
for(const data of [null,{contract_version:2,own_clear_supported:true,mark_read_supported:true,snapshot_semantics:'statement_visible_ids'}])test('INDEPENDENT unsupported capability denies mutation without consuming new draft '+JSON.stringify(data),async()=>{
 const f=await fixture();try{selected(f);f.run("$('messageInput').value='新draft';isPrivateNoteMode=true;replyTarget=__post");const reply=f.run('replyTarget');f.rpc(async n=>n==='chat_own_history_capabilities_v1'?{data}:undefined);
 await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));assert.equal(f.calls.filter(c=>c.rpc).length,1);assert.equal(f.w.document.getElementById('messageInput').value,'新draft');assert.equal(f.run('isPrivateNoteMode'),true);assert.equal(f.run('replyTarget'),reply);assert.equal(f.run('ownHistoryScope(10).intent'),null);
 }finally{await f.close();}
});
test('INDEPENDENT masked chat forward needs exact fresh RLS row; retained album snapshot remains distinct',async()=>{
 const f=await fixture();try{selected(f);f.run("currentChatAccess.can_browse_users=true;currentChatAccess.can_start_direct=true;registeredUsers=[{id:'destination'}];ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");
 const path='groups/10/retained.jpg';f.rpc(async(n,p)=>n==='chat_own_history_states_v1'?{data:state(p.p_group_ids,'1',true)}:undefined);
 f.query(async(t,ops)=>t==='chat_messages'?{data:[]}:t==='chat_album_items'?{data:{id:77,group_id:10,storage_path:path,caption:'保持画像',created_at:post.created_at}}:undefined);
 await f.run('openForward(__post)');assert.equal(f.run('forwardMessage'),null);assert.equal(f.w.document.getElementById('forwardOverlay').classList.contains('hidden'),true);
 const q=f.calls.find(c=>c.table==='chat_messages');assert.ok(q.ops.some(x=>x[0]==='eq'&&x[1]==='group_id'&&x[2]===10));assert.ok(q.ops.some(x=>x[0]==='eq'&&x[1]==='id'&&x[2]===101));
 f.w.__path=path;const retained=await f.run('resolveAlbumMessage(0,__path)');assert.equal(retained.id,null);f.w.__retained=retained;await f.run('openForward(__retained)');assert.equal(f.run('forwardMessage'),retained);assert.equal(f.w.document.getElementById('forwardOverlay').classList.contains('hidden'),false);assert.equal(f.calls.some(c=>c.ops?.some(x=>['insert','delete','update','upsert'].includes(x[0]))),false);
 }finally{await f.close();}
});
for(const initial of ['empty','blocked'])test('INDEPENDENT actual afterSignIn root reauthorizes '+initial+' ACL through getter current identity',async()=>{
 const f=await fixture();try{f.run("currentChatAccess="+(initial==='empty'?'null':'{access_enabled:false}')+";sb.auth.getUser=async()=>({data:{user:currentUser},error:null});window.__starts=0;startSession=()=>++window.__starts;");
 f.query(async(t,ops)=>t==='chat_users'?{data:{id:OWNER,username:'独立root'}}:t==='chat_user_access'?{data:{access_enabled:true,signup_status:'approved'}}:undefined);
 await f.run('afterSignIn()');assert.equal(f.w.__starts,1);assert.equal(f.run('chatAccessIsBlocked(currentChatAccess)'),false);assert.equal(f.calls.filter(c=>c.table==='chat_user_access').length,1);
 }finally{await f.close();}
});
test('INDEPENDENT synchronous INITIAL_SESSION runs in actual HTML classic script order before later helpers',async()=>{const f=await earlyFixture();try{assert.ok(f.run('ownHistoryAuthEpoch')>=2);assert.ok(f.scripts.indexOf('chat/own-history.js')<f.scripts.indexOf('chat/messages.js'));assert.equal(f.diagnostics.length,0);assert.equal(f.scripts.length,12);}finally{await f.close();}});
