import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import { registerSchemes } from '../../src/main/application.ts';
import { createProductApplication } from '../../src/main/product/application.ts';
import { proofreadDocument } from '../helpers/proofread.ts';
import { captureReady } from '../helpers/capture.ts';

const out=resolve(__dirname,'..'), results=resolve(out,'../test-results'), passed:string[]=[];
registerSchemes(); app.enableSandbox(); app.on('window-all-closed',()=>{});
app.setPath('userData',join(results,'view-profile-'+randomUUID()));
const source=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Local view fixture</title><style>
body{margin:36px;background:#fafafa;color:#171717;font:18px/1.6 sans-serif}main{max-width:700px;margin:auto}
.reveal{opacity:0;filter:blur(10px);transform:translateY(12px);transition:opacity .15s,filter .15s,transform .15s}
.reveal.in{opacity:1;filter:blur(0);transform:none}.gap{height:900px}details{border-bottom:1px solid #999}
summary{cursor:pointer;list-style:none}summary::after{content:'+';display:inline-block;margin-left:20px;transition:transform .15s}details[open] summary::after{transform:rotate(45deg)}
input,button{font:inherit}#ok,#secret{display:none}footer{height:100px}
</style></head><body><main><h1 class="reveal">静态标题</h1><div class="gap"></div>
<section class="reveal"><h2>问答</h2><details><summary>展开第一项</summary><p id="answer">静态答案 &amp; 😀</p></details>
<details><summary>保留关闭</summary><p id="closed">尚未展开的答案</p></details></section>
<section class="reveal"><h2>订阅演示</h2><form id="sub" novalidate><input type="email" aria-label="邮箱"><button type="submit">确认订阅</button></form><p id="ok">已收到演示请求</p></section>
<p id="secret">不应全部展开</p><footer>普通静态文字</footer></main><script>
globalThis.demoRuns=1;globalThis.demoSubmits=0;
const observer=new IntersectionObserver(entries=>{entries.forEach(en=>{if(en.isIntersecting){en.target.classList.add('in');observer.unobserve(en.target)}})},{threshold:.1});
document.querySelectorAll('.reveal').forEach(e=>observer.observe(e));
document.getElementById('sub').addEventListener('submit',function(ev){ev.preventDefault();if(!this.querySelector('input').value.includes('@'))return;demoSubmits++;this.style.display='none';document.getElementById('ok').style.display='block'});
</script></body></html>`;
const attrs='JSON.stringify([...document.querySelectorAll("*")].map(e=>[e.tagName,[...e.attributes].map(a=>[a.name,a.value])]))';
const visible=(selector:string)=>`document.querySelector(${JSON.stringify(selector)}).checkVisibility({visibilityProperty:true,opacityProperty:true})`;
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw Error('TIMEOUT '+label);await delay(30);}}
async function click(contents:WebContents, selector:string, label='', text=false){
  BrowserWindow.fromWebContents(contents)?.focus();
  await delay(60);
  const point=await contents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>!e.disabled&&e.getBoundingClientRect().width&&e.textContent.includes(${JSON.stringify(label)}));if(!e)throw Error('NO_TARGET');let r;if(${text}){r=document.createRange();r.setStart(e.firstChild,0);r.setEnd(e.firstChild,1);r=r.getBoundingClientRect()}else r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  contents.focus();contents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});contents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
}
async function run(){
 await mkdir(results,{recursive:true});await app.whenReady();const root=await mkdtemp(join(results,'view-state-')), entry=join(root,'sample.html');
 await writeFile(entry,source);const original=await readFile(entry);
 const product=await createProductApplication(out,{visible:false,bindQuit:false,initialPanel:'inline',choices:{open:async()=>entry}});
 const {window,runtime,desktop}=product, state=()=>runtime.workspace.snapshot(), doc=()=>proofreadDocument(runtime.workspace.current);
 const ui=(code:string)=>window.webContents.executeJavaScript(code), desk=()=>desktop.extension(window.webContents).snapshot();
 const control=(label:string)=>click(window.webContents,'.toolbar button',label);
 const pass=(label:string)=>{passed.push(label);console.log('PASS '+label)};
 try{
  window.setContentSize(1440,900);window.setAlwaysOnTop(true);window.show();await until(()=>{if(!window.isVisible())window.show();return window.isVisible()},'visible Main');
  await until(()=>ui('!!document.querySelector(".app")'),'UI');await control('打开 HTML');await until(()=>!!state().current&&state().phase==='idle','open');
  const originalAttrs=await doc().preview.contents.executeJavaScript(attrs);
  await control('只读预览');await until(()=>state().current?.mode==='interactive'&&state().phase==='idle','browse');
  let browsing=runtime.workspace.current!.preview.contents;
  assert.equal(await browsing.executeJavaScript('typeof demoRuns'), 'number');
  await browsing.executeJavaScript('document.querySelector("section").scrollIntoView({block:"start",behavior:"instant"})');
  await until(()=>browsing.executeJavaScript('getComputedStyle(document.querySelector("section")).transform==="none"&&getComputedStyle(document.querySelector("section")).opacity==="1"'),'reveal settled');
  await click(browsing,'summary','展开第一项');await until(()=>browsing.executeJavaScript(visible('#answer')),'expanded answer');
  await click(browsing,'input');await browsing.insertText('test@example.invalid');await click(browsing,'button','确认订阅');
  await until(()=>browsing.executeJavaScript('demoSubmits===1&&document.getElementById("ok").style.display==="block"'),'local form callback');
  await until(()=>browsing.executeJavaScript('getComputedStyle(document.querySelector("section")).transform==="none"'),'motion settled');
  const y=await browsing.executeJavaScript('scrollY');
  pass('real browsing runs local reveal and submit handlers, opens one FAQ and leaves the other closed');
  await control('编辑文字');await until(()=>state().current?.mode==='proofread'&&state().phase==='idle','edit');
  const first=doc(), preview=first.preview.contents;
  assert.equal(await preview.executeJavaScript('typeof demoRuns'),'undefined');assert.equal(first.mapping.status,'ready');
  assert.equal(await preview.executeJavaScript(attrs),originalAttrs);
  assert.equal(await preview.executeJavaScript(visible('#answer')),true);assert.equal(await preview.executeJavaScript(visible('#closed')),false);
  assert.equal(await preview.executeJavaScript(visible('#ok')),true);assert.equal(await preview.executeJavaScript(visible('#sub')),false);
  assert.equal(await preview.executeJavaScript(visible('#secret')),false);
  assert.equal(desk().presentation?.status,'restored');assert.ok((desk().presentation?.elements??0)>0);assert.equal(desk().presentation?.details,1);
  assert.ok(Math.abs(await preview.executeJavaScript('scrollY')-y)<5);
  pass('edit preserves visible reveals, expanded FAQ and submitted message through source-verified CSS, with original DOM attributes and closed content intact');
  await click(preview,'#answer','',true);await until(()=>!!first.input.snapshot().input,'direct inline answer');
  const editor=desktop.ownedWindows().find(w=>w.isFocusable()&&w.getTitle()==='原位文字编辑')!;
  await until(()=>editor.webContents.executeJavaScript('document.activeElement?.classList.contains("inline-text-input")===true'),'inline caret');
  assert.equal(desk().panel,'inline');assert.equal(await ui('document.querySelectorAll(".side-panel").length'),0);
  await editor.webContents.executeJavaScript('document.querySelector("textarea").select()');editor.focus();editor.webContents.focus();
  const text='校对答案 <&> 😀';await editor.webContents.insertText(text);
  await until(()=>first.input.snapshot().input?.appliedText===text&&!first.input.snapshot().hasUnappliedInput,'live answer');
  const expected=Buffer.from(source.replace('静态答案 &amp; 😀','校对答案 &lt;&amp;&gt; 😀'));
  assert.deepEqual(first.draft.candidate.bytes,new Uint8Array(expected));assert.deepEqual(await readFile(entry),original);
  await writeFile(join(root,'preview.png'),await captureReady(preview));await writeFile(join(root,'editor.png'),await captureReady(editor.webContents));
  pass('direct answer click focuses the original-position input and previews Unicode/entity edits without the sidebar or HTML writes');
  await control('复核变更');await until(()=>ui('!!document.querySelector("[role=dialog]")'),'review');
  await click(window.webContents,'.check-all input');await until(()=>desk().reviewed.length===1,'checked');
  await click(window.webContents,'[role=dialog] button','复核并保存');await until(()=>ui('!!document.querySelector(".diff-list")'),'source Diff');
  await click(window.webContents,'[role=dialog] button','确认保存');await until(()=>state().lastSave?.status==='saved'&&state().current?.id!==first.id,'Save');
  assert.deepEqual(await readFile(entry),expected);assert.equal(await doc().preview.contents.executeJavaScript(attrs),originalAttrs);
  assert.equal(await doc().preview.contents.executeJavaScript(visible('#answer')),true);assert.equal(await doc().preview.contents.executeJavaScript(visible('#ok')),true);
  assert.equal(desk().presentation?.status,'restored');pass('reviewed native Windows Save changes only the intended Text bytes and retains the current expanded display');
  const saved=doc().preview.contents;
  try{await saved.debugger.sendCommand('Emulation.setEmulatedMedia',{media:'print'});assert.equal(await saved.executeJavaScript(visible('#answer')),false)}finally{await saved.debugger.sendCommand('Emulation.setEmulatedMedia',{media:''})}
  assert.equal(await saved.executeJavaScript(visible('#answer')),true);pass('current-view styling is screen-only and does not rewrite original print rules');
  const savedId=doc().id;
  await control('打开 HTML');await until(()=>{const now=state();return !!now.current&&now.current.id!==savedId&&now.phase==='idle'},'fresh open');
  await control('只读预览');await until(()=>state().current?.mode==='interactive'&&state().phase==='idle','reopen browsing');
  browsing=runtime.workspace.current!.preview.contents;
  await browsing.executeJavaScript('document.querySelector("section").scrollIntoView({block:"start",behavior:"instant"})');
  await until(()=>browsing.executeJavaScript('getComputedStyle(document.querySelector("section")).transform==="none"'),'fresh reveal');
  await click(browsing,'summary','展开第一项');await until(()=>browsing.executeJavaScript(visible('#answer')),'reopened FAQ');
  assert.equal(await browsing.executeJavaScript('document.getElementById("answer").textContent'),text);
  await click(browsing,'input');await browsing.insertText('again@example.invalid');await click(browsing,'button','确认订阅');
  await until(()=>browsing.executeJavaScript('demoSubmits===1'),'reopened local callback');
  pass('fresh file reopens with corrected text and working original FAQ and local submit interactions');
  await browsing.executeJavaScript('document.getElementById("answer").textContent="Generated content"');
  await control('编辑文字');await until(()=>state().current?.mode==='proofread'&&state().phase==='idle','dynamic rejection');
  assert.equal(desk().presentation?.status,'partial');assert.equal(desk().presentation?.elements,0);
  assert.equal(await doc().preview.contents.executeJavaScript('document.getElementById("answer").textContent'),text);
  assert.equal(doc().input.snapshot().changes.length,0);assert.deepEqual(await readFile(entry),expected);
  pass('runtime-written Text cannot migrate into the fresh source mapping, draft or Save; partial display is explicit');
 }finally{await runtime.dispose();if(!window.isDestroyed())window.destroy();}
 await writeFile(join(results,'product-view.json'),JSON.stringify({status:'passed',passed,artifacts:root},null,2));
}
void run().then(()=>app.exit(0),async error=>{console.error(error);await writeFile(join(results,'product-view.json'),JSON.stringify({status:'failed',passed,error:String(error)},null,2));app.exit(1)});
