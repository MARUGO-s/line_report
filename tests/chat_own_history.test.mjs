import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

test('actual shipped old cache serves candidate room source on ordinary navigation/reload; new worker never reloads/sends',async()=>{
 const base=new URL('./fixtures/own-history-baseline/',import.meta.url);
 const old=readFileSync(new URL('chat-sw.js',base),'utf8');
 const oldRooms=readFileSync(new URL('chat-rooms.js',base),'utf8');
 assert.equal(createHash('sha256').update(old).digest('hex'),'29bbe4d1a39b14cb2fde1037c10c2d403dccf992fd14f0abdb8a47450698607f');
 assert.equal(createHash('sha256').update(oldRooms).digest('hex'),'4b1368458c814b32d0656c4fb94eee6b8d9f51de36b677bcd890d78253b44c96');
 const html=readFileSync(new URL('../public/chat.html',import.meta.url),'utf8');
 const rooms=readFileSync(new URL('../public/chat/rooms.js',import.meta.url),'utf8');
 const key=html.match(/src="(chat\/rooms.js[^\"]*)"/)[1];
 const origin='https://synthetic.invalid/';
 const effects=[], handlers={},store=new Map([[origin+'chat/rooms.js?v=20261007-loan-report-1',oldRooms]]);
 const cache={match:async req=>store.get(typeof req==='string'?req:req.url),put:async()=>{},addAll:async()=>{},add:async()=>{}};
 const self={location:{href:origin+'chat-sw.js',origin:origin.slice(0,-1)},addEventListener:(type,fn)=>handlers[type]=fn,skipWaiting:async()=>effects.push('skipWaiting'),clients:new Proxy({},{get:(_,key)=>()=>{effects.push(key);return [];}})};
 const ctx={self,URL,Request,Response,console,caches:{open:async()=>cache,keys:async()=>[],delete:async()=>{}},fetch:async()=>rooms};
 vm.runInNewContext(old,ctx);
 let result;
 handlers.fetch({request:{url:origin+key,method:'GET',mode:'cors'},respondWith:p=>result=p});
 const delivered=result ? await result : await ctx.fetch();
 assert.equal(createHash('sha256').update(delivered).digest('hex'),createHash('sha256').update(rooms).digest('hex'),'normal reload must not take stale v73 room code');
 const candidate=readFileSync(new URL('../public/chat-sw.js',import.meta.url),'utf8');
 vm.runInNewContext(candidate,{...ctx,self:{...self,addEventListener:(type,fn)=>handlers[type]=fn}});
 const waits=[];handlers.install({waitUntil:p=>waits.push(p)});await Promise.all(waits);
 handlers.activate({waitUntil:p=>waits.push(p)});await Promise.all(waits);
 assert.deepEqual(effects,['skipWaiting']);
 assert.ok(candidate.includes("'./"+key+"'"),'worker shell key matches HTML');
});
import { fixture, capabilities, states, applied, OWNER } from './helpers/chat-own-history-fixture.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('ordinary unchanged poll preserves loaded history identity and scroll while still reading authoritative states',async()=>{
 const f=await fixture();try {
  f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentMessages=[{id:1,group_id:10,content:'表示中の過去履歴',created_at:'2026-01-01T00:00:00Z'}];$('messages').scrollTop=81");
  const history=f.run('currentMessages');
  f.query(async(table,ops)=>{
   if(table==='chat_group_members'&&ops.some(o=>o[0]==='eq'&&o[1]==='user_id'))return {data:[{can_view:true,own_history_revision:'0',own_history_suppressed:false,chat_groups:{id:10,group_name:'サンプル店舗A'}}]};
   return {data:[]};
  });
  f.rpc(async(name,body)=>name==='chat_unread_counts'?{data:[]}:{data:states(body.p_group_ids)});
  await f.run('ownHistoryPoll()');await tick();
  assert.equal(f.run('currentMessages'),history);assert.equal(f.w.document.getElementById('messages').scrollTop,81);
  assert.ok(f.calls.some(c=>c.name==='chat_own_history_states_v1'));
 }finally{await f.close();}
});

test('unsafe legacy numeric room identity is refused before capability or preference I/O, never rounded to another room',async()=>{
 const f=await fixture();try {
  f.run("myGroups[0].id=Number('9007199254740993')");
  f.rpc(async()=>({data:capabilities}));
  await assert.rejects(f.run("ownHistoryCommand(myGroups[0].id,'clear')"));
  await f.run("ownHistoryRowAction(myGroups[0].id,ownHistoryRowLease(myGroups[0].id),'pin')");
  assert.equal(f.calls.length,0);
 }finally{await f.close();}
});

test('a refused sibling preference callback cannot release the saving scope of a held pin',async()=>{
 const f=await fixture();try {
  let release;const held=new Promise(resolve=>release=resolve);
  f.rpc(async name=>{assert.equal(name,'chat_set_pin');return held;});
  const pin=f.run("ownHistoryRowAction(10,ownHistoryRowLease(10),'pin')");await tick();
  assert.equal(await f.run("ownHistoryRowAction(10,ownHistoryRowLease(10),'mute')"),false);
  assert.equal(f.run('ownHistoryScope(10).saving'),true);
  release({data:null});await pin;
  assert.equal(f.run('ownHistoryScope(10).saving'),false);
 }finally{await f.close();}
});

test('unavailable durable storage is a visible refusal, not an unhandled row action or network write',async()=>{
 const f=await fixture();try {
  f.w.Storage.prototype.getItem=()=>{throw Error('保存領域を利用できません');};
  await assert.doesNotReject(f.run("ownHistoryRowAction(10,ownHistoryRowLease(10),'clear')"));
  assert.equal(f.calls.length,0);assert.match(f.alerts.join(''),/保存領域/);
 }finally{await f.close();}
});

for (const [action,field,rpc,parameter] of [['pin','pinned_at','chat_set_pin','p_pinned'],['mute','muted_at','chat_set_mute','p_muted'],['hide','hidden_at','chat_set_hidden','p_hidden']]) {
 test('actual '+action+' button persists its own preference, no history/exit/purge call',async()=>{
  const f=await fixture();try {
   f.rpc(async(name,body)=>{assert.equal(name,rpc);assert.equal(body.p_group_id,10);assert.equal(body[parameter],true);return {data:null};});
   f.run('renderGroups()');f.w.document.querySelector('.swipe-'+action).click();await tick();
   assert.equal(f.calls.length,1);assert.ok(f.run('myGroups[0].'+field));
   assert.equal(f.run('myGroups[0].own_history_revision'),'0');
   assert.equal(f.run('myGroups.length'),1);
  }finally{await f.close();}
 });
}

test('cancelled actual clear confirmation makes no request and preserves pending editor state',async()=>{
 const f=await fixture();try {
  f.w.confirm=()=>false;
  f.run("$('messageInput').value='編集中';pendingSendFiles=[{id:'same-pending'}];renderGroups()");
  const pending=f.run('pendingSendFiles');
  f.w.document.querySelector('.swipe-clear').click();await tick();
  assert.equal(f.calls.length,0);assert.equal(f.w.localStorage.length,0);
  assert.equal(f.run('pendingSendFiles'),pending);assert.equal(f.w.document.getElementById('messageInput').value,'編集中');
 }finally{await f.close();}
});

test('room replacement cannot receive a held old quote; trash controls remain a separate projection',async()=>{
 const f=await fixture();try {
  let release;const held=new Promise(resolve=>release=resolve);
  f.rpc(async(name,body)=>({data:states(body.p_group_ids)}));f.query(()=>held);
  f.run('currentGroupId=10;currentRoomMembership=myGroups[0].membership');
  const quote=f.run('loadQuotedMessages([{reply_to_id:1}])');await tick();
  f.run("myGroups.push({id:11,membership:{can_view:true},own_history_revision:'0',own_history_suppressed:false});currentGroupId=11;currentRoomMembership=myGroups[1].membership;++selectGroupSeq;quotedMessages=new Map()");
  release({data:[{id:1,content:'別ルームの引用本文'}]});await quote;
  assert.equal(f.run('quotedMessages.size'),0);
  f.run("myGroups[0].own_history_suppressed=true;myGroups[0].trashed_at='2026-01-01T00:00:00Z';talkTab='trash';renderGroups()");
  assert.equal(f.w.document.querySelectorAll('#myGroupsList .swipe-row').length,1);
 }finally{await f.close();}
});

test('legacy trash membership does not disable unrelated active-room previews or unread',async()=>{
 const f=await fixture();try {
  f.run("myGroups.push({id:11,trashed_at:'2026-01-01T00:00:00Z',membership:{can_view:true}})");
  f.rpc(async(name,body)=>name==='chat_unread_counts'?{data:[{group_id:10,unread_count:2}]}:{data:states(body.p_group_ids)});
  f.query(async()=>({data:[{id:2,group_id:10,content:'新着',created_at:'2026-01-02T00:00:00Z'}]}));
  await f.run('loadLastMessages()');await f.run('loadUnread()');
  assert.equal(f.run('lastMessages[10]?.content'),'新着');assert.equal(f.run('unread[10]'),2);
 }finally{await f.close();}
});

test('actual PG17.8 DTO artifact binds capabilities/readers/strict receipts without number or echo coercion',async()=>{
 const text=readFileSync(new URL('./fixtures/own-history-real-sql-dto.json',import.meta.url),'utf8');
 assert.equal(createHash('sha256').update(text).digest('hex'),'e93d116c681c94aebf025a4e2c9a8a6f179e1d6046f183330e50f8ecbe5dbb6a');
 const sql=JSON.parse(text),f=await fixture();try {
  f.w.__sql=sql;
  f.run('myGroups[0].id=1');
  f.rpc(async(name,body)=>{
   if(name==='chat_own_history_capabilities_v1')return {data:sql.capabilities};
   assert.equal(name,'chat_own_history_states_v1');assert.deepEqual([...body.p_group_ids],['1']);return {data:sql.states};
  });
  await f.run('ownHistoryCapability(ownHistoryLease([1]))');
  await f.run('ownHistoryStates([1])');
  assert.equal(f.run('myGroups[0].own_history_revision'),sql.computed_membership.revision);
  assert.equal(f.run('myGroups[0].own_history_suppressed'),sql.computed_membership.suppressed);
  for(const key of ['clear','read','read_empty','bigint_group']) {
   f.w.__receipt=sql[key];
   const parsed=f.run("ownHistoryReceipt(__receipt,{contract_version:1,user_id:__receipt.user_id,group_id:__receipt.group_id,request_id:__receipt.request_id,expected_revision:'0',kind:__receipt.kind})");
   assert.equal(parsed.group_id,sql[key].group_id);assert.equal(typeof parsed.group_id,'string');assert.equal(typeof parsed.applied_revision,'string');
   f.w.__wrong={...sql[key],group_id:Number(sql[key].group_id)};
   assert.throws(()=>f.run("ownHistoryReceipt(__wrong,{user_id:__receipt.user_id,group_id:__receipt.group_id,request_id:__receipt.request_id,expected_revision:'0',kind:__receipt.kind})"));
  }
  assert.equal(f.run("ownHistoryReceipt(__sql.operation_inflight_not_found,{user_id:__sql.clear.user_id,group_id:'1',request_id:__sql.clear.request_id},true).status"),'not_found');
 }finally{await f.close();}
});

test('settlement cannot delete a sibling tab durable intent for the same owner and room',async()=>{
 const f=await fixture();try {
  const other={contract_version:1,user_id:OWNER,group_id:'10',kind:'clear',request_id:'33333333-3333-4333-8333-333333333333',expected_revision:'0'};
  const key='mtalk-own-history-v1:'+OWNER+':10';
  f.rpc(async(name,body)=>{
   if(name==='chat_own_history_capabilities_v1')return {data:capabilities};
   if(name==='chat_own_history_states_v1')return {data:states(body.p_group_ids,'1',true)};
   if(name==='chat_unread_counts')return {data:[]};
   assert.equal(name,'chat_clear_own_history_v1');
   f.w.localStorage.setItem(key,JSON.stringify(other));
   f.w.localStorage.setItem(key+':'+other.request_id,JSON.stringify(other));
   return {data:applied(body)};
  });
  await f.run("ownHistoryCommand(10,'clear')");
  assert.ok(f.w.localStorage.getItem(key),'sibling intent must remain persisted');
  assert.equal(JSON.parse(f.w.localStorage.getItem(key)).request_id,other.request_id);
  assert.equal(f.run('ownHistoryScope(10).intent.request_id'),other.request_id);
 }finally{await f.close();}
});

for (const send of ["sendChatText('返却待ち')", "sendSticker('synthetic-sticker')", "sendChatImage({name:'sample.png',type:'image/png'})", "sendChatFile({name:'sample.txt',type:'text/plain'})", "sendCardCommand('サンプル操作')"]) {
 test('actual sender never reinserts remote-cleared held receipt without local invalidation: '+send,async()=>{
  const f=await fixture();try {
   let release;const held=new Promise(resolve=>release=resolve);
   f.query(async(table,ops)=>{assert.equal(table,'chat_messages');return ops.some(o=>o[0]==='insert')?held:{data:[]};});
   f.rpc(async(name,body)=>{assert.equal(name,'chat_own_history_states_v1');return {data:states(body.p_group_ids,'1',true)};});
   f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;uploadChatImage=async()=>({path:'synthetic/image.png',width:1,height:1});uploadChatFile=async()=>({path:'synthetic/file.txt',name:'sample.txt'});archiveChatImageInMediaLibrary=async()=>{};dispatchPushForMessage=async()=>{};");
   const pending=f.run(send);await tick();
   release({data:{id:1,group_id:10,user_id:OWNER,content:'削除済み返却本文',created_at:'2026-01-01T00:00:00Z'}});
   await pending;
   assert.equal(f.run('currentMessages.length'),0);
   assert.equal(f.run('lastMessages[10]'),undefined);
   assert.equal(f.run('myGroups[0].own_history_revision'),'1');
  }finally{await f.close();}
 });
}

test('failed authoritative state is not revision zero readiness and cannot start a new mutation',async()=>{
 const f=await fixture();try {
  f.rpc(async(name)=>name==='chat_own_history_states_v1'?{data:[]}:{data:capabilities});
  await assert.rejects(f.run('ownHistoryStates([10])'));
  await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));
  assert.equal(f.calls.some(c=>c.name==='chat_clear_own_history_v1'),false);
 }finally{await f.close();}
});

test('durable unknown reconstructs exactly after scope recreation; newer failed status invalidates older proof',async()=>{
 const f=await fixture();try {
  let intent;
  f.rpc(async(name,body)=>{
   if(name==='chat_own_history_capabilities_v1')return {data:capabilities};
   assert.equal(name,'chat_clear_own_history_v1');intent=body;throw Error('response lost');
  });
  await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));
  f.run('ownHistoryScopes.clear()');
  assert.equal(f.run('ownHistoryScope(10).intent.request_id'),intent.p_request_id);
  let release;const held=new Promise(resolve=>release=resolve);let count=0;
  f.rpc(async(name)=>{assert.equal(name,'chat_own_history_operation_v1');return ++count===1?held:{error:Error('newer read failed')};});
  const old=f.run('ownHistoryOperationStatus(10)');await tick();
  await assert.rejects(f.run('ownHistoryOperationStatus(10)'));
  release({data:applied(intent)});assert.equal(await old,null);
  assert.equal(f.run('ownHistoryAcknowledge(10, ownHistoryScope(10).proof)'),false);
  assert.equal(f.run('ownHistoryScope(10).intent.request_id'),intent.p_request_id);
 }finally{await f.close();}
});

test('authoritative states are chunked at 100, validate full unique ownership, never infer from preview limit',async()=>{
 const f=await fixture();try {
  f.run("myGroups=Array.from({length:201},(_,i)=>({id:i+1,membership:{can_view:true},own_history_revision:'0',own_history_suppressed:false}))");
  const chunks=[];f.rpc(async(name,body)=>{assert.equal(name,'chat_own_history_states_v1');assert.ok(body.p_group_ids.length<=100);chunks.push(body.p_group_ids);return {data:states(body.p_group_ids)};});
  const result=await f.run('ownHistoryStates(myGroups.map(g=>g.id))');
  assert.equal(result.length,201);assert.deepEqual(chunks.map(c=>c.length),[100,100,1]);
 }finally{await f.close();}
});

test('v1 new incoming post preserves ordinary manual-hide revival without using hide as history state',async()=>{
 const f=await fixture();try {
  f.run("myGroups[0].hidden_at='2026-01-01T00:00:00Z'");
  const message={id:2,group_id:10,user_id:'22222222-2222-4222-8222-222222222222',content:'新着',created_at:'2026-01-02T00:00:00Z'};
  f.query(async()=>({data:[message]}));
  f.rpc(async(name,body)=>{
   if(name==='chat_own_history_states_v1')return {data:states(body.p_group_ids)};
   if(name==='chat_unread_counts')return {data:[]};
   assert.equal(name,'chat_set_hidden');assert.equal(body.p_hidden,false);return {data:null};
  });
  f.w.__post=message;await f.run('handleIncomingMessage(__post)');
  assert.equal(f.run('myGroups[0].hidden_at'),null);
  assert.equal(f.run('myGroups[0].own_history_revision'),'0');
 }finally{await f.close();}
});

test('membership clear invalidates a held older authoritative state read, never rolls revision back',async()=>{
 const f=await fixture();try {
  let release;const held=new Promise(resolve=>release=resolve);f.rpc(()=>held);
  const read=f.run('ownHistoryStates([10])');await tick();
  f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");
  release({data:states([10],'0',false)});
  await assert.rejects(read);
  assert.equal(f.run('myGroups[0].own_history_revision'),'1');
 }finally{await f.close();}
});

test('unknown clear recovery remains visible after authoritative suppression and stale capability cannot write after query change',async()=>{
 const f=await fixture();try {
  let release;const held=new Promise(resolve=>release=resolve);f.rpc(()=>held);
  f.run('renderGroups()');f.w.document.querySelector('.swipe-clear').click();await tick();
  f.run("$('talkSearch').value='別検索'; renderGroups()");
  release({data:capabilities});await tick();
  assert.equal(f.calls.some(c=>c.name==='chat_clear_own_history_v1'),false);
  f.rpc(async name=>name==='chat_own_history_capabilities_v1'?{data:capabilities}:{error:Error('unknown')});
  await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));
  f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}]);renderGroups()");
  assert.match(f.w.document.getElementById('myGroupsList').textContent,/操作結果が未確認/);
 }finally{await f.close();}
});

test('actual clear button shows durable unknown recovery and blocks all sibling actions',async()=>{
 const f=await fixture();try {
  f.rpc(async(name)=>name==='chat_own_history_capabilities_v1'?{data:capabilities}:{data:{contract_version:1,status:'applied'}});
  f.run('renderGroups()'); f.w.document.querySelector('.swipe-clear').click();await tick();
  assert.match(f.w.document.getElementById('myGroupsList').textContent,/操作結果が未確認/);
  assert.equal(f.w.localStorage.length,2,'room index and immutable request journal');
  const writes=f.calls.filter(c=>c.name==='chat_clear_own_history_v1').length;
  f.w.document.querySelector('.swipe-mute').click();await tick();
  assert.equal(f.calls.some(c=>c.name==='chat_set_mute'),false);
  assert.equal(f.calls.filter(c=>c.name==='chat_clear_own_history_v1').length,writes);
 }finally{await f.close();}
});

test('read receipt refreshes authoritative unread without counting newer snapshot messages locally',async()=>{
 const f=await fixture();try {
  f.run('unread={10:9}');
  f.rpc(async(name,body)=>{
   if(name==='chat_own_history_capabilities_v1')return {data:capabilities};
   if(name==='chat_own_history_states_v1')return {data:states(body.p_group_ids)};
   if(name==='chat_unread_counts')return {data:[{group_id:10,unread_count:1}]};
   assert.equal(name,'chat_mark_room_read_v1');
   return {data:applied(body,'read',{snapshot_latest:{id:'7',created_at:'2026-01-01T00:00:00Z'},effective_last_read_at:'2026-01-01T00:00:00Z'})};
  });
  await f.run("ownHistoryCommand(10,'read')");
  assert.equal(f.run('unread[10]'),1);
 }finally{await f.close();}
});

test('same object JWT replacement and repeated SIGNED_IN invalidate captured row callbacks',async()=>{
 for(const mutate of ['jwt','event']) {
  const f=await fixture();try {
   f.run('renderGroups()');const callback=f.w.document.querySelector('.swipe-pin').onclick;
   if(mutate==='jwt')f.session.access_token='different-synthetic-token';
   else f.listeners.forEach(fn=>fn('SIGNED_IN',f.session));
   callback({stopPropagation(){}});await tick();
   assert.equal(f.calls.length,0);
  }finally{await f.close();}
 }
});

test('reviewer revocation with unchanged can_view invalidates held history and already rendered cache',async()=>{
 const f=await fixture();try {
  f.run("currentChatAccess.can_review_access=true;currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentMessages=[{id:1,group_id:10,kind:'card',payload:{kind:'signup_approval'},content:'審査情報'}]");
  f.query(async(table)=>{assert.equal(table,'chat_user_access');return {data:{access_enabled:true,signup_status:'approved',can_review_access:false}};});
  await f.run('handleCurrentChatAccessChange()');
  assert.equal(f.run('currentMessages.length'),0);
  assert.equal(f.run('myGroups[0].membership.can_view'),true);
 }finally{await f.close();}
});

for (const reader of ["runMessageSearch('古い')",'loadUnread()']) {
 test('same-user session replacement rejects held '+reader,async()=>{
  const f=await fixture();try {
   let release;const held=new Promise(resolve=>release=resolve);
   f.query(()=>held);f.rpc(()=>held);
   const read=f.run(reader);await tick();
   f.run('ownHistorySetSession({...ownHistorySession})');
   release({data:reader==='loadUnread()'?[{group_id:10,unread_count:9}]:[{id:1,group_id:10,content:'古い本文',username:'検証',created_at:'2026-01-01T00:00:00Z'}]});
   await read;
   assert.equal(f.run('JSON.stringify([messageSearchHits,unread])').includes(reader==='loadUnread()'?'9':'古い本文'),false);
  }finally{await f.close();}
 });
}

test('row mark-read uses fixed server snapshot receipt, no navigation or local-clock upsert',async()=>{
 const f=await fixture();try {
  f.rpc(async(name,body)=>{
   if(name==='chat_unread_counts')return {data:[]};
   if(name==='chat_own_history_capabilities_v1')return {data:capabilities};
   if(name==='chat_own_history_states_v1')return {data:states(body.p_group_ids)};
   assert.equal(name,'chat_mark_room_read_v1');
   return {data:applied(body,'read',{snapshot_latest:{id:'7',created_at:'2026-01-01T00:00:00Z'},effective_last_read_at:'2026-01-01T00:00:00Z'})};
  });
  f.run('renderGroups()');f.w.document.querySelector('.swipe-read').click();await tick();
  assert.equal(f.calls.filter(c=>c.name==='chat_mark_room_read_v1').length,1);
  assert.equal(f.calls.some(c=>c.table),false);
  assert.equal(f.run('currentGroupId'),null);
 }finally{await f.close();}
});

for(const cap of [null,{...capabilities,contract_version:2},{...capabilities,own_clear_supported:'true'},{...capabilities,mark_read_supported:false}]) {
 test('unsupported or malformed capability makes zero new mutations '+JSON.stringify(cap),async()=>{
  const f=await fixture();try {
   f.rpc(async name=> {assert.equal(name,'chat_own_history_capabilities_v1');return {data:cap};});
   await assert.rejects(f.run("ownHistoryCommand(10,'clear')"));
   assert.equal(f.calls.filter(c=>c.name==='chat_clear_own_history_v1').length,0);
   assert.equal(f.w.localStorage.length,0);
  }finally{await f.close();}
 });
}

test('left swipe reveals all three controls, cancel closes, vertical movement never executes',async()=>{
 const f=await fixture();
 try {
  f.run('renderGroups()');
  const row=f.w.document.querySelector('.swipe-row'), front=row.querySelector('.swipe-front');
  const send=(type,x,y)=>{const event=new f.w.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerId:1,pointerType:'touch',clientX:x,clientY:y});front.dispatchEvent(event);};
  send('pointerdown',280,10);send('pointermove',20,10);send('pointerup',20,10);
  assert.equal(row._swipeX,-216);
  send('pointerdown',280,10);send('pointermove',250,10);send('pointercancel',250,10);
  assert.equal(row._swipeX,0);
  send('pointerdown',280,10);send('pointermove',275,150);send('pointerup',275,150);
  assert.equal(f.calls.length,0);
 } finally {await f.close();}
});

test('resume immediately redacts stale plaintext and revalidates without losing editor',async()=>{
 const f=await fixture();
 try {
  f.run("currentGroupId=10; currentMessages=[{id:1,content:'古い本文'}]; $('messageInput').value='編集中';");
  let release;const held=new Promise(resolve=>release=resolve);
  f.query(()=>held);
  const resume=f.run('ownHistoryResume()');
  assert.equal(f.run('currentMessages.length'),0);
  assert.equal(f.w.document.getElementById('messageInput').value,'編集中');
  release({error:Error('offline')});await resume;
  assert.equal(f.run('myGroups[0].own_history_unverified'),true);
 }finally{await f.close();}
});

test('ordinary membership poll redacts another-device clear while preserving note/input/authorized room',async()=>{
  const f=await fixture();
  try {
    f.run("currentGroupId=10;currentRoomMembership=myGroups[0].membership;currentMessages=[{id:1,group_id:10,content:'古い本文'}]; currentPrivateNotes=[{id:7,content:'個人メモ'}]; $('messageInput').value='編集中の下書き'");
    f.query(async(table,ops)=> {
      if(table==='chat_group_members' && ops.some(o=>o[0]==='eq'&&o[1]==='user_id')) return {data:[{can_view:true,own_history_revision:'1',own_history_suppressed:true,chat_groups:{id:10,group_name:'サンプル店舗A'}}]};
      return {data:[]};
    });
    f.rpc(async(name,body)=>name==='chat_unread_counts'?{data:[]}:{data:states(body.p_group_ids,'1',true)});
    await f.run('loadGroups()');await tick();
    assert.equal(f.run('currentMessages.length'),0);
    assert.equal(f.run('myGroups.length'),1);
    assert.equal(f.run('currentPrivateNotes[0].content'),'個人メモ');
    assert.equal(f.w.document.getElementById('messageInput').value,'編集中の下書き');
  } finally {await f.close();}
});

test('actual selectGroup discards held pre-clear latest response',async()=>{
  const f=await fixture();
  try {
    let release;
    const held=new Promise(resolve=>release=resolve);
    f.query(async(table,ops)=>{
      if(table==='chat_messages') return held;
      if(table==='chat_group_members') return {data:[{user_id:OWNER,can_view:true,can_send:true,chat_users:{id:OWNER}}]};
      return {data:[]};
    });
    f.rpc(async(name,body)=>name==='chat_unread_counts'?{data:[]}:{data:states(body.p_group_ids)});
    f.w.HTMLCanvasElement.prototype.getContext=()=>({measureText:()=>({width:8})});
    const select=f.run('selectGroup(myGroups[0])');await tick();
    f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");
    release({data:[{id:1,group_id:10,content:'古い本文',created_at:'2026-01-01T00:00:00Z'}]});
    await select;
    assert.equal(f.run('currentMessages.length'),0);
    assert.equal(f.calls.some(c=>c.name==='chat_own_history_states_v1'),true,'actual latest uses authoritative read');
  } finally {await f.close();}
});

test('actual realtime UPDATE/INSERT cannot inject an excluded body without fresh RLS read', async()=>{
  const f=await fixture();
  try {
    f.run("currentGroupId=10; currentRoomMembership=myGroups[0].membership; myGroups[0].own_history_revision='1'; myGroups[0].own_history_suppressed=true");
    f.rpc(async(name,body)=>name==='chat_unread_counts'?{data:[]}:{data:states(body.p_group_ids,'1',true)});
    f.query(async(table)=>{assert.equal(table,'chat_messages');return {data:[]};});
    await f.run("handleIncomingMessage({id:1,group_id:10,content:'除外済み',user_id:currentUser.id})");
    await tick();
    assert.equal(f.run('lastMessages[10]'),undefined);
    assert.equal(f.run('currentMessages.length'),0);
    f.run("quotedMessages.set(1,{id:1,content:'old'})");
    await f.run("handleUpdatedMessage({id:1,group_id:10,content:'除外済み'})");
    await tick();
    assert.notEqual(f.run('quotedMessages.get(1)?.content'),'除外済み');
  } finally { await f.close(); }
});

test('context rechecks exact target before selecting room or marking read',async()=>{
  const f=await fixture();
  try {
    f.rpc(async(name,body)=>{assert.equal(name,'chat_own_history_states_v1');return {data:states(body.p_group_ids)};});
    f.query(async(table,ops)=> {assert.equal(table,'chat_messages'); assert.ok(ops.some(o=>o[0]==='eq'&&o[1]==='id'&&o[2]===1)); return {data:[]};});
    await f.run("openMessageAt(10,'2026-01-01T00:00:00Z',1)");
    assert.equal(f.run('currentGroupId'),null);
    assert.equal(f.calls.some(c=>c.table==='chat_read_states'),false);
  } finally {await f.close();}
});

for (const reader of ['loadLastMessages()', "runMessageSearch('古い')", 'loadQuotedMessages([{reply_to_id:1}])', 'loadOlderMessages()', 'fillLatestGap()']) {
  test('revision rejects held raw body through actual '+reader, async () => {
    const f=await fixture();
    try {
      let release;
      const held=new Promise(resolve=>release=resolve);
      f.rpc(async(name,body)=> {assert.equal(name,'chat_own_history_states_v1'); return {data:states(body.p_group_ids,'0',false)};});
      f.query(async(table)=> { assert.equal(table,'chat_messages'); return held; });
      f.run("currentGroupId=10; currentRoomMembership=myGroups[0].membership; viewHasLatest=false; currentMessages=[{id:5,group_id:10,created_at:'2026-01-02T00:00:00Z'}]");
      const read=f.run(reader); await tick();
      f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}])");
      release({data:[{id:1,group_id:10,username:'検証',content:'古い本文',created_at:'2026-01-01T00:00:00Z'}]});
      await read;
      assert.equal(f.run('JSON.stringify([currentMessages,lastMessages,messageSearchHits,[...quotedMessages.values()]])').includes('古い本文'),false);
    } finally { await f.close(); }
  });
}

test('membership computed fields are selected and retained without removing authorized suppressed room', async()=>{
  const f=await fixture();
  try {
    f.query(async(table,ops)=>{
      if(table==='chat_group_members' && ops.some(o=>o[0]==='eq'&&o[1]==='user_id')) {
        assert.match(ops.find(o=>o[0]==='select')[1],/own_history_revision/);
        assert.match(ops.find(o=>o[0]==='select')[1],/own_history_suppressed/);
        return {data:[{can_view:true,own_history_revision:'1',own_history_suppressed:true,chat_groups:{id:10,group_name:'サンプル店舗A'}}]};
      }
      return {data:[]};
    });
    f.rpc(async(name,body)=>name==='chat_unread_counts'?{data:[]}:{data:states(body.p_group_ids,'1',true)});
    assert.equal(await f.run('loadGroups()'),true);
    assert.equal(f.run('myGroups.length'),1);
    assert.equal(f.run('myGroups[0].own_history_revision'),'1');
    assert.equal(f.w.document.querySelectorAll('#myGroupsList .swipe-row').length,0);
  } finally { await f.close(); }
});

test('suppressed room cannot return via room-name search or cached history; empty latest is authoritative', async () => {
  const f=await fixture();
  try {
    f.run("myGroups[0].own_history_revision='1'; myGroups[0].own_history_suppressed=true; $('talkSearch').value='サンプル'; renderGroups()");
    assert.equal(f.w.document.querySelectorAll('#myGroupsList .swipe-row').length,0);
    f.run("roomViewCache.set(10,{messages:[{id:1,content:'古い本文'}],notes:[],reactions:new Map(),quoted:new Map(),members:[],readStates:[]})");
    assert.equal(f.run('applyRoomViewCache(10)'),false);
    assert.equal(f.run('mergeLatestPage([{id:1}],[]).length'),0);
  } finally { await f.close(); }
});

test('held actual send receipt settles success without reinserting pre-clear body; new post is shown', async () => {
  const f=await fixture();
  try {
    let release;
    const held=new Promise(resolve=>release=resolve);
    f.query(async (table,ops) => {
      assert.equal(table,'chat_messages');
      if(ops.some(o=>o[0]==='insert')) return held;
      return {data:[]};
    });
    f.rpc(async (name,body) => {
      if(name==='chat_own_history_states_v1') return {data:states(body.p_group_ids,'1',false)};
      throw Error('Unexpected '+name);
    });
    f.run('currentGroupId=10; currentRoomMembership=myGroups[0].membership');
    const send=f.run("sendChatText('送信済み・返却待ち')"); await tick();
    f.run("ownHistoryApplyStates([{group_id:'10',revision:'1',timeline_suppressed:true}]); $('messageInput').value='新しい下書き'");
    release({data:{id:1,group_id:10,user_id:OWNER,content:'送信済み・返却待ち',created_at:'2026-01-01T00:00:00Z'}});
    assert.equal(await send,true);
    assert.equal(f.run('currentMessages.length'),0);
    assert.equal(f.run('lastMessages[10]'),undefined);
    assert.equal(f.w.document.getElementById('messageInput').value,'新しい下書き');
    f.query(async()=>({data:[{id:2,group_id:10,user_id:OWNER,content:'新着',created_at:'2026-01-02T00:00:00Z'}]}));
    await f.run("ownHistoryAcceptMessage({id:2,group_id:10,user_id:currentUser.id,content:'新着',created_at:'2026-01-02T00:00:00Z'})");
    assert.equal(f.run('currentMessages[0].id'),2);
  } finally { await f.close(); }
});

test('unknown stays locked on not_found; exact status acknowledgement or identical retry only', async () => {
  const f = await fixture();
  try {
    let receipt, writes=0, first;
    f.rpc(async (name, body) => {
      if (name==='chat_unread_counts') return {data:[]};
      if (name==='chat_own_history_capabilities_v1') return {data:capabilities};
      if (name==='chat_own_history_states_v1') return {data:states(body.p_group_ids,'1',false)};
      if (name==='chat_own_history_operation_v1') return {data:receipt || {contract_version:1,user_id:OWNER,group_id:'10',request_id:body.p_request_id,status:'not_found'}};
      assert.equal(name,'chat_clear_own_history_v1');
      writes++;
      if (!first) { first=body; throw new Error('response lost after commit'); }
      assert.deepEqual(body,first); receipt=applied(body); return {data:receipt};
    });
    await assert.rejects(f.run("ownHistoryCommand(10,'clear')"), /response lost/);
    assert.equal(await f.run("ownHistoryCommand(10,'read')"),false);
    assert.equal(await f.run("ownHistoryCommand(10,'clear')"),false);
    const status=await f.run('ownHistoryOperationStatus(10)');
    assert.equal(status.status,'not_found');
    assert.equal(f.run('ownHistoryScope(10).intent.request_id'),first.p_request_id);
    assert.equal(f.run('ownHistoryAcknowledge(10, ownHistoryScope(10).proof)'),false);
    assert.equal(await f.run("ownHistoryCommand(10,'clear',true)"),true);
    assert.equal(writes,2);
    assert.equal(f.run('myGroups[0].own_history_suppressed'),false,'new post revival is not overwritten by receipt');
  } finally { await f.close(); }
});

test('queued real row callback cannot mutate after rerender, query edit, permission ABA or same-user relogin', async () => {
  for (const revoke of ["renderGroups()", "$('talkSearch').value='別検索'; handleTalkSearchInput()", "handleMembershipChanged({group_id:10,user_id:currentUser.id,can_view:false})", "ownHistorySetSession({...ownHistorySession})"]) {
    const f=await fixture();
    try {
      f.run('renderGroups()');
      const button=f.w.document.querySelector('.swipe-pin');
      const callback=button.onclick;
      f.query(async(table)=>{assert.ok(['chat_group_members','chat_groups'].includes(table));return {error:Error('synthetic permission refresh offline')};});
      f.run(revoke);
      callback({stopPropagation(){}});
      await tick();
      assert.equal(f.calls.filter(c=>c.name==='chat_set_pin').length,0,revoke);
    } finally { await f.close(); }
  }
});

test('actual shipped row exposes five independent actions, never exit or room delete', async () => {
  const f = await fixture();
  try {
    const row = f.run('renderTalkRow(myGroups[0], {})');
    assert.equal(row.querySelectorAll('.swipe-actions-left button').length, 2);
    assert.equal(row.querySelectorAll('.swipe-actions-right button').length, 3);
    assert.match(row.querySelector('.swipe-read').textContent, /既読/);
    assert.match(row.querySelector('.swipe-clear').textContent, /削除/);
    assert.doesNotMatch(row.textContent, /退出|完全削除/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('clear confirmation runs actual v1 RPC with durable fixed intent and exact receipt', async () => {
  const f = await fixture();
  try {
    f.rpc(async (name, body) => {
      if (name === 'chat_own_history_capabilities_v1') return {data:capabilities};
      if (name === 'chat_unread_counts') return {data:[]};
      if (name === 'chat_own_history_states_v1') return {data:states(body.p_group_ids, f.calls.some(c=>c.name==='chat_clear_own_history_v1')?'1':'0', f.calls.some(c=>c.name==='chat_clear_own_history_v1'))};
      assert.equal(name, 'chat_clear_own_history_v1');
      const saved = JSON.parse(f.w.localStorage.getItem('mtalk-own-history-v1:' + OWNER + ':10'));
      assert.equal(saved.request_id, body.p_request_id);
      assert.equal(saved.expected_revision, '0');
      assert.equal(saved.kind, 'clear');
      assert.equal(body.p_contract_version, 1);
      return {data:applied(body)};
    });
    f.run(`currentGroupId=10; currentMessages=[{id:1,group_id:10,content:'消去前'}]; currentPrivateNotes=[{id:5,content:'個人メモ'}]; $('messageInput').value='未送信の下書き';`);
    assert.equal(await f.run("ownHistoryCommand(10,'clear')"), true);
    assert.equal(f.run('currentMessages.length'), 0);
    assert.equal(f.run('myGroups.length'), 1, 'authorization membership is retained');
    assert.equal(f.run('myGroups[0].own_history_suppressed'), true);
    assert.equal(f.run('currentPrivateNotes[0].content'), '個人メモ');
    assert.equal(f.w.document.getElementById('messageInput').value, '未送信の下書き');
    assert.equal(f.w.localStorage.length, 0);
    assert.deepEqual(f.calls.filter(c=>c.name && !c.name.startsWith('chat_own_history') && c.name!=='chat_clear_own_history_v1' && c.name!=='chat_unread_counts'), []);
  } finally { await f.close(); }
});
