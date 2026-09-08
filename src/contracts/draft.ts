import { isMappingSelection } from './mapping.ts';
import type { MappingSelection } from './mapping.ts';

export type DraftApply = Readonly<{ selection: MappingSelection; draftRevision: number; newText: string }>;
export function isDraftApply(value: unknown): value is DraftApply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 3 && isMappingSelection(input.selection)
    && Number.isSafeInteger(input.draftRevision) && (input.draftRevision as number) > 0
    && typeof input.newText === 'string' && input.newText.length <= 128 * 1024;
}
