import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { captureReady } from '../helpers/capture.ts';

const outputRoot = resolve(__dirname, '..');
const results = resolve(outputRoot, '../test-results');
registerSchemes(); app.enableSandbox();
app.setPath('userData', join(results, 'product-entry-profile-' + randomUUID()));
const passed: string[] = [];
const pass = (value: string) => { passed.push(value); console.log('PASS: ' + value); };
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error('TIMEOUT: ' + label); await delay(25); }
}
async function click(window: BrowserWindow, selector: string, label = ''): Promise<void> {
  const hit: {point: {x: number; y: number} | null} = {point:null};
  await until(async () => {
    hit.point = await window.webContents.executeJavaScript('(() => {const e=[...document.querySelectorAll(' + JSON.stringify(selector)
      + ')].find(e=>e.getBoundingClientRect().width>0&&!e.disabled&&e.textContent.includes(' + JSON.stringify(label)
      + '));if(!e)return null;const b=e.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()');
    return hit.point !== null;
  }, 'enabled product control ' + label);
  assert.ok(hit.point);
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({ type: 'mouseDown', ...hit.point, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...hit.point, button: 'left', clickCount: 1 });
}
function key(contents: WebContents, keyCode: string, modifiers: ('control' | 'shift')[] = []): void {
  contents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  // Enter activation needs the character event as well as physical down/up.
  if(keyCode==='Enter'&&modifiers.length===0) contents.sendInputEvent({type:'char',keyCode:'\r'});
  contents.sendInputEvent({type:'keyUp',keyCode,modifiers});
}
async function select(contents: WebContents): Promise<void> {
  const point = await contents.executeJavaScript('(() => {const e=document.querySelector("h1"),r=document.createRange();r.setStart(e.firstChild,0);r.setEnd(e.firstChild,1);const b=r.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()');
  contents.focus();
  contents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  contents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
}
async function typeText(window: BrowserWindow, value: string): Promise<void> {
  await until(() => window.webContents.executeJavaScript('!!document.querySelector("textarea.draft-input:not(:disabled)")'), 'current owner input');
  await window.webContents.executeJavaScript('(() => {const e=document.querySelector("textarea.draft-input");e.focus();e.select();})()');
  window.focus(); window.webContents.focus(); await window.webContents.insertText(value);
}
const source = (title: string) => Buffer.from('\ufeff<!doctype html>\r\n<html lang="zh-CN"><head><meta charset="utf-8"><title>入口测试</title><link rel="stylesheet" href="../assets/keep.css"></head><body><h1>'
  + title + '</h1><p>保留 &amp; 原样</p><script>globalThis.entryScript=41</script><!-- 未修改 --></body></html>\r\n');
const original = source('报告 &amp; 😀'), second = source('附录 🧪');
const css = Buffer.from('body{font:20px sans-serif;padding:24px;min-height:1200px;color:rgb(12,34,56)}');

async function run(): Promise<void> {
  await mkdir(results, {recursive:true}); await app.whenReady();
  const fixture = await mkdtemp(join(results, 'product-entry-'));
  const root = join(fixture, '项目 中文 🧪'), reports = join(root, '报告'), appendices = join(root, '附录');
  await mkdir(reports, {recursive:true}); await mkdir(appendices); await mkdir(join(root,'assets'));
  const firstPath = join(reports,'入口.html'), secondPath = join(appendices,'入口.html'), outside = join(fixture,'根外.html');
  const copyPath = join(reports,'校稿副本.html'), occupiedCopy = join(reports,'已有副本.html');
  await writeFile(firstPath,original); await writeFile(secondPath,second); await writeFile(outside,second);
  await writeFile(join(root,'assets/keep.css'),css); await writeFile(occupiedCopy,'existing destination');
  let rootChoice: string | undefined, entryChoice: string | undefined, copyChoice: string | undefined;
  let rootCalls=0, entryCalls=0, reviewCalls=0, copyCalls=0, fileCalls=0;
  let leaveDecision: 'cancel' | 'save-copy' | 'discard' = 'cancel';
  let entryGate: Promise<string | undefined> | null = null;
  const gateControl: { release?: (value: string | undefined) => void } = {};
  let chooserInput: string | null = null;
  const chooserRoots: string[] = [];
  let product!: Awaited<ReturnType<typeof createProductApplication>>;
  product = await createProductApplication(outputRoot, {visible:false,bindQuit:false,choices:{
    open: async () => { fileCalls++; return firstPath; },
    project: {
      chooseDirectory: async () => { rootCalls++; return rootChoice; },
      chooseEntry: async directory => { entryCalls++; chooserRoots.push(directory);
        const input=product.runtime.workspace.snapshot().current?.input;
        if(input) { assert.equal(input.hasUnappliedInput,false); chooserInput=input.input?.appliedText ?? null; }
        return entryGate ?? entryChoice;
      },
    },
    copy: async () => { copyCalls++; return copyChoice; },
    review: async value => { reviewCalls++; return {reviewId:value.reviewId,decision:leaveDecision}; },
  }});
  const {window,runtime,desktop}=product;
  const state=()=>runtime.workspace.snapshot();
  const ui=(code:string)=>window.webContents.executeJavaScript(code);
  const desk=()=>desktop.extension(window.webContents).snapshot();
  const errors:string[]=[];
  window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  const menu=async()=>{
    await click(window,'.toolbar button[aria-label="更多操作"]'); await until(()=>ui('!!document.querySelector("[role=menu]")'),'menu rendered');
    // A native WebContentsView is above the editor's DOM. Direct renderer event
    // injection alone cannot prove that an OS mouse can reach this menu.
    await until(async()=>{
      const b=await ui('(() => {const r=document.querySelector("[role=menu]").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
      const p=runtime.host.current?.getBounds();
      return !(p&&p.width>0&&p.height>0&&p.x<b.x+b.width&&p.x+p.width>b.x&&p.y<b.y+b.height&&p.y+p.height>b.y);
    },'native Preview must not cover the product menu',3000);
  };
  const idle=async()=>{await until(async()=>state().phase==='idle'&&await ui('!document.querySelector(".toolbar button:not(.narrow-only)")?.disabled'),'product action idle');};
  const switchEntry=async()=>{await menu(); await click(window,'[role=menuitem]','切换目录内 HTML');};
  const settled=async(value:string)=>{await until(()=>{const i=state().current?.input;return i?.input?.appliedText===value&&!i.hasUnappliedInput&&!i.input.composing;},'live text '+value);};
  const filesUnchanged=async()=>{assert.deepEqual(await readFile(firstPath),original);assert.deepEqual(await readFile(secondPath),second);assert.deepEqual(await readFile(outside),second);assert.deepEqual(await readFile(join(root,'assets/keep.css')),css);};
  try {
    window.showInactive(); await until(()=>ui('!!document.querySelector(".app")'),'actual product assets');
    await menu(); assert.equal(await ui('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("切换目录内 HTML"))?.disabled'),true);
    key(window.webContents,'Escape'); await until(()=>ui('!document.querySelector("[role=menu]")'),'menu closed');
    for(const choice of ['root-cancel','entry-cancel','outside','valid']) {
      rootChoice=choice==='root-cancel'?undefined:root;
      entryChoice=choice==='outside'?outside:choice==='valid'?firstPath:undefined;
      const oldRoots=rootCalls;
      await click(window,'.toolbar button','打开目录');
      await until(()=>rootCalls===oldRoots+1&&state().phase==='idle','directory outcome '+choice); await idle();
      if(choice!=='valid') assert.equal(state().current,null);
    }
    await until(()=>state().current?.input.mappingStatus==='ready'&&(runtime.host.current?.getBounds().width??0)>0,'first native entry ready');
    const first=runtime.workspace.current!, firstId=first.id, grantIdentity=first.preview.grant.rootIdentity;
    assert.equal(state().current!.project.entry,'报告/入口.html'); assert.equal(first.preview.grant.root,root);
    assert.equal(await first.preview.contents.executeJavaScript('getComputedStyle(document.body).color'),'rgb(12, 34, 56)');
    assert.equal(await first.preview.contents.executeJavaScript('typeof entryScript'),'undefined');
    assert.equal(rootCalls,4); assert.equal(entryCalls,3); await filesUnchanged();
    pass('product directory opening preserves cancellation and root boundaries; a nested Unicode entry loads unchanged shared CSS');

    await select(first.preview.contents); await typeText(window,'已复核的目录草稿'); await settled('已复核的目录草稿');
    await click(window,'.check-all input'); await until(()=>desk().reviewed.length===1,'review bound to first draft');
    await first.preview.contents.executeJavaScript('scrollTo(0,40)');
    await until(()=>first.preview.contents.executeJavaScript('scrollY===40'),'nonzero preview scroll');
    for(const choice of ['cancel','outside','decline']) {
      entryChoice=choice==='outside'?outside:choice==='decline'?secondPath:undefined;
      const count=entryCalls; await switchEntry(); await until(()=>entryCalls===count+1&&state().phase==='idle','entry rejection '+choice); await idle();
      assert.equal(runtime.workspace.current,first); assert.equal(first.preview.contents.isDestroyed(),false);
      await until(()=>(runtime.host.current?.getBounds().width??0)>0,'same preview restored after menu');
      assert.equal(await first.preview.contents.executeJavaScript('scrollY'),40);
      assert.equal(state().current!.input.input!.appliedText,'已复核的目录草稿'); assert.equal(desk().reviewed.length,1); await filesUnchanged();
    }
    assert.equal(reviewCalls,1); assert.equal(rootCalls,4);
    pass('cancelled, outside-root and declined entry choices preserve the exact current draft, review and Preview without reauthorizing the root');

    await ui('(() => {const e=document.querySelector("textarea.draft-input");e.focus();e.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:""}));})()');
    await until(()=>state().current!.input.input?.composing===true,'composition guard');
    const beforeComposition=entryCalls; await menu();
    assert.equal(await ui('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("切换目录内 HTML"))?.disabled'),true);
    await delay(100); assert.equal(entryCalls,beforeComposition); key(window.webContents,'Escape');
    await ui('(() => {const e=document.querySelector("textarea.draft-input");e.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:e.value}));})()');
    await until(()=>state().current!.input.input?.composing===false,'explicit composition end');
    // Menu Escape during composition is intentionally ignored.
    if(await ui('!!document.querySelector("[role=menu]")')) {key(window.webContents,'Escape');await until(()=>ui('!document.querySelector("[role=menu]")'),'menu end');}
    pass('composition start without changed text disables entry switching and opens no chooser');

    await click(window,'.toolbar button[aria-label="在独立窗口中校稿"]');
    await until(()=>desk().panel==='floating','floating input owner');
    const floating=desktop.ownedWindows().find(value=>!value.getTitle().includes('PDF'))!;
    const floatingBounds=floating.getBounds();
    const pendingText='浮窗尚未投递 中文 🧪';
    await typeText(floating,pendingText);
    entryGate=new Promise(done=>{gateControl.release=done;});
    const beforeGate=entryCalls; await switchEntry();
    await until(()=>entryCalls===beforeGate+1,'only accepted chooser held');
    assert.equal(chooserInput,pendingText); assert.equal(state().current!.input.hasUnappliedInput,false);
    await menu(); assert.equal(await ui('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("切换目录内 HTML"))?.disabled'),true);
    key(window.webContents,'o',['control']); await delay(100); assert.equal(fileCalls,0); assert.equal(entryCalls,beforeGate+1);
    key(window.webContents,'Escape'); gateControl.release!(secondPath); entryGate=null;
    await until(()=>state().phase==='idle','floating departure cancelled'); await idle();
    assert.equal(runtime.workspace.current,first); assert.equal(desk().panel,'floating'); assert.deepEqual(floating.getBounds(),floatingBounds);
    assert.equal(await floating.webContents.executeJavaScript('document.querySelector("textarea.draft-input")?.value'),pendingText);
    assert.equal(rootCalls,4); await filesUnchanged();
    pass('floating pending input drains before one chooser; repeated actions are blocked and cancellation retains its window and draft');

    leaveDecision='save-copy'; entryChoice=secondPath;
    for(const destination of [undefined,occupiedCopy]) {
      copyChoice=destination; const before=copyCalls; await switchEntry();
      await until(()=>copyCalls===before+1&&state().phase==='idle','copy departure cancelled/failed'); await idle();
      assert.equal(runtime.workspace.current,first); assert.equal(state().current!.input.input!.appliedText,pendingText);
      assert.equal(await readFile(occupiedCopy,'utf8'),'existing destination'); await filesUnchanged();
    }
    copyChoice=copyPath; await switchEntry(); await until(()=>state().current?.id!==firstId&&state().phase==='idle','copy then authorized switch'); await idle();
    const next=runtime.workspace.current!; assert.equal(next.preview.grant.root,root); assert.deepEqual(next.preview.grant.rootIdentity,grantIdentity);
    assert.equal(state().current!.project.entry,'附录/入口.html'); assert.equal(state().current!.input.changes.length,0);
    assert.equal(state().current!.input.input,null); assert.equal(state().current!.input.history!.undoCount,0); assert.equal(desk().reviewed.length,0);
    await until(()=>first.preview.contents.isDestroyed(),'old entry mapping retired');
    assert.equal(desk().panel,'floating'); assert.equal(desktop.ownedWindows().includes(floating),true);
    assert.deepEqual(await readFile(copyPath),Buffer.from(original.toString('utf8').replace('报告 &amp; 😀',pendingText)));
    assert.equal(await next.preview.contents.executeJavaScript('document.querySelector("h1").textContent'),'附录 🧪'); await filesUnchanged();
    pass('cancelled or failed copy prevents departure; a verified new copy permits the next entry with one root and fresh input/history/review');

    await until(()=>(runtime.host.current?.getBounds().width??0)>0,'second entry displayed'); await select(next.preview.contents);
    await typeText(floating,'附录的临时修改'); await settled('附录的临时修改');
    window.setContentSize(960,640); await until(()=>ui('matchMedia("(max-width:1023px)").matches'),'narrow product layout');
    await menu(); await delay(200); await writeFile(join(results,'product-entry-menu.png'),await captureReady(window.webContents));
    const entryButton=await ui('(() => {const e=[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("切换目录内 HTML"));if(!e||e.disabled)return false;e.focus();return document.activeElement===e;})()');
    assert.equal(entryButton,true); entryChoice=firstPath; leaveDecision='discard'; key(window.webContents,'Enter');
    await until(()=>state().current?.id!==next.id&&state().phase==='idle','keyboard narrow entry switch'); await idle();
    assert.equal(state().current!.project.entry,'报告/入口.html'); assert.deepEqual(runtime.workspace.current!.preview.grant.rootIdentity,grantIdentity);
    assert.equal(state().current!.input.changes.length,0); assert.equal(state().current!.input.history!.undoCount,0); assert.equal(desk().reviewed.length,0);
    assert.equal(await runtime.workspace.current!.preview.contents.executeJavaScript('document.querySelector("h1").textContent'),'报告 & 😀');
    assert.equal(rootCalls,4); assert.ok(chooserRoots.every(value=>value===root)); await filesUnchanged(); assert.deepEqual(errors,[]);
    pass('narrow-window keyboard entry switching honors explicit discard and retains the original directory identity and every source/resource byte');

    await writeFile(join(results,'product-entry.json'),JSON.stringify({status:'passed',passed,
      commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
      dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
      platform:{os:type(),release:release(),arch:arch()},versions:process.versions,
      hashes:{first:hash(original),second:hash(second),css:hash(css),copy:hash(await readFile(copyPath))},
      pending:['real OS IME and native choosers','maintainer report','Windows 10 / DPI / Mac']},null,2));
  } finally {
    gateControl.release?.(undefined); entryGate=null; await runtime.dispose(); if(!window.isDestroyed())window.destroy();
  }
}
void run().then(()=>app.quit()).catch(async(error:unknown)=>{
  console.error(error);
  await writeFile(join(results,'product-entry.json'),JSON.stringify({status:'failed',passed,error:String(error),stack:error instanceof Error?error.stack:null},null,2));
  app.exit(1);
});
