import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import type { WorkspaceResult } from '../../src/contracts/workspace-editor.ts';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { proofreadDocument, proofreadSnapshot } from '../helpers/proofread.ts';
import { captureReady } from '../helpers/capture.ts';

const outputRoot = resolve(__dirname, '..'), results = resolve(outputRoot, '../test-results');
registerSchemes(); app.enableSandbox(); app.on('window-all-closed', () => {});
app.setPath('userData', join(results, 'product-mode-profile-' + randomUUID()));
const passed: string[] = [];
const pass = (label: string) => { passed.push(label); console.log('PASS: ' + label); };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error('TIMEOUT: ' + label); await delay(25); }
}
async function click(window: BrowserWindow, selector: string, label = ''): Promise<void> {
  const point = await window.webContents.executeJavaScript('(() => {const e=[...document.querySelectorAll('
    + JSON.stringify(selector) + ')].find(e=>e.getBoundingClientRect().width>0&&!e.disabled&&e.textContent.includes('
    + JSON.stringify(label) + '));if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
  assert.ok(point, 'enabled product control: ' + selector + ' ' + label);
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  window.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
}
function key(contents: WebContents, keyCode: string, modifiers: ('control' | 'shift')[] = []): void {
  contents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  if(keyCode==='Enter'&&!modifiers.length)contents.sendInputEvent({type:'char',keyCode:'\r'});
  contents.sendInputEvent({type:'keyUp',keyCode,modifiers});
}
async function select(contents: WebContents): Promise<void> {
  const point = await contents.executeJavaScript('(() => {const e=document.querySelector("h1"),r=document.createRange();r.setStart(e.firstChild,0);r.setEnd(e.firstChild,1);const b=r.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()');
  contents.focus(); contents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  contents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
}
async function typeText(window: BrowserWindow, value: string): Promise<void> {
  await until(()=>window.webContents.executeJavaScript('!!document.querySelector("textarea.draft-input:not(:disabled)")'),'real input owner');
  await window.webContents.executeJavaScript('(() => {const e=document.querySelector("textarea.draft-input");e.focus();e.select();})()');
  window.focus(); window.webContents.focus();
  if(value==='')key(window.webContents,'Backspace'); else await window.webContents.insertText(value);
}
const original = Buffer.from('\ufeff<!doctype html>\r\n<html lang="zh-CN"><head><meta charset="utf-8"><title>模式验证</title>'
  + '<link rel="stylesheet" href="../assets/keep.css"><script defer src="../assets/behavior.js"></script></head>'
  + '<body><h1>原文 &amp; 😀</h1><p id="keep">未改正文</p><button id="dynamic">运行页面交互</button><!-- 保留原样 --></body></html>\r\n');
const css = Buffer.from('body{font:20px sans-serif;padding:24px;color:rgb(12,34,56)}button{font:inherit;padding:10px}');
async function run(): Promise<void> {
  await mkdir(results,{recursive:true}); await app.whenReady();
  let networkHits = 0;
  const server = createServer((_request,response)=>{networkHits++;response.end('must stay blocked');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const port=(server.address() as AddressInfo).port;
  const js=Buffer.from('document.documentElement.dataset.scriptRan="yes";'
    + 'document.querySelector("#dynamic").onclick=()=>{document.querySelector("h1").textContent="脚本生成的文字";};'
    + 'fetch("http://127.0.0.1:'+port+'/blocked").catch(()=>{document.documentElement.dataset.networkBlocked="yes";});');
  const root=await mkdtemp(join(results,'mode-document-')), project=join(root,'项目 🧪'), pages=join(project,'pages');
  await mkdir(pages,{recursive:true}); await mkdir(join(project,'assets'));
  const entry=join(pages,'报告.html'), copy=join(pages,'草稿副本.html'), occupied=join(pages,'已有副本.html');
  await writeFile(entry,original); await writeFile(join(project,'assets/keep.css'),css);
  await writeFile(join(project,'assets/behavior.js'),js); await writeFile(occupied,'existing copy');
  let decision='cancel', copyChoice: string | undefined, reviewCalls=0;
  let heldReview: Promise<void> | null = null;
  const reviewGate: {release?:()=>void} = {};
  let product: Awaited<ReturnType<typeof createProductApplication>> | undefined;
  try {
    product=await createProductApplication(outputRoot,{visible:false,bindQuit:false,choices:{
      open:async()=>entry,project:{chooseDirectory:async()=>project,chooseEntry:async()=>entry},
      copy:async()=>copyChoice,review:async value=>{reviewCalls++;await heldReview;return{reviewId:value.reviewId,decision};},
    }});
    const {window,runtime,desktop}=product;
    const state=()=>runtime.workspace.snapshot();
    const editing=()=>proofreadSnapshot(state());
    const document=()=>proofreadDocument(runtime.workspace.current);
    const desk=()=>desktop.extension(window.webContents).snapshot();
    const ui=(script:string)=>window.webContents.executeJavaScript(script);
    const call=(script:string):Promise<WorkspaceResult>=>ui(script);
    const errors:string[]=[];
    window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
    const sourceUnchanged=async(expected=original)=>{
      assert.deepEqual(await readFile(entry),expected); assert.deepEqual(await readFile(join(project,'assets/keep.css')),css);
      assert.deepEqual(await readFile(join(project,'assets/behavior.js')),js); assert.equal(networkHits,0);
    };
    const menu=async()=>{
      await click(window,'.toolbar button[aria-label="更多操作"]');
      await until(()=>ui('!!document.querySelector("[role=menu]")'),'menu');
      await until(async()=>{
        const rect=await ui('(() => {const r=document.querySelector("[role=menu]").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()');
        const native=runtime.host.current?.getBounds();
        return !(native&&native.width>0&&native.height>0&&native.x<rect.x+rect.width&&native.x+native.width>rect.x
          &&native.y<rect.y+rect.height&&native.y+native.height>rect.y);
      },'menu clear of native Preview',3000);
    };
    const switchMode=async()=>{
      const label=state().current?.mode==='interactive'?'返回静态校稿':'切换为脚本只读预览';
      await menu(); await click(window,'[role=menuitem]',label);
    };
    const modeReady=async(mode:'proofread'|'interactive')=>{
      await until(()=>state().current?.mode===mode&&state().phase==='idle'&&(runtime.host.current?.getBounds().width??0)>0,'mode '+mode);
    };
    const settled=async(value:string)=>{
      await until(()=>{const input=state().current?.input;return input?.input?.appliedText===value&&!input.hasUnappliedInput&&input.phase==='idle';},'live draft '+value);
    };
    const durable=async()=>{
      await until(()=>{const current=state().current, input=current?.input, saved=current?.persistence;
        if(saved?.status==='failed'||saved?.status==='unknown') throw new Error('durable point failed: '+JSON.stringify(saved));
        return !!input&&saved?.status==='persisted'&&saved.persisted?.draftRevision===input.draftRevision&&saved.persisted.resultHash===input.candidateHash;},'latest durable point');
    };
    window.showInactive(); await until(()=>ui('!!document.querySelector(".app")'),'product UI');
    await click(window,'.toolbar button','打开目录'); await modeReady('proofread');
    const first=document(), rootIdentity=first.preview.grant.rootIdentity;
    const originalHash=editing().current!.input.candidateHash;
    assert.equal(await first.preview.contents.executeJavaScript('typeof document.documentElement.dataset.scriptRan'),'undefined');
    await switchMode(); await modeReady('interactive');
    const readonly=runtime.workspace.current!;
    assert.equal(readonly.input,null); assert.equal(readonly.writer,null); assert.equal(readonly.mapping,null);
    assert.equal(state().current!.input,null); assert.equal(state().current!.persistence,null); assert.equal(state().canSave,false);
    assert.equal(first.preview.contents.isDestroyed(),true); assert.notEqual(readonly.id,first.id);
    assert.deepEqual(readonly.preview.grant.rootIdentity,rootIdentity);
    assert.notEqual(readonly.preview.session,window.webContents.session);
    await until(()=>readonly.preview.contents.executeJavaScript('document.documentElement.dataset.networkBlocked==="yes"'),'offline script fetch rejected');
    assert.deepEqual(await readonly.preview.contents.executeJavaScript('({ran:document.documentElement.dataset.scriptRan,require:typeof require,process:typeof process,workspace:typeof haeWorkspace,desktop:typeof haeDesktop,color:getComputedStyle(document.body).color})'),
      {ran:'yes',require:'undefined',process:'undefined',workspace:'undefined',desktop:'undefined',color:'rgb(12, 34, 56)'});
    const point=await readonly.preview.contents.executeJavaScript('(() => {const r=document.querySelector("#dynamic").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    readonly.preview.contents.focus();readonly.preview.contents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
    readonly.preview.contents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
    await until(()=>readonly.preview.contents.executeJavaScript('document.querySelector("h1").textContent==="脚本生成的文字"'),'local JS interaction');
    const id=JSON.stringify(readonly.id), rev=state().stateRevision, digest=JSON.stringify(originalHash);
    for(const expression of [
      'haeWorkspace.save('+id+','+rev+')',
      'haeWorkspace.readDiff('+id+',1,'+digest+')',
      'haeWorkspace.retryPersistence('+id+',1)',
      'haeWorkspace.edit('+id+',{kind:"history",value:{stateRevision:1,draftRevision:1,direction:"undo"}})',
      'haeWorkspace.edit('+id+',{kind:"save-copy",stateRevision:1})',
      'haeWorkspace.restoreBackup('+id+','+rev+','+JSON.stringify({transactionId:randomUUID(),intentHash:'a'.repeat(64)})+')',
      'haeDesktop.request({kind:"review",documentId:'+id+',draftRevision:1,candidateHash:'+digest+',nodeIds:[]})',
      'haeDesktop.request({kind:"pdf-create",documentId:'+id+',draftRevision:1,candidateHash:'+digest+',options:{paper:"A4",landscape:false,background:true}})',
    ])assert.equal((await call(expression)).code,'READ_ONLY_MODE',expression);
    assert.ok((await ui('document.querySelector(".statusbar").textContent')).includes('脚本只读'));
    assert.equal(await ui('document.querySelector("textarea.draft-input")!==null'),false);
    await sourceUnchanged();
    await switchMode(); await modeReady('proofread');
    assert.equal(readonly.preview.contents.isDestroyed(),true);
    assert.equal(await document().preview.contents.executeJavaScript('document.querySelector("h1").textContent'),'原文 & 😀');
    assert.equal(await document().preview.contents.executeJavaScript('typeof document.documentElement.dataset.scriptRan'),'undefined');
    assert.equal(editing().current!.input.draftRevision,1);
    assert.equal(editing().current!.persistence!.status,'idle','untouched history must not halt the first edit checkpoint');
    pass('same-root product mode switching runs only offline local JS; readonly has no edit/write/PDF authority and dynamic DOM never returns as source');

    await select(document().preview.contents); await typeText(window,'保留 Redo 的草稿'); await settled('保留 Redo 的草稿');
    await click(window,'.toolbar button[aria-label^="撤销"]'); await until(()=>editing().current!.input.changes.length===0,'Undo to baseline'); await durable();
    assert.equal(editing().current!.input.history!.redoCount,1);
    await switchMode(); await modeReady('interactive'); await switchMode(); await modeReady('proofread');
    assert.equal(editing().current!.input.history!.redoCount,1); assert.equal(editing().current!.input.input,null);
    await click(window,'.toolbar button[aria-label^="重做"]'); await until(()=>editing().current!.input.changes.length===1,'Redo after roundtrip'); await durable();
    assert.equal(await document().preview.contents.executeJavaScript('document.querySelector("h1").textContent'),'保留 Redo 的草稿'); await sourceUnchanged();
    pass('a verified clean return-to-baseline checkpoint preserves logical Redo across fresh readonly and static documents');

    await select(document().preview.contents); await typeText(window,'浮窗前的草稿'); await settled('浮窗前的草稿');
    await ui('document.querySelector("textarea.draft-input").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:""}))');
    await until(()=>editing().current!.input.input?.composing===true,'composition reaches Main');
    await menu(); assert.equal(await ui('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("切换为脚本只读"))?.disabled'),true);
    const reviewsBefore=reviewCalls; key(window.webContents,'Escape'); await delay(80); assert.equal(reviewCalls,reviewsBefore);
    await ui('(() => {const e=document.querySelector("textarea.draft-input");e.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:e.value}));})()');
    await until(()=>editing().current!.input.input?.composing===false,'explicit composition end'); key(window.webContents,'Escape');
    await click(window,'.toolbar button[aria-label="在独立窗口中校稿"]');
    await until(()=>desk().panel==='floating','floating owner');
    const floating=desktop.ownedWindows().find(value=>!value.getTitle().includes('PDF'))!;
    const floatingBounds=floating.getBounds();
    await typeText(floating,'浮窗等待投递的文字'); heldReview=new Promise(done=>{reviewGate.release=done;});
    const beforeReview=reviewCalls, retained=document(); await switchMode();
    await until(()=>reviewCalls===beforeReview+1,'held mode review');
    assert.equal(editing().current!.input.input!.appliedText,'浮窗等待投递的文字');
    await menu(); assert.equal(await ui('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("正在切换模式"))?.disabled'),true);
    key(window.webContents,'Escape');key(window.webContents,'o',['control']);await delay(80);assert.equal(reviewCalls,beforeReview+1);
    reviewGate.release!();heldReview=null;
    await until(()=>state().phase==='idle','cancelled mode review');assert.equal(runtime.workspace.current,retained);
    assert.deepEqual(floating.getBounds(),floatingBounds);
    assert.equal(await floating.webContents.executeJavaScript('document.querySelector("textarea.draft-input").value'),'浮窗等待投递的文字');
    await sourceUnchanged();
    pass('composition blocks mode changes; floating pending input drains before one review and cancellation retains the exact window and draft');

    decision='save-copy';
    for(const destination of [undefined,occupied]) {
      copyChoice=destination;const before=reviewCalls;await switchMode();
      await until(()=>reviewCalls===before+1&&state().phase==='idle','cancelled or failed copy');
      assert.equal(runtime.workspace.current,retained);assert.equal(await readFile(occupied,'utf8'),'existing copy');await sourceUnchanged();
    }
    copyChoice=copy;await switchMode();await modeReady('interactive');
    assert.deepEqual(await readFile(copy),Buffer.from(original.toString('utf8').replace('原文 &amp; 😀','浮窗等待投递的文字')));
    assert.equal(desk().panel,'floating');assert.equal(desktop.ownedWindows().includes(floating),true);
    assert.equal(await floating.webContents.executeJavaScript('document.querySelector("textarea.draft-input")!==null'),false);
    window.setContentSize(960,640);await until(()=>ui('matchMedia("(max-width:1023px)").matches'),'narrow layout');
    await menu();await writeFile(join(results,'product-mode-menu.png'),await captureReady(window.webContents));
    await ui('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("返回静态校稿")).focus()');
    key(window.webContents,'Enter');await modeReady('proofread');
    assert.equal(editing().current!.input.history!.undoCount,0);assert.equal(editing().current!.input.changes.length,0);
    assert.deepEqual(document().preview.grant.rootIdentity,rootIdentity);await sourceUnchanged();
    await select(document().preview.contents);await typeText(floating,'将明确放弃的文字');await settled('将明确放弃的文字');
    decision='discard';await switchMode();await modeReady('interactive');await switchMode();await modeReady('proofread');
    assert.equal(editing().current!.input.history!.undoCount,0);await sourceUnchanged();
    pass('copy cancellation/failure keeps the draft; a verified copy or explicit discard permits switching without replaying abandoned history, including narrow keyboard return');

    window.setContentSize(1440,900);await until(()=>ui('!matchMedia("(max-width:1023px)").matches'),'wide layout');
    await select(document().preview.contents);await typeText(floating,'');await settled('');
    await click(floating,'.check-all input');await until(()=>desk().reviewed.length===1,'review empty Text');
    await click(window,'.toolbar button.primary');await until(()=>ui('!!document.querySelector("[role=dialog] .dlg-actions button.primary:not(:disabled)")'),'fresh source Diff');
    await click(window,'[role=dialog] .dlg-actions button.primary');
    await until(()=>state().lastSave?.status==='saved'&&state().phase==='idle','reviewed empty Text Save');await durable();
    const savedEmpty=Buffer.from(original.toString('utf8').replace('原文 &amp; 😀',''));await sourceUnchanged(savedEmpty);
    await switchMode();await modeReady('interactive');await switchMode();await modeReady('proofread');
    assert.equal(await document().preview.contents.executeJavaScript('document.querySelector("h1").textContent'),'');
    assert.ok(editing().current!.input.history!.canUndo);
    await click(window,'.toolbar button[aria-label^="撤销"]');
    await until(()=>editing().current!.input.changes.length===1,'Undo of saved empty Text');
    assert.equal(await document().preview.contents.executeJavaScript('document.querySelector("h1").textContent'),'原文 & 😀');await sourceUnchanged(savedEmpty);
    await click(window,'.toolbar button[aria-label^="重做"]');await until(()=>editing().current!.input.changes.length===0,'Redo to saved point');await durable();
    await switchMode();await modeReady('interactive');
    pass('reviewed native Save of an empty Text survives a mode roundtrip with fresh lineage; subsequent Undo/Redo changes drafts only');

    const beforeConflict=runtime.workspace.current!, external=Buffer.concat([savedEmpty,Buffer.from('<!-- external version -->')]);
    await writeFile(entry,external);await switchMode();
    await until(async()=>state().phase==='idle'&&(await ui('document.body.textContent')).includes('文件已被其他程序修改'),'readonly version conflict');
    assert.equal(runtime.workspace.current,beforeConflict);assert.equal(state().current!.mode,'interactive');await sourceUnchanged(external);
    await click(window,'.toolbar button','打开目录');await modeReady('proofread');
    assert.equal(editing().current!.input.history!.undoCount,0);assert.equal(editing().current!.input.history!.redoCount,0);
    await switchMode();await modeReady('interactive');
    window.close();await until(()=>window.isDestroyed(),'readonly native close with floating owner');
    assert.deepEqual(errors,[]);await sourceUnchanged(external);
    pass('external change in readonly blocks old-history migration; explicit reopen accepts a fresh baseline and native close drains the null-input floating session');

    await writeFile(join(results,'product-mode.json'),JSON.stringify({status:'passed',passed,
      commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),
      platform:{release:release(),arch:arch()},versions:process.versions,networkHits,
      hashes:{original:hash(original),savedEmpty:hash(savedEmpty),external:hash(external),css:hash(css),js:hash(js)},
      pending:['real OS IME and native chooser interaction','maintainer report','Windows 10 / DPI / Mac']},null,2));
  } finally {
    reviewGate.release?.();heldReview=null;
    if(product){await product.runtime.dispose();if(!product.window.isDestroyed())product.window.destroy();}
    await new Promise<void>(done=>server.close(()=>done()));
  }
}
void run().then(()=>app.quit()).catch(async(error:unknown)=>{
  console.error(error);await writeFile(join(results,'product-mode.json'),JSON.stringify({status:'failed',passed,error:String(error),stack:error instanceof Error?error.stack:null},null,2));
  app.exit(1);
});
