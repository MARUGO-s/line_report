import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,tick,deferred,standardRpc} from './fixture.mjs';
for(const invalidate of ['valid-chat','retained-album-after-clear'])test('CONTROL actual forward image transfer succeeds only on valid fresh source '+invalidate,async()=>{
 const f=await fixture();try{
 const held=deferred(),storage=[],fetches=[];const path='groups/10/independent.jpg',url='https://independent.synthetic.invalid/in-memory-image';
 f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentChatAccess.can_browse_users=true;currentChatAccess.can_start_direct=true;registeredUsers=[{id:'recipient',username:'合成相手'}];currentMessages=[{id:101,group_id:10,kind:'image',content:'[画像]',payload:{v:1,kind:'image',image:{path:'groups/10/independent.jpg'}}}];dispatchPushForMessage=()=>{}");
 f.w.__storage={from(bucket){if(bucket!=='chat-images'){f.denied.push({kind:'storage-bucket',bucket});throw Error('unexpected bucket');}return {createSignedUrl:async(p,ttl)=>{assert.equal(p,path);storage.push(['sign',p]);return held.promise;},upload:async(p,blob,options)=>{storage.push(['upload',p]);return {error:null};}};}};
 f.run('sb.storage=__storage');f.w.fetch=async u=>{if(u!==url){f.denied.push({kind:'fetch-unexpected',url:u});throw Error('unexpected synthetic URL');}fetches.push(u);return {ok:true,blob:async()=>({type:'image/jpeg'})};};
 f.rpc(async(n,p)=>n==='chat_open_direct'?{data:11}:n==='chat_own_history_states_v1'&&invalidate==='retained-album-after-clear'?{data:p.p_group_ids.map(id=>({contract_version:1,user_id:OWNER,group_id:String(id),revision:String(id)==='10'?'1':'0',timeline_suppressed:String(id)==='10'}))}:standardRpc(n,p));
 f.query(async(t,ops)=>{
  if(t==='chat_group_members'&&ops.some(o=>o[0]==='eq'&&o[1]==='user_id'))return {data:[10,11].map(id=>({can_view:true,can_send:true,own_history_revision:invalidate==='retained-album-after-clear'&&id===10?'1':'0',own_history_suppressed:invalidate==='retained-album-after-clear'&&id===10,chat_groups:{id,group_name:'合成'+id,created_at:'2026-01-01T00:00:00Z'}}))};
  if(t==='chat_album_items')return {data:{id:707,group_id:10,storage_path:path,caption:'保持画像',created_at:'2026-01-01T00:00:00Z'}};
  if(t==='chat_messages'&&ops.some(o=>o[0]==='insert'))return {data:{id:901}};
  if(['chat_groups','chat_group_members','chat_messages'].includes(t))return {data:[]};return undefined;
 });
 f.run('window.__source=currentMessages[0]');if(invalidate==='retained-album-after-clear'){f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");f.w.__source=await f.run("resolveAlbumMessage(0,'groups/10/independent.jpg')");assert.equal(f.w.__source.id,null);}
 await f.run('openForward(__source)');const forwarding=f.run("forwardToUser({id:'recipient',username:'合成相手'})");for(let i=0;i<8;i++)await tick();assert.equal(storage.length,1,'actual forward must reach the held signing boundary');
 const beforeInsert=f.calls.filter(c=>c.ops?.some(o=>o[0]==='insert')).length;assert.equal(beforeInsert,0);
 held.resolve({data:{signedUrl:url}});await forwarding;
 const inserts=f.calls.filter(c=>c.ops?.some(o=>o[0]==='insert')).map(c=>c.ops.find(o=>o[0]==='insert')[1]);console.log('FORWARD_AFTER_INVALIDATION '+JSON.stringify({invalidate,readable:f.run('ownHistoryReadable(10)'),storage,fetches,inserts}));
 assert.equal(inserts.length,1);assert.equal(inserts[0].group_id,11);assert.equal(storage.filter(x=>x[0]==='upload').length,1);
 }finally{await f.close();}
});
