import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createSourceIndex } from '../../src/core/parser/source-index.ts';
import { planHiddenContent } from '../../src/core/parser/hidden-content.ts';
import { createHiddenContentController } from '../../src/main/product/hidden-content.ts';
import { isDesktopCommand } from '../../src/contracts/desktop.ts';

const sourceOf = html => createSourceIndex(Buffer.from(html), { projectId: 'test', documentId: 'hidden', generation: 1 },
  bytes => createHash('sha256').update(bytes).digest('hex'));
const source = sourceOf('<!doctype html><h1>Visible</h1><!-- gap --><pre hidden id="a:unsafe">中文 &amp; 🧪</pre>');

test('screen-only expansion derives numeric paths from the complete source tree and leaves source bytes unchanged', () => {
  const bytes = source.bytes, tree = JSON.stringify(source.tree);
  const plan = planHiddenContent(source);
  assert.equal(plan.count, 1); assert.equal(plan.limited, false);
  assert.match(plan.css, /^@media screen\{:root:nth-child\(1\)/);
  assert.match(plan.css, /:nth-child\(1\) > :nth-child\(2\) > :nth-child\(2\)/);
  assert.doesNotMatch(plan.css, /unsafe|中文|&|🧪|url\(/);
  assert.equal(JSON.stringify(source.tree), tree); assert.deepEqual(source.bytes, bytes);
  const nested = planHiddenContent(sourceOf('<!doctype html><div hidden><table hidden><tr><td>nested</td></tr></table></div>'));
  assert.equal(nested.count, 2); assert.match(nested.css, /display:table!important/);
});

test('unsupported form/template/foreign/script content, CSS-only hidden text and over-budget plans grant no expansion', () => {
  const restricted = sourceOf('<!doctype html><form hidden><p>form</p></form><template hidden><p>template</p></template>'
    + '<script hidden>globalThis.run=true</script><svg hidden><text>svg</text></svg><p style="display:none">css</p><p hidden> </p>');
  assert.equal(planHiddenContent(restricted).count, 0);
  const limited = planHiddenContent(sourceOf('<!doctype html>' + '<p hidden>text</p>'.repeat(201)));
  assert.equal(limited.count, 201); assert.equal(limited.limited, true); assert.equal(limited.css, '');
});

function fixture() {
  let resolveInsert, rejectRemove = false, active = true, releases = 0, inserted = false, blocked = false, retained = false;
  const removals = [], insertions = [];
  const document = {
    id: randomUUID(), mode: 'proofread', mapping: { source, status: 'ready' },
    input: { snapshot: () => ({stateRevision: 3, phase: 'idle', draftPhase: 'idle', hasUnappliedInput: false}),
      holdDeparture: () => () => { releases++; } },
    preview: { isActive: () => true, contents: { isDestroyed: () => false,
      insertCSS: (...args) => { insertions.push(args); return new Promise(done => { resolveInsert = () => { inserted = true; done('key'); }; }); },
      executeJavaScriptInIsolatedWorld: async (world, scripts) => {
        assert.equal(world, 1003); assert.equal(scripts.length, 1);
        return {present: inserted, visible: inserted && !blocked ? 1 : 0};
      },
      removeInsertedCSS: async key => { removals.push(key); if (rejectRemove) throw Error('native failure'); if (!retained) inserted = false; } } },
  };
  const owner = { current: document, snapshot: () => ({stateRevision: 7,phase: 'idle'}) };
  const controller = createHiddenContentController(() => owner, () => {});
  return { document, owner, controller, removals, insertions, active: () => active,
    revoke: () => { active = false; }, finish: () => resolveInsert(), failRemoval: () => { rejectRemove = true; },
    block: () => { blocked = true; }, retainSheet: () => { retained = true; },
    releases: () => releases };
}

test('native expansion is exclusive, revocation removes the exact inserted sheet, and new documents start collapsed', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  const pending = f.controller.set(f.document.id, 7, true, f.active, signal);
  assert.equal(f.controller.busy, true);
  await assert.rejects(f.controller.set(f.document.id, 7, true, f.active, signal), /HIDDEN_CONTENT_BUSY/);
  f.revoke(); f.finish(); await assert.rejects(pending, /STALE_WORKSPACE/);
  assert.deepEqual(f.removals, ['key']); assert.equal(f.controller.snapshot().enabled, false);
  assert.equal(f.releases(), 1);
  const g = fixture(); const op = g.controller.set(g.document.id, 7, true, g.active, signal);
  g.finish(); await op; assert.equal(g.controller.snapshot().enabled, true);
  assert.deepEqual(g.insertions[0][1], {cssOrigin:'author'});
  g.owner.current = {...g.document, id: randomUUID()};
  assert.equal(g.controller.snapshot().enabled, false);
  await assert.rejects(g.controller.set(g.document.id, 7, true, g.active, signal), /STALE_WORKSPACE/);
  await g.controller.dispose();
});

test('page CSS blocking expansion rolls back without claiming success; a resolved but ineffective removal is uncertain', async () => {
  const signal = new AbortController().signal;
  const f = fixture(); f.block();
  const op = f.controller.set(f.document.id, 7, true, f.active, signal); f.finish();
  await assert.rejects(op, /HIDDEN_CONTENT_UNAVAILABLE/);
  assert.deepEqual(f.removals, ['key']);
  assert.equal(f.controller.snapshot().enabled, false); assert.equal(f.controller.snapshot().uncertain, false);
  assert.equal(f.controller.snapshot().available, false);
  const g = fixture(); const pending = g.controller.set(g.document.id, 7, true, g.active, signal); g.finish(); await pending;
  g.retainSheet();
  await assert.rejects(g.controller.set(g.document.id, 7, false, g.active, signal), /HIDDEN_CONTENT_FAILED/);
  assert.equal(g.controller.snapshot().enabled, true); assert.equal(g.controller.snapshot().uncertain, true);
});

test('uncertain native removal is reported and cannot claim collapse or silently retry; disposal joins an accepted action', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  const op = f.controller.set(f.document.id, 7, true, f.active, signal); f.finish(); await op;
  f.failRemoval();
  await assert.rejects(f.controller.set(f.document.id, 7, false, f.active, signal), /HIDDEN_CONTENT_FAILED/);
  assert.equal(f.controller.snapshot().enabled, true); assert.equal(f.controller.snapshot().uncertain, true);
  assert.equal(f.controller.snapshot().available, false);
  await assert.rejects(f.controller.set(f.document.id, 7, false, f.active, signal), /HIDDEN_CONTENT_UNAVAILABLE/);
  const g = fixture(); const pending = g.controller.set(g.document.id, 7, true, g.active, signal);
  const rejected = assert.rejects(pending, /STALE_WORKSPACE/);
  let done = false; const closing = g.controller.dispose().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  g.finish(); await rejected; await closing; assert.deepEqual(g.removals, ['key']);
  const unready = createHiddenContentController(() => null, () => {});
  assert.equal(unready.snapshot().available, false); await unready.dispose();
});

test('hidden-content IPC accepts only a bound boolean decision without CSS, selectors or paths', () => {
  const valid = {kind:'hidden-content',documentId:randomUUID(),stateRevision:7,enabled:true};
  assert.equal(isDesktopCommand(valid), true);
  for (const value of [{...valid,css:'*{}'}, {...valid,selector:'body'}, {...valid,path:'page.html'},
    {...valid,enabled:1}, {...valid,documentId:'other'}, {...valid,stateRevision:0}]) assert.equal(isDesktopCommand(value), false);
});
