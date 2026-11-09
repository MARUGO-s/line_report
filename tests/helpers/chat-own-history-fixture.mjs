import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { chatScriptPaths } from './chat-page-source.mjs';

export const OWNER = '11111111-1111-4111-8111-111111111111';
export async function fixture() {
  const html = readFileSync(new URL('../../public/chat.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://synthetic.invalid/chat.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [], forbidden = [], alerts = [], listeners = [];
  const session = { user: { id: OWNER }, access_token: 'synthetic-session-only' };
  let rpc = async (name) => { forbidden.push({rpc:name}); throw new Error('Unexpected RPC: ' + name); };
  let query = async (table) => { forbidden.push({table}); throw new Error('Unexpected SELECT: ' + table); };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.requestAnimationFrame = () => 0;
  w.HTMLCanvasElement.prototype.getContext = () => ({ measureText: () => ({width:8}) });
  w.alert = text => alerts.push(text);
  w.confirm = () => true;
  w.fetch = (...args) => { forbidden.push(args); throw new Error('Live network forbidden'); };
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.supabase = { createClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: fn => { listeners.push(fn); return { data: { subscription: { unsubscribe() {} } } }; } },
    rpc: async (name, body) => { calls.push({ name, body }); return rpc(name, body); },
    from: table => {
      const ops = [];
      const chain = new Proxy({}, { get: (_, key) => key === 'then'
        ? (yes, no) => { calls.push({ table, ops }); return Promise.resolve().then(() => query(table, ops)).then(yes, no); }
        : (...args) => { ops.push([key, ...args]); return chain; } });
      return chain;
    }
  }) };
  // Execute the shipped scripts in the HTML's real order, including bootstrap.
  const run = source => vm.runInContext(source, dom.getInternalVMContext());
  for (const path of chatScriptPaths()) run(readFileSync(new URL('../../public/' + path, import.meta.url), 'utf8'));
  await new Promise(resolve => setImmediate(resolve));
  run(`currentUser = { id: '${OWNER}', username: '検証ユーザー' }; currentChatAccess = {access_enabled:true,signup_status:'approved'};
    myGroups = [{id:10,group_name:'サンプル店舗A',created_at:'2026-01-01T00:00:00Z',membership:{can_view:true,can_send:true},own_history_revision:'0',own_history_suppressed:false}];
    talkTab='all';`);
  listeners.forEach(fn => fn('SIGNED_IN', session));
  return { w, dom, calls, forbidden, alerts, session, run, listeners,
    rpc(fn) { rpc = fn; }, query(fn) { query = fn; },
    async close() {
      await new Promise(resolve=>setImmediate(resolve));
      await new Promise(resolve=>setImmediate(resolve));
      dom.window.close();
      if (forbidden.length) throw new Error('Forbidden network attempted: '+JSON.stringify(forbidden));
    }
  };
}
export const capabilities = { contract_version: 1, own_clear_supported: true, snapshot_semantics: 'statement_visible_ids', mark_read_supported: true };
export function states(ids, revision='0', suppressed=false) { return ids.map(id => ({contract_version:1,user_id:OWNER,group_id:String(id),revision,timeline_suppressed:suppressed})); }
export function applied(body, kind='clear', extra={}) { return {contract_version:1,kind,user_id:OWNER,group_id:String(body.p_group_id),request_id:body.p_request_id,applied_revision:kind==='clear'?'1':'0',status:'applied',...extra}; }
