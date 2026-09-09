import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { createTextHistory } from '../../core/history/timeline.ts';

try {
  const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  let history = createTextHistory(workerData.bytes, workerData.identity, hash, workerData.checkpoint);
  const command = workerData.command; let changes: unknown = [];
  if (command.kind === 'edit' || command.kind === 'move') {
    const plan = command.kind === 'edit' ? history.prepareEdit(command.change) : history.prepareMove(command.direction);
    changes = plan.changes; history.commit(plan);
  } else if (command.kind === 'saved') history = history.rebaseSaved(command.bytes, command.identity);
  else if (command.kind !== 'read') throw new Error('HISTORY_COMMAND_INVALID');
  parentPort!.postMessage({ ok: true, candidate: history.candidate, checkpoint: history.capture(), changes });
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  parentPort!.postMessage({ ok: false, error: /^[A-Z_]+$/u.test(code) ? code : 'HISTORY_PREPARE_FAILED' });
}
