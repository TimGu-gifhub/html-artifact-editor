export const PREVIEW_READY_CHANNEL = 'hae:preview-ready';
export const PRESENTATION_INTERACTION = 'hae:presentation-interaction';
export const PREVIEW_ARGUMENT = '--hae-preview=';
export type PreviewMode = 'proofread' | 'interactive';

export type PreviewIdentity = Readonly<{
  version: 1;
  sessionId: string;
  generation: number;
  mode: PreviewMode;
}>;
export type PreviewReady = PreviewIdentity & Readonly<{
  sandboxed: true;
  contextIsolated: true;
  readOnly: true;
}>;

export function isPreviewIdentity(value: unknown): value is PreviewIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 4 && v.version === 1
    && typeof v.sessionId === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.sessionId)
    && Number.isSafeInteger(v.generation) && (v.generation as number) > 0
    && (v.mode === 'proofread' || v.mode === 'interactive');
}

export function isPreviewReady(value: unknown): value is PreviewReady {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 7 && isPreviewIdentity({
    version: v.version, sessionId: v.sessionId, generation: v.generation, mode: v.mode,
  }) && v.sandboxed === true && v.contextIsolated === true && v.readOnly === true;
}
