import { ipcRenderer } from 'electron';
import { BOOTSTRAP_CHANNEL, CONTRACT_VERSION } from '../contracts/bootstrap.ts';
import { isPreviewIdentity, PREVIEW_ARGUMENT, PREVIEW_READY_CHANNEL } from '../contracts/preview.ts';
import { isMappingCheck, isMappingIdentity, MAPPING_CHECK, MAPPING_CHECK_RESULT, MAPPING_EVENT, MAPPING_INSTALL, MAPPING_REVOKE, sameMapping } from '../contracts/mapping.ts';
import type { MappingIdentity, MappingInstall } from '../contracts/mapping.ts';
import { MAX_TREE_NODES } from '../contracts/source-tree.ts';
import { createNodeRegistry } from '../preview/node-registry.ts';

// Runs in the isolated world. Deliberately exposes nothing to the page world.
const argument = process.argv.find((value) => value.startsWith(PREVIEW_ARGUMENT));
if (argument) {
  const identity: unknown = JSON.parse(argument.slice(PREVIEW_ARGUMENT.length));
  if (!isPreviewIdentity(identity)) throw new Error('INVALID_PREVIEW_IDENTITY');
  if (identity.mode === 'proofread') {
    let registry: ReturnType<typeof createNodeRegistry> | undefined;
    let mappingIdentity: MappingIdentity | undefined;
    let installed = false;
    let changedBeforeBinding = false;
    const earlyObserver = new MutationObserver(() => { changedBeforeBinding = true; });
    const watchParsedTree = (): void => {
      earlyObserver.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      const roots: ParentNode[] = [document];
      while (roots.length) {
        for (const template of roots.pop()!.querySelectorAll('template')) {
          earlyObserver.observe(template.content, { subtree: true, childList: true, characterData: true, attributes: true });
          roots.push(template.content);
        }
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchParsedTree, { once: true });
    else watchParsedTree();
    ipcRenderer.on(MAPPING_INSTALL, (_event, message: MappingInstall) => {
      if (installed || !isMappingIdentity(message?.identity) || !Array.isArray(message.tree)
        || message.tree.length > MAX_TREE_NODES || document.readyState === 'loading'
        || message.identity.preview.sessionId !== identity.sessionId
        || message.identity.preview.generation !== identity.generation) return;
      installed = true;
      mappingIdentity = message.identity;
      changedBeforeBinding ||= earlyObserver.takeRecords().length > 0;
      earlyObserver.disconnect();
      if (changedBeforeBinding) {
        ipcRenderer.send(MAPPING_EVENT, { identity: message.identity, revision: 1, kind: 'invalidated', reason: 'DOM_MUTATED' });
        return;
      }
      registry = createNodeRegistry(document, message.identity, message.tree,
        (event) => ipcRenderer.send(MAPPING_EVENT, event));
    });
    ipcRenderer.on(MAPPING_CHECK, (_event, request: unknown) => {
      if (!isMappingCheck(request)) return;
      ipcRenderer.send(MAPPING_CHECK_RESULT, { ...request, valid: registry?.check(request) ?? false });
    });
    ipcRenderer.on(MAPPING_REVOKE, (_event, value: unknown) => {
      if (mappingIdentity && isMappingIdentity(value) && sameMapping(mappingIdentity, value)) registry?.close();
    });
    window.addEventListener('pagehide', () => registry?.close(), { once: true });
  }
  ipcRenderer.send(PREVIEW_READY_CHANNEL, {
    ...identity, sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, readOnly: true,
  });
} else {
  ipcRenderer.send(BOOTSTRAP_CHANNEL, {
    contractVersion: CONTRACT_VERSION, surface: 'preview',
    sandboxed: process.sandboxed, contextIsolated: process.contextIsolated,
  });
}
