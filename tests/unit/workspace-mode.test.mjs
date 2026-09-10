import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../../src/main/workspace/controller.ts';
import { isWorkspaceCommand } from '../../src/contracts/workspace-editor.ts';

const baseHash = 'a'.repeat(64), dirtyHash = 'b'.repeat(64);
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

async function fixture({ dirty = false, persistent = false } = {}) {
  const calls = { static: 0, interactive: 0, copy: 0, review: 0, retired: [], histories: [] };
  const history = Object.freeze({ record: Object.freeze({ fixture: 'private clean history' }), originBytes: new Uint8Array([1]) });
  const controls = { decision: 'cancel', destination: undefined, copyStatus: 'created', versionChanged: false,
    prepare: async value => value, activate: () => {}, verify: () => {},
    retirement: async () => ({status:'retired',checkpointId:randomUUID(),code:null,cleanupPending:false}) };
  let mounted = null; const docs = [];
  const make = (mode, continuation, hasChanges = false) => {
    const listeners = new Set();
    let state = { stateRevision: 1, phase: 'idle', draftPhase: 'idle', draftRevision: hasChanges ? 2 : 1,
      candidateHash: hasChanges ? dirtyHash : baseHash, input: null, hasUnappliedInput: false, canSaveCopy: true,
      changes: hasChanges ? [{nodeId:'n1',oldText:'original',newText:'draft'}] : [] };
    const value = { id: randomUUID(), mode, name: 'report.html', entry: 'Main-authorized fixture', closed: 0,
      preview: {grant: Object.freeze({root:'authorized root',entry:'report.html'})}, historyContinuation: continuation,
      saveSource: {baseHash, verify: async () => { controls.verify(value); if(controls.versionChanged)throw Error('FILE_CHANGED'); }},
      project: () => ({name:'fixture',entry:'report.html',resources:{items:[],truncated:false}}),
      onState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      update(fields) { state={...state,...fields,stateRevision:state.stateRevision+1}; for(const listener of listeners)listener(); },
      async close() { value.closed++; if(value.failClose)throw Error('cleanup failed'); },
      input: null, writer: null, draft: null, mapping: null, history: null, sourceDiff: null, persistence: null,
      checkpointSessionId: null, verifyRecovery: null,
    };
    if(mode==='proofread') {
      value.writer={}; value.draft={candidate:{resultHash:state.candidateHash,patches:state.changes}};
      value.mapping={status:'ready'}; value.history={available:true,capture:()=>continuation??history};
      value.checkpointSessionId=value.id;
      value.input={
        snapshot:()=>Object.freeze({...state}),
        holdDeparture(revision) {
          assert.equal(state.stateRevision,revision); assert.equal(state.phase,'idle'); value.update({phase:'leaving'});
          return ()=>value.update({phase:'idle'});
        },
        async apply() { value.update({hasUnappliedInput:false}); },
        async saveCopy(_revision,choose) {
          const selected=await choose(); if(!selected)return null;
          calls.copy++; if(controls.copyStatus==='unknown')value.update({draftPhase:'uncertain'}); return {status:controls.copyStatus,expectedHash:state.candidateHash};
        },
      };
      if(persistent) {
        const durable={status:'persisted',persisted:{draftRevision:state.draftRevision,resultHash:state.candidateHash},code:null,cleanupPending:false};
        value.persistence={snapshot:()=>durable,settle:async()=>durable};
      }
    }
    docs.push(value); return value;
  };
  const w=createWorkspace('Main output',{
    review:async review=>{calls.review++;return {reviewId:review.reviewId,decision:controls.decision};},
    chooseCopy:async()=>controls.destination,
  },async (_out,_source,_generation,_signal,_store,_recovery,continuation)=>{
    calls.static++; calls.histories.push(continuation); return controls.prepare(make('proofread',continuation,calls.static===1&&dirty));
  },next=>{
    controls.activate(next); const before=mounted; mounted=next; return ()=>{mounted=before;};
  },undefined,persistent?{retire:async(...args)=>{calls.retired.push(args);return controls.retirement();}}:undefined,
  undefined,async (_out,_source,_generation,_signal,continuation)=>{
    calls.interactive++;return controls.prepare(make('interactive',continuation));
  });
  await w.open(w.snapshot().stateRevision,async()=>'Main authorized file');
  const first=w.current;
  const changeMode=mode=>w.switchMode(w.snapshot().stateRevision,w.current.id,mode);
  return {w,first,controls,calls,docs,history,changeMode,get mounted(){return mounted;}};
}

test('mode commands admit only two modes bound to a document and revision, without path or snapshot authority',()=>{
  const base={kind:'switch-mode',documentId:randomUUID(),stateRevision:1,mode:'interactive'};
  assert.ok(isWorkspaceCommand(base)); assert.ok(isWorkspaceCommand({...base,mode:'proofread'}));
  for(const value of [{...base,mode:'editable-js'},{...base,mode:null},{...base,path:'other.html'},
    {...base,bytes:[]},{...base,history:{}},{...base,stateRevision:0},{...base,documentId:'old'}])
    assert.equal(isWorkspaceCommand(value),false);
});

test('clean mode roundtrip carries only Main history, publishes fresh identities, and exposes no readonly input or write port',{timeout:5000},async()=>{
  const f=await fixture({persistent:true});
  try {
    assert.equal((await f.changeMode('interactive')).state.phase,'idle');
    const readonly=f.w.current;
    assert.equal(readonly.mode,'interactive'); assert.equal(readonly.historyContinuation,f.history);
    assert.equal(f.w.snapshot().current.input,null); assert.equal(f.w.snapshot().current.persistence,null);
    assert.equal(f.w.snapshot().canSave,false); assert.equal(readonly.writer,null); assert.equal(readonly.mapping,null);
    assert.equal(f.first.closed,1); assert.equal(f.calls.review,0); assert.equal(f.calls.retired.length,0);
    await assert.rejects(f.w.save(f.w.snapshot().stateRevision,readonly.id),/READ_ONLY_MODE/);
    await assert.rejects(f.w.restoreBackup(f.w.snapshot().stateRevision,readonly.id,{}),/READ_ONLY_MODE/);
    await assert.rejects(f.w.readDiff(readonly.id,1,baseHash),/READ_ONLY_MODE/);
    assert.throws(()=>f.w.retryPersistence(readonly.id,1),/READ_ONLY_MODE/);
    assert.equal((await f.changeMode('proofread')).status,'opened');
    assert.equal(f.calls.histories.at(-1),f.history); assert.equal(readonly.closed,1);
    assert.notEqual(f.w.current.id,f.first.id); assert.equal(f.w.current.mode,'proofread');
    await assert.rejects(f.w.switchMode(f.w.snapshot().stateRevision,readonly.id,'interactive'),/STALE_DOCUMENT/);
    const count=f.calls.interactive;
    assert.equal((await f.changeMode('proofread')).state.phase,'idle'); assert.equal(f.calls.interactive,count);
  } finally { await f.w.dispose(); }
});

test('dirty cancellation and unsuccessful copies stop before script preparation and retain the draft',{timeout:5000},async()=>{
  for(const situation of ['cancel','copy-cancel','copy-failed','copy-unknown']) {
    const f=await fixture({dirty:true,persistent:true});
    try {
      f.controls.decision=situation==='cancel'?'cancel':'save-copy';
      f.controls.destination=situation==='copy-cancel'?undefined:'new sibling file';
      f.controls.copyStatus=situation==='copy-unknown'?'unknown':situation==='copy-failed'?'failed':'created';
      if(situation==='copy-failed'||situation==='copy-unknown')await assert.rejects(f.changeMode('interactive'),/COPY_FAILED|COPY_OUTCOME_UNKNOWN/);
      else assert.equal((await f.changeMode('interactive')).status,'cancelled');
      assert.equal(f.calls.interactive,0); assert.equal(f.calls.retired.length,0); assert.equal(f.w.current,f.first);
      assert.equal(f.first.input.snapshot().changes.length,1); assert.equal(f.first.closed,0);
      assert.equal(f.w.snapshot().phase,'idle');
    } finally { await f.w.dispose(); }
  }
});

test('explicit discard or verified copy retires the old durable sequence and does not carry its dirty history',{timeout:5000},async()=>{
  for(const decision of ['discard','save-copy']) {
    const f=await fixture({dirty:true,persistent:true});
    try {
      f.controls.decision=decision; f.controls.destination='new sibling file';
      assert.equal((await f.changeMode('interactive')).status,'opened');
      assert.equal(f.w.current.historyContinuation,undefined); assert.equal(f.calls.copy,decision==='save-copy'?1:0);
      assert.equal(f.calls.retired.length,1); assert.equal(f.calls.retired[0][1],f.first.id);
      assert.equal(f.calls.retired[0][3],decision==='save-copy'?'copied':'discarded');
      await f.changeMode('proofread'); assert.equal(f.calls.histories.at(-1),undefined);
      assert.equal(f.w.current.input.snapshot().changes.length,0);
    } finally { await f.w.dispose(); }
  }
});

test('late input or revoked UI during mode preparation closes the candidate and never replaces the old document',{timeout:5000},async()=>{
  for(const fault of ['input','revoke']) {
    const f=await fixture(); const waiting=gate(),started=gate();
    try {
      f.controls.prepare=async value=>{started.resolve();await waiting.promise;return value;};
      const pending=f.changeMode('interactive'); await started.promise;
      if(fault==='input')f.first.update({hasUnappliedInput:true,input:{text:'newly retained input',composing:false}});
      else f.w.cancelPending();
      waiting.resolve(); await assert.rejects(pending,/STALE_DOCUMENT_REVIEW|WORKSPACE_CANCELLED/);
      assert.equal(f.w.current,f.first); assert.equal(f.mounted,f.first);
      assert.equal(f.first.closed,0); assert.equal(f.docs.at(-1).closed,1);
      if(fault==='input')assert.equal(f.first.input.snapshot().input.text,'newly retained input');
    } finally { waiting.resolve(); await f.w.dispose(); }
  }
});

test('source version or native staging failure rolls back before retirement and releases the input hold',{timeout:5000},async()=>{
  for(const fault of ['before','staged','activation']) {
    const f=await fixture({persistent:true});
    try {
      if(fault==='before')f.controls.versionChanged=true;
      else f.controls.activate=next=>{
        if(next?.mode==='interactive') {
          if(fault==='activation')throw Error('DOCUMENT_ACTIVATION_FAILED');
          f.controls.versionChanged=true;
        }
      };
      await assert.rejects(f.changeMode('interactive'),/FILE_CHANGED|DOCUMENT_ACTIVATION_FAILED/);
      assert.equal(f.w.current,f.first); assert.equal(f.mounted,f.first); assert.equal(f.first.closed,0);
      assert.equal(f.first.input.snapshot().phase,'idle'); assert.equal(f.calls.retired.length,0);
      assert.equal(f.calls.interactive,fault==='before'?0:1);
    } finally { await f.w.dispose(); }
  }
});

test('unknown retirement retains the frozen old draft and source, with no automatic retry or replacement',{timeout:5000},async()=>{
  const f=await fixture({dirty:true,persistent:true});
  try {
    f.controls.decision='discard';
    f.controls.retirement=async()=>({status:'unknown',checkpointId:null,code:'DRAFT_RETIREMENT_UNKNOWN',cleanupPending:true});
    await assert.rejects(f.changeMode('interactive'),/DRAFT_RETIREMENT_UNKNOWN/);
    assert.equal(f.w.current,f.first); assert.equal(f.mounted,f.first); assert.equal(f.first.closed,0);
    assert.equal(f.first.input.snapshot().phase,'leaving'); assert.equal(f.first.input.snapshot().candidateHash,dirtyHash);
    assert.equal(f.w.snapshot().lastDeparture.requiresReview,true); assert.equal(f.docs.at(-1).closed,1);
    await assert.rejects(f.changeMode('interactive'),/DOCUMENT_CLEANUP_REQUIRED|DOCUMENT_RECOVERY_REQUIRED/);
    assert.equal(f.calls.retired.length,1);
  } finally { await f.w.dispose(); }
});

test('failed candidate cleanup keeps evidence and blocks more views; readonly close needs no fabricated input',{timeout:5000},async()=>{
  const f=await fixture();
  try {
    f.controls.prepare=async value=>{value.failClose=true;f.w.cancelPending();return value;};
    await assert.rejects(f.changeMode('interactive'),/WORKSPACE_CANCELLED/);
    assert.equal(f.w.current,f.first); assert.equal(f.w.snapshot().cleanupPending,true);
    await assert.rejects(f.changeMode('interactive'),/DOCUMENT_CLEANUP_REQUIRED/);
  } finally { await f.w.dispose(); }
  const clean=await fixture();
  try {
    await clean.changeMode('interactive'); const readonly=clean.w.current;
    assert.equal((await clean.w.requestClose(clean.w.snapshot().stateRevision)).status,'closed');
    assert.equal(clean.w.current,null); assert.equal(readonly.closed,1); assert.equal(clean.calls.review,0);
  } finally { await clean.w.dispose(); }
});
