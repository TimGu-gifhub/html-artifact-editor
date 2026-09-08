// Only a startup diagnostic; no project, selection or file capabilities yet.
export const BOOTSTRAP_CHANNEL = 'hae:bootstrap-ready';
export const CONTRACT_VERSION = 1;

export type Surface = 'ui' | 'preview';

export type BootstrapReady = Readonly<{
  contractVersion: 1;
  surface: Surface;
  sandboxed: true;
  contextIsolated: true;
}>;

export type EditorBootstrap = Readonly<{
  contractVersion: 1;
  stage: 'toolchain';
}>;

export function isBootstrapReady(value: unknown): value is BootstrapReady {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4
    && record.contractVersion === CONTRACT_VERSION
    && (record.surface === 'ui' || record.surface === 'preview')
    && record.sandboxed === true
    && record.contextIsolated === true;
}
