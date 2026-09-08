import type { EditorBootstrap } from '../contracts/bootstrap.ts';

declare global {
  interface Window {
    readonly haeBootstrap?: EditorBootstrap;
  }
}
