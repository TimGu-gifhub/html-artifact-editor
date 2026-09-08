import { dialog } from 'electron';

// Trusted native chooser for the separate HAE-002 verification tool.
export async function selectPreviewFile(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: '只读预览：选择 HTML，并授权其所在文件夹内的预览资源',
    properties: ['openFile'], filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  return result.canceled ? undefined : result.filePaths[0];
}
