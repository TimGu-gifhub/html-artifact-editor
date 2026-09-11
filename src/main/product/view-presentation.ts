import type { OpenDocument } from '../workspace/document.ts';
import { isViewAppearance, planViewPresentation, viewAppearanceCss, viewProperties } from '../../core/parser/view-presentation.ts';
import type { ViewAppearance, ViewPlan } from '../../core/parser/view-presentation.ts';

// Fixed isolated-world reader. A complete source tree must match first. Only
// HTML presentation attributes may differ; no observed Text ever enters a draft.
export const observeViewCode = String.raw`async function readView(plan, settle = false) {
  const stack=[{node:document,parent:-1}], elements=new Map();let index=0;
  while(stack.length){
    const {node,parent}=stack.pop(), offset=index++, source=plan.tree[offset];
    if(!source||source.parent!==parent)return null;
    if(node.nodeType===Node.DOCUMENT_NODE&&source.kind==='document'){
      if(document.compatMode!==source.mode)return null;
    }else if(node.nodeType===Node.DOCUMENT_TYPE_NODE&&source.kind==='doctype'){
      if(node.name!==source.name||node.publicId!==source.publicId||node.systemId!==source.systemId)return null;
    }else if(node.nodeType===Node.ELEMENT_NODE&&source.kind==='element'){
      if(node.shadowRoot||node.localName!==source.name||node.namespaceURI!==source.namespace)return null;
      const allowed=source.namespace==='http://www.w3.org/1999/xhtml'
        ? ['class','style','hidden','aria-hidden','aria-expanded',...(source.name==='details'?['open']:[])] : [];
      if(node.attributes.length>source.attributes.length+allowed.length)return null;
      const actual=[...node.attributes].filter(a=>a.namespaceURI||!allowed.includes(a.name));
      const expected=source.attributes.filter(a=>a.namespace||!allowed.includes(a.name));
      if(actual.length!==expected.length||expected.some(a=>node.getAttributeNS(a.namespace||null,a.name)!==a.value))return null;
      elements.set(offset,node);
    }else if((node.nodeType===Node.TEXT_NODE&&source.kind==='text')||(node.nodeType===Node.COMMENT_NODE&&source.kind==='comment')){
      if(node.nodeValue!==source.value)return null;
    }else return null;
    if(node.childNodes.length>plan.tree.length-index)return null;
    const children=[...node.childNodes];for(let i=children.length-1;i>=0;--i)stack.push({node:children[i],parent:offset});
  }
  if(index!==plan.tree.length)return null;
  if(settle){
    const transitions=[];
    for(const target of plan.targets){
      for(const animation of elements.get(target.index).getAnimations()){
        if(animation instanceof CSSTransition && animation.playState==='running')transitions.push(animation);
        if(transitions.length>400)return null;
      }
    }
    if(transitions.length){
      let timer;
      try{await Promise.race([Promise.allSettled(transitions.map(a=>a.finished)),new Promise(resolve=>{timer=setTimeout(resolve,1000)})]);}
      finally{clearTimeout(timer)}
      return readView(plan,false);
    }
  }
  const properties=${JSON.stringify(viewProperties)};
  return plan.targets.map(target=>{
    const element=elements.get(target.index);if(!element)return null;
    const style=getComputedStyle(element);
    return {values:properties.map(key=>style.getPropertyValue(key)),
      details:target.details ? (CSS.supports('selector(details::details-content)')
        ? getComputedStyle(element,'::details-content').contentVisibility==='visible' : null) : null,
      before:getComputedStyle(element,'::before').transform, after:getComputedStyle(element,'::after').transform};
  });
}`;
export type FrozenView = Readonly<{ rules: readonly string[]; changed: readonly { selector: string; appearance: ViewAppearance }[];
  elements: number; details: number; partial: boolean }>;

export async function captureViewPresentation(previous: OpenDocument, next: OpenDocument,
  read: <T>(operation: Promise<T>) => Promise<T>, signal: AbortSignal): Promise<FrozenView | null> {
  const source = next.mode === 'proofread' ? next.mapping.source : previous.mode === 'proofread' ? previous.mapping.source : null;
  if (!source) return null;
  const unavailable: FrozenView = { rules: [], changed: [], elements: 0, details: 0, partial: true };
  const plan = planViewPresentation(source.tree);
  if (!plan) return unavailable;
  const changes = new Map(previous.input?.snapshot().changes.map(change => [change.nodeId, change.newText]) ?? []);
  const previousPlan: ViewPlan = { ...plan, tree: plan.tree.map(node => node.kind === 'text' && changes.has(node.nodeId)
    ? { ...node, value: changes.get(node.nodeId)! } : node) };
  const observe = (document: OpenDocument, value: ViewPlan, settle = false) => read(document.preview.contents.executeJavaScriptInIsolatedWorld(1005,
    [{ code: `(${observeViewCode})(${JSON.stringify(value)},${settle})` }])) as Promise<unknown>;
  const before = await observe(previous, previousPlan, previous.mode === 'interactive'); signal.throwIfAborted();
  const after = await observe(next, plan); signal.throwIfAborted();
  if (before === null || after === null) return unavailable;
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== plan.targets.length || after.length !== before.length) throw new Error('PRESENTATION_UNAVAILABLE');
  const changed: { selector: string; appearance: ViewAppearance }[] = [];
  let partial = false;
  for (let i = 0; i < before.length; ++i) {
    const target = plan.targets[i]!;
    if (!isViewAppearance(before[i]) || !isViewAppearance(after[i]) || (target.details && before[i].details === null)) { partial = true; continue; }
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) changed.push({ selector: target.selector, appearance: before[i] });
  }
  if (changed.length > 400) return unavailable;
  const rules = changed.map(({ selector, appearance }) => viewAppearanceCss(selector, appearance));
  if (rules.join('').length > 256 * 1024) return unavailable;
  return { rules, changed, elements: changed.length, details: changed.filter(value => value.appearance.details === true).length, partial };
}

export function verifyViewCode(view: FrozenView): string {
  return `(() => {
    const properties=${JSON.stringify(viewProperties)}, changes=${JSON.stringify(view.changed)};
    return changes.every(({selector,appearance})=>{
      const e=document.querySelector(selector);if(!e)return false;
      const style=getComputedStyle(e);
      return properties.every((key,i)=>style.getPropertyValue(key)===appearance.values[i])
        && (appearance.details===null || (getComputedStyle(e,'::details-content').contentVisibility==='visible')===appearance.details)
        && getComputedStyle(e,'::before').transform===appearance.before && getComputedStyle(e,'::after').transform===appearance.after;
    });
  })()`;
}
