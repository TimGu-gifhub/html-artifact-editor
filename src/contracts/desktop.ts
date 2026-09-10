import { isDiffReview } from './source-diff.ts';
import type { WorkspaceResult } from './workspace-editor.ts';

export type PanelMode = 'docked' | 'hidden' | 'floating';
export type PdfOptions = Readonly<{ paper: 'A4' | 'Letter'; landscape: boolean; background: boolean }>;
export type PdfPreview = Readonly<{
  id: string; name: string; documentId: string; draftRevision: number; candidateHash: string;
  size: number; dirty: boolean; options: PdfOptions;
}>;
export type DesktopState = Readonly<{
  revision: number; role: 'main' | 'editor'; panel: PanelMode; reviewed: readonly string[];
  flush: Readonly<{ id: string; action: 'close' | 'dock' | 'action' }> | null;
  pdf: PdfPreview | null; pdfBusy: boolean; error: string | null;
  pdfExport: Readonly<{ status: 'created' | 'cancelled' | 'failed' | 'unknown'; name: string | null; code: string | null }> | null;
}>;
export type DesktopCommand = Readonly<{ kind: 'layout'; x: number; y: number; width: number; height: number; visible: boolean }>
  | Readonly<{ kind: 'panel'; mode: PanelMode }>
  | Readonly<{ kind: 'review'; documentId: string; draftRevision: number; candidateHash: string; nodeIds: readonly string[] }>
  | Readonly<{ kind: 'flushed'; id: string; ready: boolean }>
  | Readonly<{ kind: 'pdf-create'; documentId: string; draftRevision: number; candidateHash: string; options: PdfOptions }>
  | Readonly<{ kind: 'pdf-export' | 'pdf-show'; id: string }>
  | Readonly<{ kind: 'pdf-close' | 'flush-input' }>;
export type DesktopAPI = Readonly<{ request: (command: DesktopCommand) => Promise<WorkspaceResult> }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export function isPdfOptions(value: unknown): value is PdfOptions {
  return object(value) && Object.keys(value).length === 3 && (value.paper === 'A4' || value.paper === 'Letter')
    && typeof value.landscape === 'boolean' && typeof value.background === 'boolean';
}
export function isDesktopCommand(value: unknown): value is DesktopCommand {
  if (!object(value)) return false;
  const count = Object.keys(value).length;
  switch (value.kind) {
    case 'layout': return count === 6 && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key])
      && (value[key] as number) >= 0 && (value[key] as number) <= 16384) && typeof value.visible === 'boolean';
    case 'panel': return count === 2 && ['docked', 'hidden', 'floating'].includes(value.mode as string);
    case 'review': return count === 5 && uuid(value.documentId) && isDiffReview({ draftRevision: value.draftRevision, candidateHash: value.candidateHash })
      && Array.isArray(value.nodeIds) && value.nodeIds.length <= 10000 && new Set(value.nodeIds).size === value.nodeIds.length
      && value.nodeIds.every(id => typeof id === 'string' && /^n[0-9]{1,6}$/u.test(id));
    case 'flushed': return count === 3 && uuid(value.id) && typeof value.ready === 'boolean';
    case 'pdf-create': return count === 5 && uuid(value.documentId) && isDiffReview({ draftRevision: value.draftRevision, candidateHash: value.candidateHash }) && isPdfOptions(value.options);
    case 'pdf-export':
    case 'pdf-show': return count === 2 && uuid(value.id);
    case 'pdf-close': return count === 1;
    case 'flush-input': return count === 1;
    default: return false;
  }
}
