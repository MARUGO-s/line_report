import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OWNER,standardRpc,deferred,tick} from './fixture.mjs';

test('SAFE same-object TOKEN_REFRESHED JWT ABA cannot revive held search lease',async()=>{
 const f=await fixture();try{
  const raw=deferred();f.rpc(standardRpc);f.query(async(table)=>table==='chat_messages'?raw.promise:undefined);
  f.run("$('talkSearch').value='JWT'");const search=f.run("runMessageSearch('JWT')");await tick();
  const jwt=f.session.access_token,epoch=f.run('ownHistoryAuthEpoch');
  f.session.access_token='synthetic-intermediate-JWT';f.listeners.forEach(fn=>fn('TOKEN_REFRESHED',f.session));
  f.session.access_token=jwt;f.listeners.forEach(fn=>fn('TOKEN_REFRESHED',f.session));
  raw.resolve({data:[{id:101,group_id:10,user_id:OWNER,username:'合成',content:'JWT更新前本文',created_at:'2026-01-01T00:00:00Z'}]});await search;
  const hits=JSON.parse(f.run('JSON.stringify(messageSearchHits)'));
  console.log('OBSERVATION '+JSON.stringify({id:'same-object-jwt-ABA',epochBefore:epoch,epochAfter:f.run('ownHistoryAuthEpoch'),hits}));
  assert.equal(hits.length,0,'observed token changes must latch even if values later return and session object identity is stable');
 }finally{await f.close();}
});
