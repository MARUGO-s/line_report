// Synthetic fixtures only. No live login, network, or production records.
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const capabilities = ['view','audit_read','manage_members','manage_rooms','manage_bots','manage_templates','manage_users','revert_audit'];
export const fixture = {
  users: [
    {id:'11111111-1111-4111-8111-111111111111',username:'サンプル店長',room_count:3,access:{access_enabled:true,can_start_direct:true,can_create_group:false,can_browse_users:true,updated_at:'2026-11-01T00:00:00Z'}},
    {id:'22222222-2222-4222-8222-222222222222',username:'サンプルスタッフ',room_count:2,access:{access_enabled:false,restriction_reason:'表示確認用の架空データです',updated_at:'2026-11-01T00:00:00Z'}},
    {id:'33333333-3333-4333-8333-333333333333',username:'サンプル店舗Bot',is_bot:true,room_count:1,access:{}},
  ],
  rooms: [
    {id:10,group_name:'サンプル店舗・連絡ルーム',member_count:3,members:[
      {user_id:'11111111-1111-4111-8111-111111111111',username:'サンプル店長',can_view:true,can_send:true,can_invite:false,can_manage:false},
      {user_id:'22222222-2222-4222-8222-222222222222',username:'サンプルスタッフ',can_view:true,can_send:false,can_invite:false,can_manage:false},
      {user_id:'33333333-3333-4333-8333-333333333333',username:'サンプル店舗Bot',is_bot:true,can_view:true,can_send:true},
    ]},
    {id:20,group_name:'サンプル店長との1対1',is_direct:true,member_count:2,members:[]},
  ],
  summary:{active_users:24,suspended_users:2,deleted_users:1,bot_users:4,deleted_bot_users:0,group_rooms:8,direct_rooms:12},
  admin_authority:{is_full_admin:true,label:'本部管理者（見本）',scope_mode:'all',capabilities},
  store_catalog:[{store_key:'sample',store_name:'サンプル店舗'}],
  audit_logs:[{id:100,created_at:'2026-11-03T12:00:00Z',actor:'本部管理者（見本）',action:'user_access_update',before_state:{access_enabled:true},after_state:{access_enabled:false},revertible:true}],
};

export async function mockAdminPage(page, root, {baselineHtml, delegated = false, writeStatus = 200} = {}) {
  const writes = [], blocked = [], errors = [];
  const data = structuredClone(fixture);
  if (delegated) data.admin_authority = {is_full_admin:false,label:'店舗管理者（見本）',scope_mode:'stores',store_keys:['sample'],capabilities:['view','audit_read','manage_members','manage_rooms']};
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4178') { blocked.push(url.origin + url.pathname); return route.abort(); }
    const pathname = url.pathname;
    if (pathname.startsWith('/__api/')) {
      const api = pathname.slice('/__api'.length);
      if (request.method() !== 'GET') {
        writes.push({path:api,method:request.method(),body:request.postDataJSON()});
        return route.fulfill({status:writeStatus,contentType:'application/json',body:JSON.stringify(writeStatus === 200 ? {} : {error:'検証用エラー：入力内容を確認してください'})});
      }
      const body = api === '/chat-admin/state' ? data : api === '/chat-admin/templates' ? {templates:[{key:'viewer',label:'閲覧のみ',can_view:true,can_send:false,can_invite:false,can_manage:false}],max_targets:100} : api === '/chat-admin/delegations' ? {delegations:[{id:'sample-delegate',label:'サンプル店舗管理者',scope_mode:'stores',store_keys:['sample'],enabled:true,expires_at:'2099-12-31T12:00:00Z',capabilities:['view','audit_read','manage_members']}]} : api.includes('/access') ? {user:data.users[0],access:data.users[0].access,effective:{can_use_mtalk:true},total_rooms:1,rooms:[{group_id:10,group_name:data.rooms[0].group_name,member_count:3,granted:{can_view:true,can_send:true},effective:{can_view:true,can_send:true},denial_reasons:[]}]} : {};
      return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    }
    if (pathname === '/pages-config.js') return route.fulfill({contentType:'text/javascript; charset=utf-8',body:"window.LINE_REPORT_PAGES={PROJECT_URL:location.origin,ADMIN_SURFACE:'line_report',adminApiUrl:p=>location.origin+'/__api'+p};"});
    if (pathname === '/auth-session.js') return route.fulfill({contentType:'text/javascript; charset=utf-8',body:"window.LINE_REPORT_AUTH={getToken:()=> 'fixture-not-a-real-credential',consumeUrlAuthParams:async()=>true,logout:async()=>{},loginWithToken:async()=>{}};"});
    if (pathname === '/site-cache.js') return route.fulfill({contentType:'text/javascript',body:''});
    if (pathname === '/favicon.ico') return route.fulfill({status:204,body:''});
    const file = resolve(root,'public','.'+pathname);
    if (!file.startsWith(resolve(root,'public')+sep)) return route.abort();
    try {
      const body = pathname === '/chat-admin.html' && baselineHtml ? baselineHtml : await readFile(file);
      const contentType = pathname.endsWith('.html') ? 'text/html; charset=utf-8' : pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/svg+xml';
      return route.fulfill({contentType,body});
    } catch { return route.fulfill({status:404,body:'not found'}); }
  });
  await page.goto('http://127.0.0.1:4178/chat-admin.html');
  await page.waitForSelector('#dashboardView:not(.hidden)');
  await page.evaluate(() => {
    const notice = document.createElement('div');
    notice.id='fixtureNotice'; notice.textContent='見本データ（本番の情報ではありません）';
    Object.assign(notice.style,{position:'fixed',bottom:'92px',right:'8px',zIndex:1000,fontSize:'10px',padding:'4px 8px',borderRadius:'6px',color:'#a8b9ca',background:'#0a111c',pointerEvents:'none'});
    document.body.append(notice);
  });
  return {writes,blocked,errors};
}
