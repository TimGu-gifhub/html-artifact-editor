export type ResourceKind = 'document' | 'stylesheet' | 'script' | 'image' | 'font' | 'fetch' | 'frame' | 'media' | 'websocket' | 'other';
export type ResourceFailure = 'RESOURCE_BLOCKED' | 'RESOURCE_MISSING' | 'RESOURCE_LIMIT' | 'RESOURCE_CHANGED'
  | 'RESOURCE_READ_FAILED' | 'RESOURCE_LOAD_FAILED' | 'CSP_BLOCKED';
export type ResourceDiagnostic = Readonly<{ id: number; target: string; resourceType: ResourceKind; reason: ResourceFailure }>;
export type ResourceDiagnostics = Readonly<{ items: readonly ResourceDiagnostic[]; truncated: boolean }>;
export type ProjectSummary = Readonly<{ name: string; entry: string; resources: ResourceDiagnostics }>;
