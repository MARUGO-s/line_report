import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,tick,deferred,standardRpc} from './fixture.mjs';
const scenarios=[...['sign','fetch','blob','upload','insert'].map(stage=>[stage,'clear']),...['membership','room-ABA','token','exact-object','exact-body','owner'].map(boundary=>['sign',boundary])];
for(const [stage,boundary] of scenarios)test('S05 actual forward continuation boundary '+stage+' / '+boundary,async()=>{
 const f=await fixture();try{
 const held=deferred(),effects=[];let payload;
 f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentChatAccess.can_browse_users=true;currentChatAccess.can_start_direct=true;registeredUsers=[{id:'recipient',username:'合成相手'}];currentMessages=[{id:101,group_id:10,kind:'image',content:'[画像]',payload:{v:1,kind:'image',image:{path:'groups/10/source.jpg',w:1,h:1}}}];dispatchPushForMessage=()=>{}");
 f.w.__storage={from(bucket){assert.equal(bucket,'chat-images');return {createSignedUrl:async(path)=>{effects.push('sign');assert.equal(path,'groups/10/source.jpg');return stage==='sign'?held.promise:{data:{signedUrl:'https://synthetic.invalid/image'}};},upload:async(path,blob,opts)=>{effects.push('upload');assert.match(path,/^groups\/11\//);return stage==='upload'?held.promise:{error:null};}};}};f.run('sb.storage=__storage');
 f.w.fetch=async url=>{assert.equal(url,'https://synthetic.invalid/image');effects.push('fetch');return stage==='fetch'?held.promise:{ok:true,blob:async()=>{effects.push('blob');return stage==='blob'?held.promise:{type:'image/jpeg'};}};};
 f.rpc(async(n,p)=>n==='chat_open_direct'?{data:11}:standardRpc(n,p));
 f.query(async(t,ops)=>{if(t==='chat_group_members'&&ops.some(o=>o[0]==='eq'&&o[1]==='user_id'))return {data:[10,11].map(id=>({can_view:true,can_send:true,own_history_revision:'0',own_history_suppressed:false,chat_groups:{id,group_name:'合成'+id,created_at:'2026-01-01T00:00:00Z'}}))};if(t==='chat_messages'&&ops.some(o=>o[0]==='insert')){effects.push('insert');payload=JSON.stringify(ops.find(o=>o[0]==='insert')[1]);return stage==='insert'?held.promise:{data:{id:901}};}if(['chat_groups','chat_group_members','chat_messages'].includes(t))return {data:[]};});
 await f.run('openForward(currentMessages[0])');const forwarding=f.run("forwardToUser({id:'recipient',username:'相手'})");for(let i=0;i<8;i++)await tick();assert.equal(effects.at(-1),stage);
 if(boundary==='clear')f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");
 if(boundary==='membership')f.run('handleMemberRemoved({group_id:10,user_id:currentUser.id})');
 if(boundary==='room-ABA')f.run('currentGroupId=11;++selectGroupSeq;currentGroupId=10;++selectGroupSeq');
 if(boundary==='token')f.listeners.forEach(fn=>fn('TOKEN_REFRESHED',{user:{id:OWNER},access_token:'synthetic-refresh'}));
 if(boundary==='exact-object')f.run('currentMessages=[{...currentMessages[0]}]');
 if(boundary==='exact-body')f.run("currentMessages[0].payload.image.path='groups/10/replaced.jpg'");
 if(boundary==='owner')f.run("currentUser={id:'22222222-2222-4222-8222-222222222222'}");
 const before=[...effects],frozen=payload;
 held.resolve(stage==='sign'?{data:{signedUrl:'https://synthetic.invalid/image'}}:stage==='fetch'?{ok:true,blob:async()=>{effects.push('blob');return {type:'image/jpeg'};}}:stage==='blob'?{type:'image/jpeg'}:stage==='upload'?{error:null}:{data:{id:901}});
 await forwarding;assert.deepEqual(effects,before,'no new stage after invalidation; already dispatched upload/INSERT is not undone');assert.equal(payload,frozen);
 assert.equal(effects.filter(x=>x==='upload').length,stage==='upload'||stage==='insert'?1:0);assert.equal(effects.filter(x=>x==='insert').length,stage==='insert'?1:0);
 console.log('FORWARD_STAGE '+JSON.stringify({stage,boundary,effects,payload}));
 }finally{await f.close();}
});
