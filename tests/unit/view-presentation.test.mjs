import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createSourceIndex} from '../../src/core/parser/source-index.ts';
import {planViewPresentation,isViewAppearance,viewAppearanceCss} from '../../src/core/parser/view-presentation.ts';
import {captureViewPresentation} from '../../src/main/product/view-presentation.ts';
import {previewCSP} from '../../src/main/protocol/resource-policy.ts';
const sourceOf=html=>createSourceIndex(Buffer.from(html),{projectId:'test',documentId:'test',generation:1},bytes=>createHash('sha256').update(bytes).digest('hex'));
const source=sourceOf('<!doctype html><main><h1>Heading &amp; 😀</h1><details><summary>Open</summary><p>Original</p></details></main>');
const appearance={values:['block','visible','visible','1','none','none'],details:null,before:'none',after:'none'};

test('whole-view plans use only bounded source-derived paths, need no IDs and retain all literal Text/structure',()=>{
 const before=JSON.stringify(source.tree), plan=planViewPresentation(source.tree);
 assert.ok(plan.targets.some(t=>t.details));assert.equal(plan.tree,source.tree);
 for(const t of plan.targets){assert.match(t.selector,/^:root:nth-child\(\d+\)( > :nth-child\(\d+\))*$/);assert.equal(source.tree[t.index].kind,'element')}
 assert.equal(JSON.stringify(source.tree),before);
 assert.equal(planViewPresentation(sourceOf('<!doctype html><template>Unsupported fragment</template>').tree),null);
 assert.equal(planViewPresentation(Array(5001).fill(source.tree[0])),null);
 assert.equal(planViewPresentation(sourceOf('<!doctype html><p>'+ 'X'.repeat(768*1024)+'</p>').tree),null);
});
test('observed presentation cannot inject selectors, scripts, URLs, extra capabilities or arbitrary CSS',()=>{
 assert.ok(isViewAppearance(appearance));assert.match(viewAppearanceCss(':root:nth-child(1)',appearance),/animation:none!important/);
 for(const value of [{...appearance,path:'file.html'}, {...appearance,values:['url(https://example.invalid)','visible','visible','1','none','none']},
  {...appearance,before:'none;}body{display:none'}, {...appearance,after:'matrix(1,,0,1,0,0)'}, {...appearance,details:'open'},
  {...appearance,values:['block','visible','visible','2','none','none']}, {...appearance,values:['block','visible','visible','1','none','url(secret.svg)']}]) assert.equal(isViewAppearance(value),false);
 assert.throws(()=>viewAppearanceCss('body,script',appearance),/PRESENTATION_UNAVAILABLE/);
 for(const mode of ['interactive','proofread']){assert.match(previewCSP(mode),/form-action 'none'/);assert.doesNotMatch(previewCSP(mode),/allow-forms/)}
});
test('capture compares two verified source presentations and returns only fixed style fields, never runtime Text',async()=>{
 const plan=planViewPresentation(source.tree);
 const originals=plan.targets.map(t=>({...appearance,details:t.details?false:null}));
 const viewed=structuredClone(originals), target=plan.targets.findIndex(t=>t.details);
 viewed[target].details=true;
 const sent=[];
 const previous={mode:'interactive',input:null,preview:{contents:{executeJavaScriptInIsolatedWorld:async(world,code)=>{sent.push([world,code]);return viewed}}}};
 const next={mode:'proofread',mapping:{source},preview:{contents:{executeJavaScriptInIsolatedWorld:async()=>originals}}};
 const result=await captureViewPresentation(previous,next,x=>x,new AbortController().signal);
 assert.equal(result.elements,1);assert.equal(result.details,1);assert.equal(result.partial,false);
 assert.match(result.rules[0],/::details-content\{content-visibility:visible/);
 assert.doesNotMatch(JSON.stringify(result),/Original|Heading|nodeId|offset|startByte/);
 assert.equal(sent[0][0],1005);
 previous.preview.contents.executeJavaScriptInIsolatedWorld=async()=>null;
 const rejected=await captureViewPresentation(previous,next,x=>x,new AbortController().signal);
 assert.equal(rejected.partial,true);assert.equal(rejected.elements,0);assert.deepEqual(rejected.rules,[]);
 previous.preview.contents.executeJavaScriptInIsolatedWorld=async()=>({forged:'fields'});
 await assert.rejects(captureViewPresentation(previous,next,x=>x,new AbortController().signal),/PRESENTATION_UNAVAILABLE/);
});
