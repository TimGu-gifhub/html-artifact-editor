import { setTimeout as delay } from 'node:timers/promises';
import type { WebContents } from 'electron';

// A visible native view can briefly lack a composited frame after resize/show.
// Retry only that transient Viz error, and still require a real nonempty capture.
export async function captureReady(contents: WebContents): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const image = await contents.capturePage();
      if (image.isEmpty()) throw new Error('EMPTY_CAPTURE');
      return image.toPNG();
    } catch (error) {
      if (!String(error).includes('UnknownVizError') || attempt === 7) throw error;
      await delay(250);
    }
  }
  throw new Error('CAPTURE_FAILED');
}
