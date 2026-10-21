/**
 * High-performance PDF.js module loader and renderer for EasyNote.
 * Provides worker singleton, local CMap/font configuration for CJK documents,
 * and direct streaming over HTTP Range requests.
 */

export interface PDFJSModule {
  getDocument: any;
  GlobalWorkerOptions: any;
  TextLayer: any;
  version: string;
}

let pdfjsPromise: Promise<PDFJSModule> | null = null;

export function getPDFJS(): Promise<PDFJSModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const workerUrl = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return {
        getDocument: pdfjs.getDocument,
        GlobalWorkerOptions: pdfjs.GlobalWorkerOptions,
        TextLayer: (pdfjs as any).TextLayer,
        version: pdfjs.version,
      };
    })();
  }
  return pdfjsPromise;
}

/**
 * Preloads PDF.js in background / idle time.
 */
export function preloadPdfjs(): void {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => {
      void getPDFJS().catch(() => {});
    });
  } else {
    setTimeout(() => {
      void getPDFJS().catch(() => {});
    }, 1000);
  }
}

export const PDF_CMAP_CONFIG = {
  cMapUrl: '/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/standard_fonts/',
};

export interface LoadPDFParams {
  url?: string;
  blob?: Blob;
  data?: Uint8Array;
  id?: string;
  resolveFile?(id: string): Promise<string | null>;
}

export async function loadPDFDocument({
  url,
  blob,
  data,
  id,
  resolveFile,
}: LoadPDFParams) {
  const { getDocument } = await getPDFJS();

  if (data) {
    const loadingTask = getDocument({
      data,
      ...PDF_CMAP_CONFIG,
    });
    return loadingTask.promise;
  }

  if (blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const loadingTask = getDocument({
      data: new Uint8Array(arrayBuffer),
      ...PDF_CMAP_CONFIG,
    });
    return loadingTask.promise;
  }

  if (id && resolveFile) {
    try {
      const cachedUrl = await resolveFile(id);
      if (cachedUrl) {
        const resp = await fetch(cachedUrl);
        const arrayBuffer = await resp.arrayBuffer();
        const loadingTask = getDocument({
          data: new Uint8Array(arrayBuffer),
          ...PDF_CMAP_CONFIG,
        });
        return loadingTask.promise;
      }
    } catch {
      // Fall through to network URL if cached blob fetch fails
    }
  }

  if (url) {
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arrayBuffer = await resp.arrayBuffer();
    const loadingTask = getDocument({
      data: new Uint8Array(arrayBuffer),
      ...PDF_CMAP_CONFIG,
    });
    return loadingTask.promise;
  }

  throw new Error('未提供有效的 PDF 文档来源。');
}
