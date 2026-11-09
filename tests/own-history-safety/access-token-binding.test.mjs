import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,deferred,tick} from './fixture.mjs';
test('S02 current access response is bound to token value as well as session object',async()=>{const f=await fixture();try{const held=deferred();f.query(async t=>t==='chat_user_access'?held.promise:undefined);f.run('currentChatAccess.can_review_access=false');const read=f.run('loadCurrentChatAccess()');await tick();f.session.access_token='synthetic-new-token-no-event';held.resolve({data:{access_enabled:true,signup_status:'approved',can_review_access:true}});await read;assert.equal(f.run('currentChatAccess.can_review_access'),false);}finally{await f.close();}});
