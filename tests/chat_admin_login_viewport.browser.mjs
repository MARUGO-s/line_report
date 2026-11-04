// Physical domain geometry: 462 CSS px on a 393px iPhone screen.
// Mock only auth/API. Never send a token or a mutation to production.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {mockAdminPage} from './helpers/chat-admin-browser-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const out=process.env.ADMIN_SCREENSHOT_DIR;
assert.ok(out,'Explicit evidence directory required');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const results=[];
try {
 for(const [width,screenWidth] of [[462,393],[524,393],[393,393],[320,320]]) {
  const context=await browser.newContext({viewport:{width,height:817},screen:{width:screenWidth,height:852},deviceScaleFactor:3,isMobile:true,hasTouch:true});
  try {
   const page=await context.newPage();
   const evidence=await mockAdminPage(page,root,{startLoggedOut:true});
   await page.waitForSelector('#loginView:not(.hidden)');
   const geometry=await page.locator('#tokenInput').evaluate(el=>({font:parseFloat(getComputedStyle(el).fontSize),layout:document.documentElement.clientWidth,screen:screen.width,visual:visualViewport.width}));
   const effectiveFont=geometry.font*screenWidth/width;
   results.push({width,screenWidth,...geometry,effectiveFont});
   // Model a retained focus zoom only when the rendered input is below 16px.
   // This reproduces the visual failure mechanism, not an iOS keyboard test.
   if(effectiveFont<16-.05) {
    const cdp=await context.newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:width/screenWidth});
   }
   await page.locator('#tokenInput').fill('fixture-only-not-a-credential');
   await page.locator('#loginForm').evaluate(form=>form.requestSubmit());
   await page.waitForFunction(()=>document.documentElement.dataset.adminAuthenticated==='true');
   await page.screenshot({path:resolve(out,`login-${width}-screen-${screenWidth}.png`)});
   const view=await page.evaluate(()=>({layout:innerWidth,visual:visualViewport.width,scale:visualViewport.scale,offset:visualViewport.offsetLeft,meta:document.querySelector('meta[name=viewport]').content}));
   results.at(-1).afterLogin=view;
   await writeFile(resolve(out,'login-viewport-results.json'),JSON.stringify(results,null,2));
   assert.ok(effectiveFont>=16-.05,`login input renders at ${effectiveFont}px on ${screenWidth}px screen / ${width}px layout; Safari focus-zoom risk`);
   assert.ok(view.visual>=width-.5,'auth transition must not retain modelled input-focus magnification');
   assert.doesNotMatch(view.meta,/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:[,.\s]|$)/i,'Do not disable accessible pinch zoom');
   // Deliberate user magnification must remain available after authentication.
   const pinch=await context.newCDPSession(page);
   await pinch.send('Emulation.setPageScaleFactor',{pageScaleFactor:1.5});
   await page.waitForTimeout(100);
   assert.ok(Math.abs(await page.evaluate(()=>visualViewport.scale)-1.5)<.01,'Do not reset deliberate pinch zoom');
   assert.deepEqual(evidence.writes,[]);assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.blocked,[]);
  } finally {await context.close();}
 }
 console.log(JSON.stringify({passed:true,results},null,2));
} finally {await browser.close();}
