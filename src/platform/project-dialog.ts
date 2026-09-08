import { dialog } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';

// Trusted native chooser for the separate HAE-002 verification tool.
export async function selectPreviewFile(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: '只读预览：选择 HTML，并授权其所在文件夹内的预览资源',
    properties: ['openFile'], filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

// Native OS adapters. Paths remain in Main; defaultPath is a convenience, never
// authorization. Main revalidates the selected file against its retained root.
export function projectDialogs(parent?: BrowserWindow) {
  const choose = async (options: OpenDialogOptions): Promise<string | undefined> => {
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  };
  return Object.freeze({
    chooseDirectory: () => choose({ title: '选择项目文件夹：授权其中允许的预览资源', properties: ['openDirectory'] }),
    chooseEntry: (directory: string) => choose({ title: '选择项目文件夹内的 HTML 入口', defaultPath: directory,
      properties: ['openFile'], filters: [{ name: 'HTML', extensions: ['html', 'htm'] }] }),
  });
}
