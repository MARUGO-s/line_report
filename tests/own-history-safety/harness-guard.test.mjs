import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,exactPrivateNoteInsert} from './fixture.mjs';
test('HARNESS only: application-caught unexpected RPC must still fail teardown',async()=>{
 const f=await fixture();
 await f.run('loadLastMessages()');
 assert.equal(f.denied.length,1);
 await assert.rejects(f.close(),/Forbidden attempts at teardown/);
 console.log('HARNESS_GUARD '+JSON.stringify({intentionalMockRefusals:f.denied,realNetworkCalls:0}));
});
test('HARNESS only: private-note fixture permits exact receipt INSERT, never caught other mutations',async()=>{
 const f=await fixture();
 f.query(async(table,ops)=>table==='chat_private_notes'&&exactPrivateNoteInsert(ops,'allowed')?{data:{id:901,group_id:10,content:'allowed'}}:undefined);
 const good=await f.run(`sb.from('chat_private_notes').insert({group_id:10,user_id:'${OWNER}',content:'allowed'}).select('id, group_id, content, created_at').single()`);
 assert.equal(good.data.id,901);
 for(const source of [
  `sb.from('chat_private_notes').insert({group_id:11,user_id:'${OWNER}',content:'allowed'}).select('id, group_id, content, created_at').single()`,
  `sb.from('chat_private_notes').insert({group_id:10,user_id:'other-owner',content:'allowed'}).select('id, group_id, content, created_at').single()`,
  `sb.from('chat_private_notes').insert({group_id:10,user_id:'${OWNER}',content:'not allowed'}).select('id, group_id, content, created_at').single()`,
  `sb.from('chat_private_notes').delete().eq('group_id',10)`,
  `sb.from('chat_keep_items').delete().eq('id',901)`
 ]) await f.run(`(async()=>{try{await ${source}}catch(_){}})()`);
 assert.equal(f.denied.length,5);
 await assert.rejects(f.close(),/Forbidden attempts at teardown/);
});
