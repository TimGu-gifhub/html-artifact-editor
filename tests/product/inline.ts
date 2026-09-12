import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, ipcMain } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { proofreadDocument } from '../helpers/proofread.ts';
import { captureReady } from '../helpers/capture.ts';

const outputRoot = resolve(__dirname, '..'), results = resolve(outputRoot, '../test-results');
registerSchemes(); app.enableSandbox(); app.on('window-all-closed', () => {});
app.setPath('userData', join(results, 'product-inline-profile-' + randomUUID()));
const passed: string[] = [];
const pass = (label: string) => { passed.push(label); console.log('PASS: ' + label); };
const hiddenOriginal = Buffer.from('\ufeff<!doctype html>\r\n<html lang="zh-CN"><head><meta charset="utf-8"><title>就地校稿</title>'
  + '<style>body{font:20px sans-serif;padding:24px;margin:0}button{font:inherit;padding:8px}section{padding:16px;border:1px solid #ddd}'
  + '.spacer{height:640px}pre{white-space:pre-wrap}.active{background:#222;color:white}</style></head><body><h1>交互报告</h1><div class="spacer"></div>'
  + '<div role="tablist"><button role="tab" data-tab="swift" class="active">SwiftUI</button>'
  + '<button role="tab" data-tab="uikit">UIKit</button><button role="tab" data-tab="css">Web / CSS</button></div>'
  + '<section id="code-swift"><p>默认内容</p></section><!-- 保留注释 -->\r\n'
  + '<section id="code-uikit" hidden=""><pre>class Example: <span id="target">UIViewController &amp; 😀</span> {\n  // 原始代码\n}</pre></section>'
  + '<section id="code-css" hidden><p>第三页正文</p></section><div class="spacer"></div>'
  + '<script>globalThis.tabRuns=0;for(const b of document.querySelectorAll("[role=tab]")){b.onclick=()=>{tabRuns++;'
  + 'for(const p of document.querySelectorAll("section"))p.hidden=p.id!=="code-"+b.dataset.tab;'
  + 'for(const t of document.querySelectorAll("[role=tab]"))t.classList.toggle("active",t===b);};}</script></body></html>\r\n');

const cssOnly = process.argv.includes('--css-tabs');
const original = cssOnly ? Buffer.from(hiddenOriginal.toString('utf8')
  .replaceAll('[role=tab]', '[data-tab]').replaceAll(' role="tablist"', '').replaceAll(' role="tab"', '')
  .replace('id="code-uikit" hidden=""', 'id="code-uikit" class="off"').replace('id="code-css" hidden', 'id="code-css" class="off"')
  .replace('p.hidden=p.id!=="code-"+b.dataset.tab;', 'p.classList.toggle("off",p.id!=="code-"+b.dataset.tab);')
  .replace('.spacer{height:640px}', '.off{display:none}.spacer{height:640px}')) : hiddenOriginal;
const reportName = cssOnly ? 'product-inline-css.json' : 'product-inline.json';

const newText = 'UIViewController 已校对 <&> 🧪';
// Independent byte oracle. No serializer or implementation patch routine.
const expected = Buffer.from(original.toString('utf8').replace('UIViewController &amp; 😀', 'UIViewController 已校对 &lt;&amp;&gt; 🧪'));
async function until(check: () => boolean | Promise<boolean>, label: string, timeout=15000) {
  const end=Date.now()+timeout;
  while(!await check()) { if(Date.now()>end)throw Error('TIMEOUT: '+label); await delay(25); }
}
async function click(window: BrowserWindow, selector: string, label='') {
  let point: {x:number;y:number}|null=null;
  await until(async()=>{
    point=await window.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>!e.disabled&&e.getBoundingClientRect().width&&e.textContent.includes(${JSON.stringify(label)}));if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    return !!point;
  },'enabled '+selector+' '+label);
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({type:'mouseDown',...point!,button:'left',clickCount:1});
  window.webContents.sendInputEvent({type:'mouseUp',...point!,button:'left',clickCount:1});
}
async function textPoint(contents: WebContents, select=false) {
  const point=await contents.executeJavaScript('(()=>{const n=document.querySelector("#target").firstChild,r=document.createRange();r.setStart(n,5);r.setEnd(n,6);const b=r.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()');
  contents.focus();
  await until(()=>contents.executeJavaScript('document.hasFocus()'),'native Preview focus');
  contents.sendInputEvent({type:'mouseEnter',...point});
  contents.sendInputEvent({type:'mouseMove',x:point.x+2,y:point.y});
  await delay(30);
  contents.sendInputEvent({type:'mouseMove',...point});
  if(select) {
    contents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
    contents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
  }
}
const attrs='JSON.stringify([...document.querySelectorAll("*")].map(e=>[e.tagName,[...e.attributes].map(a=>[a.name,a.value])]))';
const panels='[...document.querySelectorAll("section")].map(e=>e.checkVisibility({visibilityProperty:true,opacityProperty:true}))';
async function run() {
  await mkdir(results,{recursive:true}); await app.whenReady();
  const root=await mkdtemp(join(results,'inline-document-')),entry=join(root,'交互报告.html');
  await writeFile(entry,original);
  const product=await createProductApplication(outputRoot,{visible:false,bindQuit:false,initialPanel:'inline',choices:{open:async()=>entry}});
  const {window,runtime,desktop}=product;
  const geometryLog: unknown[]=[];
  ipcMain.on('hae:text-geometry',(_event,value)=>{geometryLog.push(value);if(geometryLog.length>8)geometryLog.shift();});
  const state=()=>runtime.workspace.snapshot(), doc=()=>proofreadDocument(runtime.workspace.current);
  const desk=()=>desktop.extension(window.webContents).snapshot();
  const ui=(code:string)=>window.webContents.executeJavaScript(code);
  try {
    // Keep this short native geometry fixture unoccluded by the test runner.
    // Chromium legitimately freezes hidden/occluded viewport metrics.
    window.setAlwaysOnTop(true); window.show(); window.setContentSize(1440,900);
    // Windows hidden-process startup can consume the first ShowWindow call.
    // Verify actual visibility instead of weakening production geometry checks.
    await until(()=>{if(!window.isVisible())window.show();return window.isVisible();},'visible native Main');
    await until(()=>ui('!!document.querySelector(".app")'),'UI');
    await click(window,'.toolbar button','打开 HTML');
    await until(()=>!!state().current&&(runtime.host.current?.getBounds().width??0)>100,'open');
    const sourceAttrs=await doc().preview.contents.executeJavaScript(attrs);
    assert.equal(await ui('[...document.querySelectorAll(".mode-switch button")].filter(e=>e.getAttribute("aria-pressed")==="true").length'),1);
    await click(window,'.toolbar button','只读预览');
    await until(()=>state().current?.mode==='interactive'&&state().phase==='idle','browse');
    const interactive=runtime.workspace.current!;
    assert.equal(state().current?.input,null);
    await interactive.preview.contents.executeJavaScript('document.querySelector("[data-tab=uikit]").scrollIntoView({block:"center",behavior:"instant"})');
    const tabPoint=await interactive.preview.contents.executeJavaScript('(()=>{const r=document.querySelector("[data-tab=uikit]").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    interactive.preview.contents.focus();
    interactive.preview.contents.sendInputEvent({type:'mouseDown',...tabPoint,button:'left',clickCount:1});
    interactive.preview.contents.sendInputEvent({type:'mouseUp',...tabPoint,button:'left',clickCount:1});
    await until(async()=>JSON.stringify(await interactive.preview.contents.executeJavaScript(panels))==='[false,true,false]','native tab navigation');
    await interactive.preview.contents.executeJavaScript('document.querySelector("#code-uikit").scrollIntoView({block:"center",behavior:"instant"})');
    assert.deepEqual(await interactive.preview.contents.executeJavaScript(panels),[false,true,false]);
    const top=await interactive.preview.contents.executeJavaScript('document.querySelector("#code-uikit").getBoundingClientRect().top');
    await click(window,'.toolbar button','编辑文字');
    await until(()=>state().current?.mode==='proofread'&&state().phase==='idle','edit');
    const first=doc(),preview=first.preview.contents;
    assert.notEqual(first.id,interactive.id);
    assert.deepEqual(await preview.executeJavaScript(panels),[false,true,false]);
    assert.equal(await preview.executeJavaScript('typeof tabRuns'),'undefined');
    assert.equal(await preview.executeJavaScript(attrs),sourceAttrs);
    assert.equal(desk().presentation?.panels,1); assert.equal(desk().presentation?.status,'restored');
    assert.ok(Math.abs(await preview.executeJavaScript('document.querySelector("#code-uikit").getBoundingClientRect().top')-top)<5);
    if(!cssOnly) assert.match(await preview.executeJavaScript('getComputedStyle(document.querySelector("[data-tab=uikit]")).textDecorationLine'),/underline/);
    assert.deepEqual(await readFile(entry),original);
    pass('browse second tab then edit preserves verified source panel and scroll; fresh mapping, stopped scripts, unchanged attributes and bytes');

    window.focus();
    try { await until(async()=>{
      const size=await preview.executeJavaScript('({width:innerWidth,height:innerHeight})');
      return size.width===desktop.bounds().width&&size.height===desktop.bounds().height;
    },'installed Preview viewport'); }
    catch(error) { console.log(JSON.stringify({bounds:desktop.bounds(),view:first.preview.view.getBounds(),host:runtime.host.current?.getBounds(),viewport:await preview.executeJavaScript('({width:innerWidth,height:innerHeight,visibility:document.visibilityState})')}));throw error; }
    await textPoint(preview,true);
    await until(()=>!!first.input.snapshot().input,'direct Text click');
    let decoration: BrowserWindow|undefined;
    try { await until(()=>{decoration=desktop.ownedWindows().find(w=>!w.isFocusable());return !!decoration?.isVisible();},'selected decoration'); }
    catch(error) { console.log(JSON.stringify({geometryLog,bounds:desktop.bounds(),view:first.preview.view.getBounds(),host:runtime.host.current?.getBounds(),viewport:await preview.executeJavaScript('({width:innerWidth,height:innerHeight,visibility:document.visibilityState})'),mapping:first.mapping.status,windows:desktop.ownedWindows().map(w=>({url:w.webContents.getURL(),visible:w.isVisible()}))}));throw error; }
    assert.deepEqual(await decoration!.webContents.executeJavaScript('[typeof haeDecoration,typeof haeWorkspace,typeof haeDesktop,typeof haeEditor]'),['object','undefined','undefined','undefined']);
    assert.equal(await decoration!.webContents.executeJavaScript('document.querySelectorAll("button,input,textarea").length'),0);
    const ink=()=>decoration!.webContents.executeJavaScript('(()=>{const c=document.querySelector("canvas"),d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n;})()');
    await until(async()=>await ink()>5,'canvas draws hover');
    await until(()=>!!first.input.snapshot().input,'Text selected');
    const targetId=first.input.snapshot().input!.nodeId;
    assert.equal(desk().panel,'inline');
    assert.equal(await ui('document.querySelectorAll(".side-panel").length'),0);
    const editor=desktop.ownedWindows().find(w=>w.isFocusable())!;
    await until(()=>editor.webContents.executeJavaScript('!!document.querySelector("textarea.inline-text-input:not(:disabled)")'),'input owner');
    await until(()=>editor.webContents.executeJavaScript('document.activeElement?.classList.contains("inline-text-input")===true'),'automatic inline focus');
    await until(()=>editor.isVisible()&&!!desk().inline,'inline visible');
    const position=desk().inline!, outer=window.getContentBounds(), layout=desktop.bounds(), actual=editor.getBounds();
    assert.ok(Math.abs(actual.x+2-outer.x-layout.x-position.rect.x)<2);
    assert.ok(Math.abs(actual.y+2-outer.y-layout.y-position.rect.y)<2);
    assert.ok(Math.abs(actual.width-position.rect.width-5)<2);
    const inputStyle=await editor.webContents.executeJavaScript('(()=>{const e=document.querySelector("textarea"),s=getComputedStyle(e),r=e.getBoundingClientRect();return{font:s.fontFamily,size:parseFloat(s.fontSize),width:r.width,height:r.height}})()');
    assert.equal(inputStyle.font,position.style.fontFamily); assert.equal(inputStyle.size,position.style.fontSize);
    assert.ok(Math.abs(inputStyle.width-(actual.width-4))<2,'textarea fills proved native width');
    assert.equal(await editor.webContents.executeJavaScript('document.querySelectorAll(".toolbar").length'),0);
    assert.equal(await editor.webContents.executeJavaScript('document.querySelectorAll(".changes-panel").length'),0);
    assert.equal(await preview.executeJavaScript(attrs),sourceAttrs);
    const caret=await editor.webContents.executeJavaScript('document.querySelector("textarea").selectionStart');assert.ok(caret>=5&&caret<=6,'clicked source caret');
    pass('exact Text selection draws in a receive-only native canvas; inline window owns input without modifying the page DOM');

    await editor.webContents.executeJavaScript('document.querySelector("textarea").focus();document.querySelector("textarea").select()');
    editor.focus(); editor.webContents.focus(); await editor.webContents.insertText(newText);
    await until(()=>first.input.snapshot().input?.appliedText===newText&&!first.input.snapshot().hasUnappliedInput,'live inline edit');
    assert.equal(first.input.snapshot().input?.nodeId,targetId);
    assert.equal(await preview.executeJavaScript('document.querySelector("#target").textContent'),newText);
    assert.deepEqual(first.draft.candidate.bytes,new Uint8Array(expected)); assert.deepEqual(await readFile(entry),original);
    await until(()=>editor.webContents.executeJavaScript('!!document.querySelector("textarea:not(:disabled):not([readonly])")'),'UI ready for composition');
    await delay(100);
    await editor.webContents.executeJavaScript('document.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}))');
    await until(()=>first.input.snapshot().input?.composing===true,'composing');
    const composingBounds=editor.getBounds();
    await editor.webContents.executeJavaScript('globalThis.composingElement=document.querySelector("textarea")');
    await preview.executeJavaScript('scrollTo({top:0,behavior:"instant"})'); await delay(180);
    assert.deepEqual(editor.getBounds(),composingBounds,'composition does not move/reflow the input');
    assert.notEqual(desk().inline?.detached,true);
    await click(window,'button[aria-label="更多操作"]');
    await until(()=>ui('document.querySelector(".toast")?.textContent.includes("完成当前输入")'),'composition blocks overlay');
    assert.equal(await ui('!!document.querySelector("[role=menu]")'),false);
    assert.equal(editor.isVisible(),true); assert.equal(first.input.snapshot().input?.composing,true);
    assert.equal(await desktop.beforeClose(),false);
    const blocked=await ui('haeDesktop.request({kind:"panel",mode:"docked"})');
    assert.equal(blocked.ok,false); assert.equal(blocked.code,'INPUT_FLUSH_REQUIRED'); assert.equal(desk().panel,'inline');
    await editor.webContents.executeJavaScript('document.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}))');
    await until(()=>first.input.snapshot().input?.composing===false,'compositionend');
    await until(()=>desk().inline?.detached===true,'geometry deferred until composition end');
    assert.equal(await editor.webContents.executeJavaScript('document.querySelector("textarea")===composingElement'),true);
    assert.equal(await editor.webContents.executeJavaScript('getComputedStyle(document.querySelector(".inline-tag")).display!=="none"'),true);
    await preview.executeJavaScript('document.querySelector("#target").scrollIntoView({block:"center",behavior:"instant"})');
    await until(()=>desk().inline?.detached!==true,'return inline after composing');
    assert.equal(await editor.webContents.executeJavaScript('getComputedStyle(document.querySelector(".inline-tag")).display'),"none");
    pass('inline input previews Unicode and entities live with zero disk writes; composing prevents owner transfer');

    const editText=async(value:string)=>{
      await until(()=>editor.webContents.executeJavaScript('!!document.querySelector("textarea:not(:disabled):not([readonly])")'),'editable input');
      editor.focus();editor.webContents.focus();
      await editor.webContents.executeJavaScript('document.querySelector("textarea").focus();document.querySelector("textarea").select()');
      if(value)await editor.webContents.insertText(value);
      else {editor.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});editor.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'});}
      await until(()=>first.input.snapshot().input?.appliedText===value&&!first.input.snapshot().hasUnappliedInput,'applied '+value);
    };
    await editor.webContents.executeJavaScript('globalThis.sameInput=document.querySelector("textarea")');
    await editText('');
    try {await until(()=>desk().inline?.detached===true,'empty input retained');}
    catch(error){console.log(JSON.stringify({input:first.input.snapshot(),placement:desk().inline,geometryLog,visible:editor.isVisible(),viewport:await preview.executeJavaScript('({width:innerWidth,height:innerHeight,visibility:document.visibilityState})'),bounds:desktop.bounds()}));throw error;}
    assert.equal(await editor.webContents.executeJavaScript('sameInput===document.querySelector("textarea")'),true);
    await editText(newText+'\n后续行'); await editText(newText);
    await until(()=>desk().inline?.detached!==true,'restored empty text geometry');
    editor.focus();editor.webContents.focus();
    await editor.webContents.executeJavaScript('document.querySelector("textarea").focus();document.querySelector("textarea").setSelectionRange(4,4)');
    await editor.webContents.insertText('待取消');
    editor.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});editor.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(()=>editor.webContents.executeJavaScript('document.querySelector("textarea").value==='+JSON.stringify(newText)),'Escape restores pending only');
    await until(()=>first.input.snapshot().input?.text===newText&&!first.input.snapshot().hasUnappliedInput,'Escape drained');
    assert.equal(await preview.executeJavaScript('document.querySelector("#target").textContent'),newText);
    assert.deepEqual(await readFile(entry),original);
    pass('empty and multiline values keep one editable element; Escape cancels pending input without changing HTML');

    await until(async()=>decoration!.isVisible()&&await ink()>5,'selected decoration');
    await writeFile(join(root,'inline-editor.png'),await captureReady(editor.webContents));
    await writeFile(join(root,'workbench.png'),await captureReady(window.webContents));
    await writeFile(join(root,'preview.png'),await captureReady(preview));
    await writeFile(join(root,'decoration.png'),await captureReady(decoration!.webContents));
    for(const zoom of [1.25,1]) {
      preview.setZoomFactor(zoom);
      await preview.executeJavaScript('document.querySelector("#target").scrollIntoView({block:"center",behavior:"instant"})');
      await until(async()=>{
        if(!decoration!.isVisible()||!await ink())return false;
        const rect=await preview.executeJavaScript('(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector("#target").firstChild);const b=r.getClientRects()[0];return{x:b.x,y:b.y,width:b.width,height:b.height};})()');
        const painted=await decoration!.webContents.executeJavaScript('(()=>{const c=document.querySelector("canvas"),d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let x=c.width,y=c.height;for(let i=3;i<d.length;i+=4)if(d[i]){const p=(i-3)/4;x=Math.min(x,p%c.width);y=Math.min(y,Math.floor(p/c.width));}return{x:x/devicePixelRatio,y:y/devicePixelRatio};})()');
        return Math.abs(painted.x-rect.x*zoom)<4&&Math.abs(painted.y-rect.y*zoom)<4;
      },'correct painted geometry at zoom '+zoom);
    }
    await editor.webContents.executeJavaScript('globalThis.retainedTextarea=document.querySelector("textarea");retainedTextarea.setSelectionRange(3,3)');
    const token=first.input.snapshot().input!.editToken;
    await preview.executeJavaScript('scrollTo({top:0,behavior:"instant"})');
    await until(()=>desk().inline?.detached===true&&editor.isVisible(),'offscreen retained input');
    assert.equal(await editor.webContents.executeJavaScript('document.querySelector("textarea")===retainedTextarea'),true);
    assert.equal(await editor.webContents.executeJavaScript('document.querySelector("textarea").selectionStart'),3);
    assert.equal(first.input.snapshot().input!.editToken,token);
    await preview.executeJavaScript('document.querySelector("#target").scrollIntoView({block:"center",behavior:"instant"})');
    await until(()=>desk().inline?.detached!==true,'return in place');
    assert.equal(await editor.webContents.executeJavaScript('document.querySelector("textarea")===retainedTextarea'),true);
    pass('scroll and zoom preserve the exact input element, token and caret; offscreen input stays available');

    try {
      await preview.debugger.sendCommand('Emulation.setEmulatedMedia',{media:'print'});
      assert.deepEqual(await preview.executeJavaScript(panels),[true,false,false]);
    } finally { await preview.debugger.sendCommand('Emulation.setEmulatedMedia',{media:''}); }
    const pdf=await preview.printToPDF({pageSize:'A4',printBackground:true});
    assert.equal(pdf.subarray(0,5).toString(),'%PDF-'); await writeFile(join(root,'print.pdf'),pdf);
    pass('screen-only panel CSS and separate native text decorations stay out of PDF and original print rules');

    await click(window,'.toolbar button','复核变更');
    await until(()=>ui('document.querySelector("[role=dialog]")?.textContent.includes("复核变更")'),'review without side panel');
    await click(window,'.check-all input'); await until(()=>desk().reviewed.length===1,'review');
    await click(window,'[role=dialog] button','复核并保存'); await until(()=>ui('!!document.querySelector(".diff-list")'),'Diff');
    await click(window,'[role=dialog] button','确认保存');
    await until(()=>state().lastSave?.status==='saved'&&state().current?.id!==first.id,'Windows Save');
    assert.deepEqual(await readFile(entry),expected);
    assert.deepEqual(await doc().preview.contents.executeJavaScript(panels),[false,true,false]);
    assert.equal(desk().presentation?.status,'restored');
    pass('review select-all and native Save preserve exact literal bytes and the current tab after fresh mapping');

    await click(window,'.toolbar button','只读预览'); await until(()=>state().current?.mode==='interactive'&&state().phase==='idle','browse again');
    const browsing=runtime.workspace.current!.preview.contents;
    assert.deepEqual(await browsing.executeJavaScript(panels),[false,true,false]);
    // Synthetic events cannot release the seed. A genuine input event can.
    await browsing.executeJavaScript('document.querySelector("[data-tab=css]").click()');
    assert.deepEqual(await browsing.executeJavaScript(panels),[false,true,false]);
    const point=await browsing.executeJavaScript('(()=>{const r=document.querySelector("[data-tab=css]").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    browsing.focus(); browsing.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
    browsing.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
    await until(async()=>JSON.stringify(await browsing.executeJavaScript(panels))==='[false,false,true]','trusted interaction releases seeded panel');
    await browsing.executeJavaScript('document.querySelector("[data-tab=uikit]").click();document.querySelector("#target").textContent="Script generated"');
    pass('editing to browsing seeds the current tab; the first real interaction resumes ordinary page navigation');
    await click(window,'.toolbar button','编辑文字'); await until(()=>state().current?.mode==='proofread'&&state().phase==='idle','fresh static');
    assert.equal(desk().presentation?.status,'partial'); assert.equal(desk().presentation?.panels,0);
    assert.deepEqual(await doc().preview.contents.executeJavaScript(panels),[true,false,false]);
    assert.equal(await doc().preview.contents.executeJavaScript('document.querySelector("#target").textContent'),newText);
    assert.deepEqual(await readFile(entry),expected);
    pass('script-generated subtree fails presentation proof and is never migrated into editable Text or saved source');
    for(const width of [960,1280,1440]) {
      window.setContentSize(width,800);
      await until(()=>ui(`Math.abs(innerWidth-${width})<20`),'width '+width);
      await until(()=>ui('[...document.querySelectorAll(".toolbar button")].every(e=>{const r=e.getBoundingClientRect();return !r.width||(r.x>=0&&r.right<=innerWidth);})'),'toolbar fits '+width);
    }
    pass('all toolbar controls fit 960, 1280 and 1440 widths');
    await writeFile(join(results,reportName),JSON.stringify({status:'passed',passed,sourceHash:createHash('sha256').update(original).digest('hex'),
      savedHash:createHash('sha256').update(expected).digest('hex'),artifacts:root,versions:process.versions,
      pending:['human IME, OS mouse and multi-display DPI','human report proofreading acceptance']},null,2));
  } finally { await runtime.dispose(); if(!window.isDestroyed())window.destroy(); }
}
void run().then(()=>app.exit(0),async(error:unknown)=>{console.error(error);await writeFile(join(results,reportName),JSON.stringify({status:'failed',passed,error:String(error)},null,2));app.exit(1);});
