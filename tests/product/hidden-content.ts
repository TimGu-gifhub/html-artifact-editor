import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { proofreadDocument } from '../helpers/proofread.ts';
import { captureReady } from '../helpers/capture.ts';

const outputRoot = resolve(__dirname, '..'), results = resolve(outputRoot, '../test-results');
registerSchemes(); app.enableSandbox(); app.on('window-all-closed', () => {});
app.setPath('userData', join(results, 'product-hidden-profile-' + randomUUID()));
const passed: string[] = [];
const pass = (label: string) => { passed.push(label); console.log('PASS: ' + label); };
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const original = Buffer.from('\ufeff<!doctype html>\r\n<html lang="zh-CN"><head><meta charset="utf-8"><title>隐藏内容校稿</title>'
  + '<style>body{font:20px sans-serif;padding:24px}button{font:inherit;padding:8px}section{padding:12px;border:1px solid #ddd}'
  + '@media print{#three[hidden]{display:block}}</style></head><body><h1>标签页报告</h1>'
  + '<div role="tablist"><button id="tab-one">第一项</button><button id="tab-two">第二项</button><button id="tab-three">第三项</button></div>'
  + '<section id="one"><p>默认内容</p></section><!-- 必须保留的注释 -->\r\n'
  + '<section id="two" hidden=""><p id="second-text">第二页 &amp; 😀</p></section>'
  + '<section id="three" hidden><p>第三页预置正文</p></section>'
  + '<form hidden id="private-form"><p>表单说明只读</p><input type="hidden" value="unchanged"></form>'
  + '<script>globalThis.tabRuns=0;for(const id of ["one","two","three"]){document.getElementById("tab-"+id).onclick=()=>{'
  + 'globalThis.tabRuns++;for(const panel of ["one","two","three"])document.getElementById(panel).hidden=panel!==id;};}</script>'
  + '</body></html>\r\n');
const newText = '第二页已复核 <&> 🧪';
// Independent full-byte oracle: only this unique literal Text range may change.
const expected = Buffer.from(original.toString('utf8').replace('第二页 &amp; 😀', '第二页已复核 &lt;&amp;&gt; 🧪'));
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error('TIMEOUT: ' + label); await delay(25); }
}
async function click(window: BrowserWindow, selector: string, label = '') {
  let point: {x: number; y: number} | null = null;
  await until(async () => {
    point = await window.webContents.executeJavaScript('(() => {const e=[...document.querySelectorAll(' + JSON.stringify(selector)
      + ')].find(e=>!e.disabled&&e.getBoundingClientRect().width>0&&e.textContent.includes(' + JSON.stringify(label)
      + '));if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    return point !== null;
  }, 'enabled control ' + selector + ' ' + label);
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({type:'mouseDown',...point!,button:'left',clickCount:1});
  window.webContents.sendInputEvent({type:'mouseUp',...point!,button:'left',clickCount:1});
}
async function select(contents: WebContents, selector: string) {
  await contents.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"center",behavior:"instant"})');
  const point = await contents.executeJavaScript('(() => {const e=document.querySelector(' + JSON.stringify(selector)
    + '),r=document.createRange();r.setStart(e.firstChild,0);r.setEnd(e.firstChild,1);const b=r.getBoundingClientRect();'
    + 'return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};})()');
  contents.focus();
  contents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  contents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
}
async function run() {
  await mkdir(results,{recursive:true}); await app.whenReady();
  const root = await mkdtemp(join(results, 'hidden-document-')), entry = join(root,'具有很长文件名的标签页报告与隐藏内容校稿验证（方案 B 与复核状态）.html');
  await writeFile(entry,original);
  let chosen=entry;
  const product = await createProductApplication(outputRoot,{visible:false,bindQuit:false,choices:{open:async()=>chosen}});
  const {window,runtime,desktop} = product;
  const state = () => runtime.workspace.snapshot();
  const document = () => proofreadDocument(runtime.workspace.current);
  const hidden = () => desktop.extension(window.webContents).snapshot().hiddenContent!;
  const ui = (script: string) => window.webContents.executeJavaScript(script);
  const request = (enabled: boolean, id = state().current!.id, revision = state().stateRevision) =>
    ui('haeDesktop.request(' + JSON.stringify({kind:'hidden-content',documentId:id,stateRevision:revision,enabled}) + ')');
  const visible = (contents: WebContents, id: string) => contents.executeJavaScript('document.getElementById(' + JSON.stringify(id) + ').getBoundingClientRect().height>0');
  try {
    window.showInactive();
    await until(() => ui('!!document.querySelector(".app")'), 'React workbench');
    await click(window,'.toolbar button','打开 HTML');
    await until(() => !!state().current && (runtime.host.current?.getBounds().width ?? 0) > 100, 'native preview');
    const first = document(), preview = first.preview.contents;
    assert.equal(hidden().count,2); assert.equal(hidden().enabled,false); assert.equal(hidden().available,true);
    assert.equal(await visible(preview,'two'),false);
    await preview.executeJavaScript('document.getElementById("tab-two").click()');
    assert.equal(await visible(preview,'two'),false);
    assert.equal(await preview.executeJavaScript('typeof tabRuns'),'undefined');
    const attributes = await preview.executeJavaScript('JSON.stringify([...document.querySelectorAll("*")].map(e=>[e.tagName,[...e.attributes].map(a=>[a.name,a.value])]))');
    const revision = first.draft.revision;
    // Same-frame UI actions must share the app's synchronous latch.
    await ui('(()=>{const e=[...document.querySelectorAll(".toolbar button")].find(e=>e.textContent.includes("显示隐藏内容"));e.click();e.click();})()');
    await until(() => hidden().enabled && !hidden().busy, 'expanded'); await delay(50);
    assert.equal(hidden().enabled,true); assert.equal(first.draft.revision,revision);
    assert.equal(await visible(preview,'two'),true); assert.equal(await visible(preview,'three'),true);
    assert.equal(await visible(preview,'private-form'),false);
    assert.equal(first.mapping.status,'ready'); assert.equal(first.draft.candidate.patches.length,0);
    assert.equal(await preview.executeJavaScript('JSON.stringify([...document.querySelectorAll("*")].map(e=>[e.tagName,[...e.attributes].map(a=>[a.name,a.value])]))'),attributes);
    assert.deepEqual(await readFile(entry),original);
    pass('real UI expands two static panels once, retaining source attributes, mapping, history and disabled scripts');

    await select(preview,'#second-text');
    await until(() => ui('!!document.querySelector("textarea.draft-input:not(:disabled)")'),'hidden Text editor');
    await ui('(()=>{const e=document.querySelector("textarea.draft-input");e.focus();e.select();})()');
    window.webContents.focus(); await window.webContents.insertText(newText);
    await until(() => first.input.snapshot().input?.appliedText===newText && !first.input.snapshot().hasUnappliedInput,'live hidden edit');
    assert.equal(await preview.executeJavaScript('document.getElementById("second-text").textContent'),newText);
    assert.deepEqual(first.draft.candidate.bytes,new Uint8Array(expected));
    assert.deepEqual(await readFile(entry),original);
    for (const width of [960,1280,1440]) {
      window.setContentSize(width,800);
      await until(async()=>Math.abs(await ui('innerWidth')-width)<20,'resized toolbar '+width);
      await until(()=>ui('[...document.querySelectorAll(".toolbar button")].every(e=>{const r=e.getBoundingClientRect();return !r.width||(r.x>=0&&r.right<=innerWidth);})'),'all toolbar controls within '+width);
      assert.equal(await ui('document.querySelector(".doc-name").title'),first.name);
    }
    pass('long filenames with expanded/dirty badges retain every toolbar control at 960, 1280 and 1440 widths');
    await click(window,'.check-all input');
    await until(() => desktop.extension(window.webContents).snapshot().reviewed.length===1,'reviewed');
    const changedRevision=first.draft.revision;
    await click(window,'.toolbar button','恢复原显示');
    await until(() => !hidden().enabled && !hidden().busy,'collapsed');
    await until(async () => !await visible(preview,'two'),'native collapse rendered');
    assert.equal(await visible(preview,'two'),false); assert.equal(first.draft.revision,changedRevision);
    assert.equal(desktop.extension(window.webContents).snapshot().reviewed.length,1);
    assert.deepEqual(first.draft.candidate.bytes,new Uint8Array(expected));
    await click(window,'.toolbar button','显示隐藏内容');
    await until(() => hidden().enabled && !hidden().busy,'expanded again');
    pass('hidden text accepts live Unicode/entity edits; collapse preserves drafts and review with zero HTML writes');

    // beforeprint fires before Chromium switches media. Inspect actual print
    // media through the test-only debugger, then restore screen before export.
    assert.equal(preview.debugger.isAttached(),true); // retained production security session
    try {
      await preview.debugger.sendCommand('Emulation.setEmulatedMedia',{media:'print'});
      assert.deepEqual(await preview.executeJavaScript('[getComputedStyle(document.getElementById("two")).display,getComputedStyle(document.getElementById("three")).display]'),['none','block']);
    } finally { await preview.debugger.sendCommand('Emulation.setEmulatedMedia',{media:''}); }
    const pdf = await preview.printToPDF({pageSize:'A4',printBackground:true});
    assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
    assert.equal(await visible(preview,'two'),true);
    pass('actual PDF printing keeps original hidden rules and page print overrides while screen expansion remains');

    await click(window,'.toolbar button','复核并保存');
    await until(() => ui('!!document.querySelector(".diff-list")'),'source Diff');
    await click(window,'[role=dialog] button','确认保存');
    await until(() => state().lastSave?.status==='saved' && state().current?.id!==first.id,'verified native save and rebind');
    assert.deepEqual(await readFile(entry),expected); assert.equal(hidden().enabled,false); assert.equal(hidden().count,2);
    assert.equal(await visible(document().preview.contents,'two'),false);
    const stale = await request(true,first.id); assert.equal(stale.ok,false); assert.equal(stale.code,'STALE_WORKSPACE');
    pass('reviewed Windows Save preserves all non-text bytes and original tab behavior; new mappings reject old reveal requests');

    await click(window,'.toolbar button','只读预览');
    await until(() => state().current?.mode==='interactive'&&state().phase==='idle','interactive preview');
    const interactive=runtime.workspace.current!;
    assert.equal(hidden().available,false); assert.equal(state().current?.input,null);
    const denied = await request(true); assert.equal(denied.ok,false); assert.equal(denied.code,'READ_ONLY_MODE');
    const tabPoint=await interactive.preview.contents.executeJavaScript('(()=>{const r=document.getElementById("tab-two").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    interactive.preview.contents.focus();
    interactive.preview.contents.sendInputEvent({type:'mouseDown',...tabPoint,button:'left',clickCount:1});
    interactive.preview.contents.sendInputEvent({type:'mouseUp',...tabPoint,button:'left',clickCount:1});
    await until(()=>visible(interactive.preview.contents,'two'),'real tab navigation');
    assert.equal(await visible(interactive.preview.contents,'two'),true);
    assert.equal(await visible(interactive.preview.contents,'one'),false);
    assert.equal(await interactive.preview.contents.executeJavaScript('document.getElementById("second-text").textContent'),newText);
    assert.equal(await interactive.preview.contents.executeJavaScript('tabRuns'),1);
    await click(window,'button[aria-label="更多操作"]');
    await click(window,'[role=menuitem]','返回静态校稿');
    await until(() => state().current?.mode==='proofread'&&state().phase==='idle','proofread again');
    assert.equal(hidden().enabled,false); assert.equal(await visible(document().preview.contents,'two'),true);
    assert.equal(desktop.extension(window.webContents).snapshot().presentation?.panels,1);
    assert.deepEqual(await readFile(entry),expected);
    pass('saved original script switches tabs in readonly mode; return preserves the source-verified panel without migrating dynamic DOM');

    window.setContentSize(960,640);
    await until(async () => await ui('innerWidth')<=980,'narrow width');
    await click(window,'.toolbar button[aria-label="更多操作"]');
    await until(async () => await ui('!!document.querySelector("[role=menu]")') && (runtime.host.current?.getBounds().width??0)===0,'menu clear of Preview');
    assert.equal(await ui('(()=>{const r=document.querySelector("[role=menu]").getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight;})()'),true);
    await click(window,'[role=menuitem]','显示隐藏内容');
    await until(() => hidden().enabled && !hidden().busy && (runtime.host.current?.getBounds().width??0)>100,'narrow menu reveal returns focus/Preview');
    await select(document().preview.contents,'#second-text');
    await until(() => ui('!!document.querySelector("textarea.draft-input:not(:disabled)")'),'selected edit at narrow width');
    await ui('document.querySelector("textarea.draft-input").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:""}))');
    await until(() => document().input.snapshot().input?.composing===true,'composition active');
    const composing = await request(false); assert.equal(composing.ok,false); assert.equal(composing.code,'INPUT_FLUSH_REQUIRED');
    assert.equal(hidden().enabled,true);
    await ui('document.querySelector("textarea.draft-input").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:""}))');
    await until(() => document().input.snapshot().input?.composing===false,'composition ended');
    assert.deepEqual(await readFile(entry),expected);
    await writeFile(join(root,'preview.png'),await captureReady(document().preview.contents));
    await writeFile(join(root,'workbench.png'),await captureReady(window.webContents));
    pass('960px menu reveals supported content and restores the Preview; active composition rejects display changes');

    chosen=join(root,'具有很长文件名的标签页报告与隐藏内容校稿验证（副本与复核状态）.html');
    const blocked=Buffer.from('<!doctype html><html><body><div hidden style="display:none!important"><p>Blocked static text</p></div></body></html>');
    await writeFile(chosen,blocked);
    await click(window,'.toolbar button[aria-label="更多操作"]');
    await click(window,'[role=menuitem]','打开 HTML');
    await until(()=>state().current?.name===chosen.split(/[\\/]/).at(-1)&&state().phase==='idle','blocked source open');
    const rejected=await request(true); assert.equal(rejected.ok,false); assert.equal(rejected.code,'HIDDEN_CONTENT_UNAVAILABLE');
    assert.equal(hidden().enabled,false); assert.equal(hidden().uncertain,false); assert.equal(hidden().available,false);
    assert.equal(document().mapping.status,'ready'); assert.deepEqual(await readFile(chosen),blocked);
    assert.equal(await document().preview.contents.executeJavaScript('[...getComputedStyle(document.documentElement)].some(name=>name.startsWith("--hae-hidden-view-"))'),false);
    pass('inline important CSS that prevents expansion receives verified rollback without false success or source changes');
    await writeFile(join(results,'product-hidden.json'),JSON.stringify({status:'passed',passed,sourceHash:hash(original),savedHash:hash(expected),
      versions:process.versions,pending:['human IME and native chooser','CSS-only hiding and script-generated content']},null,2));
  } finally { await runtime.dispose(); if(!window.isDestroyed())window.destroy(); }
}
void run().then(()=>app.exit(0),async(error:unknown)=>{console.error(error);await writeFile(join(results,'product-hidden.json'),JSON.stringify({status:'failed',passed,error:String(error)},null,2));app.exit(1);});
