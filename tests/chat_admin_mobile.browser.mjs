// Optional real-browser regression: all API/auth boundaries are mocked, never live.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mockAdminPage } from './helpers/chat-admin-browser-fixture.mjs';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root = fileURLToPath(new URL('..',import.meta.url));
const out = resolve(process.env.ADMIN_SCREENSHOT_DIR || new URL('../.admin-mobile-proof',import.meta.url).pathname);
await mkdir(out,{recursive:true});
const html = await readFile(resolve(root,'public/chat-admin.html'),'utf8');
const baselineHtml = html.replace(/\s*<link rel="stylesheet" href="chat-admin-mobile\.css">/,'').replace(/\s*<script data-admin-mobile-adapter>[\s\S]*?<\/script>/,'');
const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const results = [];
async function fresh(width, options = {}) {
  const context = await browser.newContext({viewport:{width,height:width>=844 && width<=980 ? 390 : 844},deviceScaleFactor:1,isMobile:width<=980,hasTouch:width<=980});
  const page = await context.newPage();
  const evidence = await mockAdminPage(page,root,options);
  if (!options.baselineHtml) await page.waitForFunction(()=>document.documentElement.dataset.adminAuthenticated==='true');
  return {context,page,evidence};
}
async function jump(page, section) {
  await page.locator('[data-jump="'+section+'"]').click();
  if (await page.locator('html').getAttribute('data-admin-section')) {
    await page.waitForFunction(s=>document.documentElement.dataset.adminSection===s,section);
  }
}
async function fits(page, selector, width) {
  const failures = await page.locator(selector).evaluateAll((elements,w)=>elements.filter(el=>el.getClientRects().length).map(el=>({tag:el.tagName,id:el.id,rect:el.getBoundingClientRect()})).filter(({rect})=>rect.left<-.5 || rect.right>w+.5).map(({id,tag,rect})=>({id,tag,left:rect.left,right:rect.right})),width);
  assert.deepEqual(failures,[],selector+' must fit '+width);
}
function clean(evidence) { assert.deepEqual(evidence.errors,[]); assert.deepEqual(evidence.blocked,[]); }
async function userSave({baseline = false, status = 200, width = 390} = {}) {
  const run = await fresh(width,{baselineHtml:baseline?baselineHtml:undefined,writeStatus:status});
  const {page,evidence} = run;
  try {
    await jump(page,'users');
    await page.locator('[data-edit-user]').first().click();
    await page.locator('#editRestrictionReason').fill('未保存の文章・改行\n検証用');
    await page.locator('#editCanCreateGroup').check();
    if (!baseline) {
      if (status===200) await page.screenshot({path:resolve(out,'390-permission-dialog.png')});
      await page.setViewportSize({width,height:520});
      await fits(page,'#userDialog, #userDialog button, #userDialog input, #userDialog textarea',width);
      const foot = await page.locator('#userDialog .dialog-foot').boundingBox();
      assert.ok(foot.y+foot.height<=520.5,'dialog save controls must remain above keyboard-height viewport');
    }
    await page.locator('#saveUserBtn').click();
    await page.waitForFunction(()=>!document.body.classList.contains('is-busy'));
    await page.waitForTimeout(80);
    if (status===200) assert.equal(await page.locator('#userDialog').evaluate(el=>el.open),false);
    else if (status===401 || status===409) {
      // Existing auth/conflict recovery intentionally closes dialogs; keep it unchanged.
      assert.equal(await page.locator('#userDialog').evaluate(el=>el.open),false);
      if (status===401) assert.equal(await page.locator('#loginView').isVisible(),true);
    } else {
      assert.equal(await page.locator('#userDialog').evaluate(el=>el.open),true);
      assert.equal(await page.locator('#editRestrictionReason').inputValue(),'未保存の文章・改行\n検証用');
      assert.match(await page.locator('#toast').textContent(),/検証用エラー/);
    }
    clean(evidence);
    return evidence.writes;
  } finally { await run.context.close(); }
}
async function memberSave(baseline) {
  const run = await fresh(390,{baselineHtml:baseline?baselineHtml:undefined});
  try {
    await jump(run.page,'rooms');
    await run.page.locator('[data-room-id="10"]').click();
    await run.page.locator('[data-member-id="11111111-1111-4111-8111-111111111111"] [data-member-permission="can_send"]').uncheck();
    await run.page.waitForFunction(()=>!document.body.classList.contains('is-busy'));
    clean(run.evidence);
    return run.evidence.writes;
  } finally { await run.context.close(); }
}
try {
  // Retain a genuine before capture from the same application without the adapter.
  const before = await fresh(390,{baselineHtml});
  await before.page.screenshot({path:resolve(out,'390-before-overview.png')});
  await jump(before.page,'users');
  await before.page.screenshot({path:resolve(out,'390-before-users.png')});
  clean(before.evidence); await before.context.close();
  for (const width of [320,390,430,760,844,956]) {
    const {context,page,evidence} = await fresh(width);
    try {
      assert.equal(await page.locator('.nav').evaluate(el=>getComputedStyle(el).position),'fixed');
      await fits(page,'.side,.main,.nav,.metric,.scope-banner',width);
      const doc = await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert.ok(doc.scroll<=doc.width,'root must not overflow');
      if (width===390) await page.screenshot({path:resolve(out,'390-overview.png')});
      await jump(page,'users');
      await fits(page,'#userRows tr,#userRows td .btn,#userSearch,#userStatus',width);
      assert.equal(await page.locator('#rooms').isVisible(),false,'one section per mobile screen');
      await page.locator('#userSearch').fill('店長');
      assert.equal(await page.locator('#userRows tr').count(),1);
      await page.locator('#userSearch').fill('');
      if (width===390) await page.screenshot({path:resolve(out,'390-users.png')});
      await jump(page,'rooms');
      await page.locator('[data-room-id="10"]').click();
      await page.waitForFunction(()=>document.documentElement.dataset.adminRoomDetail==='true');
      await page.waitForSelector('.mobile-permission-label');
      await fits(page,'.room-detail,.member-row,.template-bar,.member-cell',width);
      assert.equal(await page.locator('#roomRows').isVisible(),false);
      assert.equal(await page.locator('.mobile-permission-label').count(),12);
      if (width===390) await page.screenshot({path:resolve(out,'390-room.png'),fullPage:true});
      await page.locator('.mobile-room-back').click();
      assert.equal(await page.locator('#roomRows').isVisible(),true);
      await jump(page,'audit');
      await fits(page,'.audit,.audit .btn',width);
      await jump(page,'delegations');
      await fits(page,'.delegate-form,.delegate-row,.delegate-targets,.delegate-capabilities,#delegationSaveBtn',width);
      await page.locator('#delegationLabel').fill('未保存の管理者名');
      await page.evaluate(()=>window.__draftNode=document.getElementById('delegationLabel'));
      await jump(page,'users'); await jump(page,'delegations');
      assert.equal(await page.locator('#delegationLabel').inputValue(),'未保存の管理者名');
      await page.setViewportSize({width:1100,height:800});
      await page.waitForFunction(()=>matchMedia('(min-width:981px)').matches);
      await page.setViewportSize({width,height:844});
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#delegationLabel').inputValue(),'未保存の管理者名');
      assert.equal(await page.evaluate(()=>window.__draftNode===document.getElementById('delegationLabel')),true,'rotation must preserve DOM/input identity');
      await page.locator('.admin-more > summary').click();
      await fits(page,'.admin-more-body,.admin-more-body button,.admin-more-body a',width);
      clean(evidence); assert.deepEqual(evidence.writes,[],'layout-only controls must not write');
      results.push({width,layout:'pass',input_retention:'pass',unexpected_writes:0});
    } finally { await context.close(); }
  }
  for (const status of [200,400,401,403,409,500]) {
    const previous = await userSave({baseline:true,status});
    const candidate = await userSave({status});
    assert.equal(candidate.length,1); assert.deepEqual(candidate,previous,'user payload/error behavior must match without mobile adapter');
    results.push({operation:'user_save',status,payload_equivalence:'pass'});
  }
  assert.deepEqual(await memberSave(false),await memberSave(true),'member write payload must stay identical');
  results.push({operation:'member_permission',payload_equivalence:'pass'});
  const limited = await fresh(390,{delegated:true});
  assert.equal(await limited.page.locator('#delegationNav').isVisible(),false);
  await limited.page.locator('.admin-more > summary').click();
  assert.equal(await limited.page.locator('#hqDashboardLink').isVisible(),false);
  await jump(limited.page,'users');
  assert.equal(await limited.page.locator('[data-edit-user]').count(),0);
  clean(limited.evidence); await limited.context.close();
  results.push({operation:'delegated_authority_visibility',status:'pass'});
  const desktopOld = await fresh(1440,{baselineHtml});
  const oldImage = await desktopOld.page.screenshot({path:resolve(out,'1440-before.png')});
  const desktopNew = await fresh(1440);
  const newImage = await desktopNew.page.screenshot({path:resolve(out,'1440-after.png')});
  assert.equal(Buffer.compare(oldImage,newImage),0,'desktop must remain pixel-identical');
  clean(desktopOld.evidence); clean(desktopNew.evidence);
  await desktopOld.context.close(); await desktopNew.context.close();
  results.push({operation:'desktop_1440_pixel_equivalence',status:'pass'});
  await writeFile(resolve(out,'results.json'),JSON.stringify({passed:true,results},null,2));
  console.log(JSON.stringify({passed:true,checks:results.length,results,screenshots:out},null,2));
} finally { await browser.close(); }
