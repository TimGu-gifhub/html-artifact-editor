import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { isDesktopCommand } from '../../src/contracts/desktop.ts';
import { isWorkspaceCommand } from '../../src/contracts/workspace-editor.ts';

test('desktop controls accept bounded layout, exact reviews and fixed PDF options without URL/path/force authority', () => {
  const documentId = randomUUID(); const id = randomUUID(); const draftRevision = 2; const candidateHash = 'a'.repeat(64);
  const valid = [
    { kind: 'layout', x: 0, y: 60, width: 900, height: 600, visible: true },
    { kind: 'panel', mode: 'floating' }, { kind: 'flushed', id, ready: false }, { kind: 'flush-input' },
    { kind: 'review', documentId, draftRevision, candidateHash, nodeIds: ['n1', 'n2'] },
    { kind: 'pdf-create', documentId, draftRevision, candidateHash, options: { paper: 'A4', landscape: false, background: true } },
    { kind: 'pdf-export', id }, { kind: 'pdf-show', id }, { kind: 'pdf-close' },
  ];
  for (const value of valid) {
    assert.ok(isDesktopCommand(value)); assert.ok(isWorkspaceCommand({ kind: 'desktop', value }));
    assert.equal(isDesktopCommand({ ...value, path: 'outside.pdf' }), false);
  }
  const invalid = [null, [], {}, { kind: 'quit', force: true }, { kind: 'pdf-export', id, bytes: [] },
    { kind: 'pdf-show', id: 'file:///outside.pdf' }, { kind: 'panel', mode: 'external' },
    { ...valid[0], x: -1 }, { ...valid[0], x: 1.5 }, { ...valid[0], width: 16385 }, { ...valid[0], visible: 1 },
    { ...valid[4], nodeIds: ['n1', 'n1'] }, { ...valid[4], nodeIds: ['../n1'] },
    { ...valid[4], draftRevision: 0 }, { ...valid[4], candidateHash: 'old' },
    { ...valid[5], options: { ...valid[5].options, headerTemplate: '<script>' } },
    { ...valid[5], options: { ...valid[5].options, paper: 'custom' } }, { kind: 'flushed', id, ready: true, documentId },
  ];
  for (const value of invalid) assert.equal(isDesktopCommand(value), false, JSON.stringify(value));
});
