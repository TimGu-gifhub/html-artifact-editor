import assert from 'node:assert/strict';
import type { WorkspaceSnapshot } from '../../src/contracts/workspace.ts';
import type { OpenDocument } from '../../src/main/workspace/document.ts';

// Existing suites exercise static proofreading. Assert that prerequisite at
// their read boundary instead of weakening nullable production types.
export function proofreadDocument(value: OpenDocument | null | undefined) {
  assert.ok(value, 'expected an open proofreading document');
  assert.ok(value.mode === 'proofread', 'static suite unexpectedly entered script-only preview');
  return value;
}
export function proofreadSnapshot(value: WorkspaceSnapshot) {
  if (!value.current) return { ...value, current: null };
  const current = value.current;
  assert.equal(current.mode, 'proofread', 'static suite unexpectedly entered script-only preview');
  assert.ok(current.input, 'proofreading must have its Main input controller');
  return { ...value, current: { ...current, mode: 'proofread' as const, input: current.input } };
}
