import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL('../'+path,import.meta.url),'utf8');
const adapter = async () => (await read('public/chat-admin.html')).match(/<script data-admin-mobile-adapter>\n([\s\S]*?)  <\/script>/)[1];

test('admin mobile adapter runs after existing controls and is covered by the admin page',async()=>{
  const html = await read('public/chat-admin.html');
  assert.match(html,/<link rel="stylesheet" href="chat-admin-mobile\.css">/);
  assert.match(html,/<script data-admin-mobile-adapter>/);
  assert.ok(html.indexOf('<script data-admin-mobile-adapter>') > html.indexOf('id="revertDialog"'));
  for (const id of ['userForm','loginForm','delegationForm','userRows','roomRows','roomDetail','userDialog','accessDialog','templateDialog','revertDialog']) assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html,/if \(!can\('manage_users'\)\) return/);
  assert.match(html,/delegationNav'\)\.classList\.toggle\('hidden', !isHeadquarters\(\)\)/);
});

test('mobile presentation does not add credential, persistence, or write paths',async()=>{
  const js = await adapter();
  assert.doesNotMatch(js,/\bfetch\s*\(|\bXMLHttpRequest\b|\blocalStorage\b|\bsessionStorage\b|\bLINE_REPORT_AUTH\b|\bgetToken\s*\(/);
  assert.doesNotMatch(js,/\.checked\s*=|\.disabled\s*=|cloneNode\s*\(|replaceChildren\s*\(/);
  assert.doesNotMatch(js,/classList\.(?:remove|toggle)\(['"]hidden['"]/);
  assert.match(js,/matchMedia\('\(max-width:980px\)'\)/);
  assert.match(js,/if \(!media\.matches \|\| !button/);
  assert.match(js,/link\.parentElement !== moreBody/);
  assert.match(js,/host\.append\(small\)/);
});

test('phone style fits content rather than hiding overflow or disabling zoom',async()=>{
  const css = await read('public/chat-admin-mobile.css');
  assert.match(css,/@media \(max-width:980px\)/);
  assert.match(css,/\.nav \{ position:fixed/);
  assert.match(css,/table,\.diff-table \{[^}]*min-width:0/);
  assert.match(css,/\.perm-grid \{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/env\(safe-area-inset-bottom,0px\)/);
  assert.match(css,/font-size:16px/);
  assert.doesNotMatch(css,/overflow-x:\s*hidden|zoom\s*:|touch-action:\s*none/);
});

test('permission labels, mobile back and active navigation remain explicit',async()=>{
  const js = await adapter();
  for (const value of ['can_view','can_send','can_invite','can_manage']) assert.match(js,new RegExp(value));
  assert.match(js,/back\.type = 'button'/);
  assert.match(js,/adminRoomDetail = 'false'/);
  assert.match(js,/aria-current/);
  assert.match(js,/MutationObserver/);
  assert.doesNotMatch(js,/innerHTML\s*=\s*(?:state|user|room|data|response)\b/);
});
