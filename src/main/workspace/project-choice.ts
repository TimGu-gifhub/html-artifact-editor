import { authorizeDirectory, authorizeProject } from '../protocol/project-files.ts';
import type { DirectoryGrant, ProjectGrant } from '../protocol/project-files.ts';

export type ProjectChoices = Readonly<{
  chooseDirectory: () => Promise<string | undefined>;
  chooseEntry: (directory: string) => Promise<string | undefined>;
}>;
export async function chooseProjectEntry(root: DirectoryGrant, choose: ProjectChoices['chooseEntry'],
  signal: AbortSignal): Promise<ProjectGrant | undefined> {
  signal.throwIfAborted();
  const entry = await choose(root.root); signal.throwIfAborted();
  if (!entry) return undefined;
  const result = await authorizeProject(entry, [], root); signal.throwIfAborted();
  return result;
}
export async function chooseProjectDirectory(choices: ProjectChoices, signal: AbortSignal,
  blockedRoots: readonly string[]): Promise<ProjectGrant | undefined> {
  signal.throwIfAborted();
  const selected = await choices.chooseDirectory(); signal.throwIfAborted();
  if (!selected) return undefined;
  const root = await authorizeDirectory(selected, blockedRoots); signal.throwIfAborted();
  return chooseProjectEntry(root, choices.chooseEntry, signal);
}
