import { isMappingApply, isMappingApplyResult } from './mapping.ts';
import type { MappingApply, MappingApplyResult } from './mapping.ts';

export const MAPPING_HISTORY = 'hae:mapping-history';
export const MAPPING_HISTORY_RESULT = 'hae:mapping-history-result';
// A prepared Main history transition owns its target independently of native
// selection. It still binds the exact current mapping revision and plain text.
export type MappingHistory = MappingApply;
export type MappingHistoryResult = MappingApplyResult;
export function isMappingHistory(value: unknown): value is MappingHistory {
  return isMappingApply(value) && value.revision < Number.MAX_SAFE_INTEGER && value.expectedText !== value.newText;
}
export const isMappingHistoryResult = isMappingApplyResult;
