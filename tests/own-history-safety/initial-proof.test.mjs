import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture,OWNER,CAP,state,deferred,tick,groupsQuery,standardRpc} from './fixture.mjs';
const stale=JSON.parse(readFileSync(new URL('../fixtures/own-history-stale-wire.json',import.meta.url))).responses[0].json;
const pause=async()=>{for(let i=0;i<6;i++)await tick();};
const archives=f=>Array.from({length:f.w.localStorage.length},(_,i)=>f.w.localStorage.key(i)).filter(k=>k.startsWith('mtalk-own-history-rejected-v1:'));
for(const kind of ['clear','read'])for(const boundary of ['actual-poll','member-denied','different-owner','owner-ABA','logout-login','same-object-owner-ABA','journal-body-mismatch','journal-missing','archive-write-failure'])test('UI-R1 initial exact proof ownership '+kind+' '+boundary,async()=>{
 const f=await fixture();try{
 const held=deferred();let writes=0;
 f.rpc(async(n,p)=>{if(n==='chat_own_history_capabilities_v1')return {data:CAP};if(n==='chat_own_history_states_v1')return {data:state(p.p_group_ids,'1')};if(n==='chat_unread_counts')return {data:[]};if(n===(kind==='clear'?'chat_clear_own_history_v1':'chat_mark_room_read_v1')){++writes;return held.promise;}});
 f.query(async(t,ops)=>{if(t==='chat_group_members'&&ops.some(o=>o[0]==='eq'&&o[1]==='user_id'))return {data:[{can_view:true,can_send:true,own_history_revision:'1',own_history_suppressed:false,chat_groups:{id:10,group_name:'合成ルームA',created_at:'2026-01-01T00:00:00Z'}}]};if(['chat_groups','chat_group_members','chat_messages'].includes(t))return {data:[]};});
 f.run('renderGroups()');f.w.document.querySelector('.swipe-'+kind).click();await pause();assert.equal(writes,1);
 const original=f.run('ownHistoryScope(10).intent'),body=JSON.stringify(original),scope=f.run('ownHistoryScope(10)');
 const journal=scope.key+':'+original.request_id;
 if(boundary==='actual-poll'){await f.run('ownHistoryPoll()');assert.equal(f.run('myGroups[0].own_history_revision'),'1');}
 if(boundary==='member-denied')f.run('handleMemberRemoved({group_id:10,user_id:currentUser.id})');
 if(boundary==='different-owner'||boundary==='owner-ABA'){
 f.run("currentUser={id:'22222222-2222-4222-8222-222222222222'}");f.listeners.forEach(fn=>fn('SIGNED_IN',{user:{id:'22222222-2222-4222-8222-222222222222'},access_token:'synthetic-other'}));
 if(boundary==='owner-ABA'){f.run(`currentUser={id:'${OWNER}'}`);f.listeners.forEach(fn=>fn('SIGNED_IN',f.session));}}
 if(boundary==='logout-login'){f.listeners.forEach(fn=>fn('SIGNED_OUT',null));f.listeners.forEach(fn=>fn('SIGNED_IN',f.session));}
 if(boundary==='same-object-owner-ABA'){for(const id of ['22222222-2222-4222-8222-222222222222',OWNER]){f.session.user.id=id;f.listeners.forEach(fn=>fn('TOKEN_REFRESHED',f.session));}}
 if(boundary==='journal-body-mismatch')f.w.localStorage.setItem(journal,JSON.stringify({...original,expected_revision:'99'}));
 if(boundary==='journal-missing')f.w.localStorage.removeItem(journal);
 let originalSet;if(boundary==='archive-write-failure'){originalSet=f.w.Storage.prototype.setItem;f.w.Storage.prototype.setItem=function(k,v){if(k.startsWith('mtalk-own-history-rejected-v1:'))throw Error('synthetic storage failure');return originalSet.call(this,k,v);};}
 held.resolve({data:null,error:structuredClone(stale)});await pause();if(originalSet)f.w.Storage.prototype.setItem=originalSet;
 assert.equal(writes,1);assert.equal(JSON.stringify(scope.intent),body);assert.equal(scope.saving,false);
 const saveExpected=['actual-poll','member-denied'].includes(boundary);assert.equal(archives(f).length,saveExpected?1:0);
 if(saveExpected){const record=JSON.parse(f.w.localStorage.getItem(archives(f)[0]));assert.equal(JSON.stringify(record.intent),body);assert.equal(record.acknowledged,false);}
 if(boundary==='different-owner'){f.run('renderGroups()');assert.equal(f.w.document.querySelector('.own-history-recovery'),null);}
 if(boundary==='member-denied'){assert.equal(f.w.document.querySelector('.own-history-recovery'),null);}
 }finally{await f.close();}
});
for(const failure of ['ack-write','journal-delete','index-delete'])test('UI-R1 explicit rejection acknowledgement fails closed on '+failure,async()=>{
 const f=await fixture();try{
 f.rpc(async(n,p)=>n==='chat_own_history_capabilities_v1'?{data:CAP}:n==='chat_clear_own_history_v1'?{data:null,error:structuredClone(stale)}:undefined);
 await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));const intent=f.run('ownHistoryScope(10).intent');
 const p=f.w.Storage.prototype,set=p.setItem,remove=p.removeItem;
 if(failure==='ack-write')p.setItem=function(k,v){if(k.startsWith('mtalk-own-history-rejected-v1:'))throw Error('ack storage failure');return set.call(this,k,v);};
 else p.removeItem=function(k){if((failure==='journal-delete'&&k.endsWith(':'+intent.request_id))||(failure==='index-delete'&&k===f.run('ownHistoryScope(10).key')))throw Error('delete storage failure');return remove.call(this,k);};
 await assert.rejects(f.run('ownHistoryAcknowledgeRejection(10,ownHistoryScope(10).intent)'));
 p.setItem=set;p.removeItem=remove;assert.equal(f.run('ownHistoryScope(10).intent'),intent);assert.equal(await f.run("ownHistoryCommand(10,'clear')"),false);
 }finally{await f.close();}
});
