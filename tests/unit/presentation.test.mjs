import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { planPresentation } from '../../src/core/parser/presentation.ts';
import { createPresentationController } from '../../src/main/product/presentation.ts';
import { isTextGeometry, isTextDecoration } from '../../src/contracts/text-geometry.ts';
import { isDesktopCommand } from '../../src/contracts/desktop.ts';
import { isInlineTextGeometry } from '../../src/contracts/inline-text.ts';

const sourceOf = html => createSourceIndex(Buffer.from(html), {projectId:'test',documentId:'test',generation:1},
  bytes=>createHash('sha256').update(bytes).digest('hex'));
const source = sourceOf('<!doctype html><div role="tablist"><button role="tab" aria-controls="first">First</button>'
  + '<button role="tab" aria-controls="other">Second</button></div><section id="first"><p>原文 &amp; 😀</p></section>'
  + '<!--保留--><section hidden id="other"><p>后续 <b>文字</b></p></section>');

test('presentation uses bounded unique source panels, exact numeric paths and source tab associations without byte changes',()=>{
  const before=source.bytes, tree=JSON.stringify(source.tree), plan=planPresentation(source);
  assert.equal(plan.groups.length,1); assert.equal(plan.groups[0].length,2);
  for(const panel of plan.groups[0]) {
    assert.match(panel.selector,/^:root:nth-child\(1\)( > :nth-child\(\d+\))+$/);
    assert.match(panel.tab,/^:root:nth-child/); assert.equal(panel.tree[0].parent,-1);
  }
  assert.deepEqual(source.bytes,before); assert.equal(JSON.stringify(source.tree),tree);
  const sample=planPresentation(sourceOf('<!doctype html><div role=tablist><button role=tab data-tab=one>One</button>'
    + '<button role=tab data-tab=two>Two</button></div><pre id=code-one>one</pre><pre id=code-two hidden>two</pre>'));
  assert.ok(sample.groups[0].every(panel=>panel.tab));
});
test('duplicates, unsupported contexts and oversized source plans never produce a partial authority',()=>{
  for(const html of ['<section id=a>A</section><section id=a hidden>B</section>',
    '<form><section id=a>A</section><section id=b hidden>B</section></form>',
    '<template><section id=a>A</section><section id=b hidden>B</section></template>'])
    assert.equal(planPresentation(sourceOf('<!doctype html>'+html)).groups.length,0);
  const excess=planPresentation(sourceOf('<!doctype html>'+Array.from({length:101},(_,i)=>`<section id=p${i} ${i?'hidden':''}>正文</section>`).join('')));
  assert.equal(excess.limited,true); assert.deepEqual(excess.groups,[]);
});
test('CSS-only sibling panels need no ARIA or hidden attribute; the full source tree is still required',()=>{
  for(const html of ['<section id=a>A</section><section id=b style="display:none">B</section>',
    '<style>.off{display:none}</style><div id=a>A</div><div id=b class=off>B</div>']) {
    const index=sourceOf('<!doctype html>'+html), before=index.bytes;
    const plan=planPresentation(index);
    assert.equal(plan.groups.length,1); assert.equal(plan.groups[0].length,2);
    assert.ok(plan.groups[0].every(panel=>panel.tree.length>1)); assert.deepEqual(index.bytes,before);
  }
});

test('inline geometry admits bounded appearance only; Main fallback and source authority cannot come from Preview',()=>{
  const value={nodeId:'n1',rect:{x:10,y:20,width:100,height:24},caret:4,activation:1,
    style:{fontFamily:'monospace',fontSize:16,fontWeight:'400',fontStyle:'normal',lineHeight:24,letterSpacing:0,
      color:'rgb(20, 20, 20)',background:'rgb(255, 255, 255)',whiteSpace:'pre-wrap',textAlign:'start',direction:'ltr',indent:0}};
  assert.equal(isInlineTextGeometry(value),true);
  for(const bad of [{...value,detached:true},{...value,documentId:randomUUID()},{...value,selector:'#arbitrary'},
    {...value,caret:-1},{...value,activation:Infinity},{...value,rect:{...value.rect,width:20000}},
    {...value,style:{...value.style,color:'url(https://example.invalid)'}},
    {...value,style:{...value.style,fontSize:0}},{...value,style:{...value.style,backgroundImage:'none'}}])
    assert.equal(isInlineTextGeometry(bad),false);
  assert.equal(isDesktopCommand({kind:'panel',mode:'inline'}),true);
});

function fixture(observation={x:0,y:100,height:600,groups:[{active:1,top:120}]}) {
  const calls=[]; let installed=false, visible=true, retained=false;
  const previous={id:randomUUID(),mode:'interactive',preview:{view:{getBounds:()=>({x:0,y:0,width:900,height:600})},
    contents:{executeJavaScriptInIsolatedWorld:async world=>world===1005?null:observation}}};
  const next={id:randomUUID(),mode:'proofread',mapping:{source},preview:{view:{setBounds:value=>calls.push(['bounds',value])},
    contents:{insertCSS:async(css,options)=>{calls.push(['insert',css,options]);installed=true;return 'owned-key';},
      removeInsertedCSS:async key=>{calls.push(['remove',key]);if(!retained)installed=false;},
      executeJavaScriptInIsolatedWorld:async(_world,scripts)=>{
        if(_world===1005)return scripts[0].code.includes('changes.every')?true:null;
        const code=scripts[0].code;
        if(code.includes('groups.every'))return visible;
        if(code.includes('scrollTo'))return {x:0,y:100};
        return installed;
      }}},};
  const controller=createPresentationController();
  return {controller,previous,next,calls,setVisible:value=>{visible=value;},retain:()=>{retained=true;}};
}
test('a verified presentation transfer and exact style reset do not transfer page DOM, source bytes or input authority',async()=>{
  const f=fixture(); await f.controller.transfer(f.previous,f.next,new AbortController().signal);
  assert.deepEqual(f.controller.snapshot(f.next),{documentId:f.next.id,panels:1,elements:0,details:0,status:'partial'});
  const insert=f.calls.find(call=>call[0]==='insert'); assert.match(insert[1],/^@media screen/);
  assert.deepEqual(insert[2],{cssOrigin:'author'}); assert.equal(f.previous.mapping,undefined);
  await f.controller.reset(f.next); assert.equal(f.controller.snapshot(f.next),undefined);
  assert.deepEqual(f.calls.find(call=>call[0]==='remove'),['remove','owned-key']);
});
test('changed dynamic subtrees are omitted; unavailable display and cancellation never claim a retained view',async()=>{
  const partial=fixture({x:0,y:100,height:600,groups:[null]});
  await partial.controller.transfer(partial.previous,partial.next,new AbortController().signal);
  assert.equal(partial.calls.some(call=>call[0]==='insert'),false);
  assert.equal(partial.controller.snapshot(partial.next).status,'partial');
  const blocked=fixture(); blocked.setVisible(false);
  await assert.rejects(blocked.controller.transfer(blocked.previous,blocked.next,new AbortController().signal),/PRESENTATION_UNAVAILABLE/);
  assert.equal(blocked.controller.snapshot(blocked.next).status,'partial');
  const cancelled=fixture(), signal=new AbortController(); signal.abort();
  await assert.rejects(cancelled.controller.transfer(cancelled.previous,cancelled.next,signal.signal));
  assert.equal(cancelled.calls.length,0);
  const malformed=fixture({x:Infinity,y:100,height:600,groups:[{active:1,top:0}]});
  await assert.rejects(malformed.controller.transfer(malformed.previous,malformed.next,new AbortController().signal),/PRESENTATION_UNAVAILABLE/);
  assert.equal(malformed.calls.some(call=>call[0]==='insert'),false);
});
test('an unconfirmed stylesheet removal retains its handle without advertising a successful presentation',async()=>{
  const f=fixture(); await f.controller.transfer(f.previous,f.next,new AbortController().signal); f.retain();
  await assert.rejects(f.controller.reset(f.next),/PRESENTATION_UNAVAILABLE/);
  assert.equal(f.controller.snapshot(f.next),undefined);
  await assert.rejects(f.controller.reset(f.next),/PRESENTATION_UNAVAILABLE/);
  assert.equal(f.calls.filter(call=>call[0]==='remove').length,2,'private removal handle was retained');
});
test('geometry is bounded presentation data only; contextual controls accept no page selector or file authority',()=>{
  const identity={preview:{version:1,sessionId:randomUUID(),generation:1,mode:'proofread'},documentId:randomUUID(),baseHash:'a'.repeat(64)};
  const shape={nodeId:'n1',rects:[{x:1,y:2,width:20,height:16}]};
  const geometry={identity,revision:1,sequence:1,width:900,height:600,hover:shape,selected:null};
  assert.equal(isTextGeometry(geometry),true); assert.equal(isTextDecoration({hover:shape,selected:null}),true);
  for(const value of [{...geometry,offset:0},{...geometry,sequence:0},{...geometry,width:Infinity},
    {...geometry,hover:{...shape,selector:'#fake'}},{...geometry,hover:{...shape,rects:Array(81).fill(shape.rects[0])}},
    {...geometry,hover:{...shape,rects:[{x:NaN,y:1,width:5,height:5}]}},
    {...geometry,identity:{...identity,preview:{...identity.preview,mode:'interactive'}}}]) assert.equal(isTextGeometry(value),false);
  assert.equal(isDesktopCommand({kind:'panel',mode:'contextual'}),true);
  assert.equal(isDesktopCommand({kind:'panel',mode:'contextual',selector:'#arbitrary'}),false);
});
