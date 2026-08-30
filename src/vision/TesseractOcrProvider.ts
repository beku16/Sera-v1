import { createWorker, PSM, Worker as TesseractWorker } from 'tesseract.js';
import { ocrDataDir } from '../local/SERAPaths';
import { ScreenFrame } from '../actions/ControlProviders';
import { OcrProvider, OcrWord } from './types';
import { rawBgraFrameToPng } from './screenImage';

export class TesseractOcrProvider implements OcrProvider {
  // Memoise the FULL init promise (createWorker + setParameters) so that
  // concurrent callers share a single init rather than stampeding the
  // worker pool. The previous implementation set `workerPromise` to the
  // createWorker() promise before awaiting `setParameters`, so a concurrent
  // caller could call `worker.recognize()` before `setParameters` had
  // resolved — leading to intermittent OCR failures with "setParameters
  // not allowed after recognize" errors.
  private workerPromise: Promise<TesseractWorker> | null = null;

  private async worker(): Promise<TesseractWorker> {
    if (!this.workerPromise) {
      // Chain the init steps into a single promise that's only resolved
      // once `setParameters` has finished. Concurrent callers all await the
      // same promise and only proceed once init is truly complete.
      this.workerPromise = (async () => {
        // v1.9.0 (BUG L9): explicit langPath/cachePath in the per-user OCR dir.
        const w = await createWorker('eng', 1, {
          langPath: ocrDataDir(),
          cachePath: ocrDataDir(),
          gzip: false,
        });
        await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        return w;
      })().catch((err) => {
        // If init failed, clear the memoised promise so the next caller
        // can retry from scratch instead of being stuck with a rejected
        // promise forever.
        this.workerPromise = null;
        throw err;
      });
    }
    return this.workerPromise;
  }

  public async recognize(frame: ScreenFrame): Promise<OcrWord[]> {
    const worker = await this.worker();
    const png = rawBgraFrameToPng(frame);
    const result = await worker.recognize(png, {}, { blocks: true });
    const words = (result.data.blocks || []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)));
    return words
      .filter((word) => word.text.trim().length > 0)
      .map((word) => ({
        text: word.text.trim(),
        confidence: Math.max(0, Math.min(1, word.confidence / 100)),
        bbox: { x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 },
      }));
  }

  public async close(): Promise<void> {
    if (this.workerPromise) {
      const promise = this.workerPromise;
      this.workerPromise = null;
      try {
        const worker = await promise;
        await worker.terminate();
      } catch {
        // Already terminated or never initialised — nothing to do.
      }
    }
  }
}
