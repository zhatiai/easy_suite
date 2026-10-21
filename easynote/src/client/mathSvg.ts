import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import type { LiteElement } from 'mathjax-full/js/adaptors/lite/Element.js';

let mathDocument: ReturnType<typeof mathjax.document> | null = null;
let adaptorInstance: ReturnType<typeof liteAdaptor> | null = null;

function getMathJax() {
  if (!mathDocument || !adaptorInstance) {
    adaptorInstance = liteAdaptor();
    RegisterHTMLHandler(adaptorInstance);
    const tex = new TeX({ packages: AllPackages });
    const svg = new SVG({ fontCache: 'none' });
    mathDocument = mathjax.document('', {
      InputJax: tex,
      OutputJax: svg,
    });
  }
  return { mathDocument, adaptor: adaptorInstance };
}

export function texToSvg(source: string, display: boolean): string {
  try {
    const { mathDocument, adaptor } = getMathJax();
    const node = mathDocument.convert(source, { display });
    const svgNode = adaptor.firstChild(node);
    if (!svgNode || adaptor.kind(svgNode) !== 'svg') return '';
    const element = svgNode as unknown as LiteElement;
    adaptor.setAttribute(element, 'color', '#202428');
    adaptor.setAttribute(element, 'xmlns', 'http://www.w3.org/2000/svg');
    return adaptor.outerHTML(element);
  } catch (error) {
    console.warn('MathJax TeX conversion error:', source, error);
    return '';
  }
}

export async function renderMathImage(
  source: string,
  display: boolean,
  scale: number,
  maxPrintableWidthPt: number,
): Promise<{ dataUrl: string; widthPt: number; heightPt: number } | null> {
  try {
    const { mathDocument, adaptor } = getMathJax();
    const node = mathDocument.convert(source, { display });
    const svgNode = adaptor.firstChild(node);
    if (!svgNode || adaptor.kind(svgNode) !== 'svg') return null;
    const element = svgNode as unknown as LiteElement;

    const viewBoxAttr = adaptor.getAttribute(element, 'viewBox') || '';
    const parts = viewBoxAttr.trim().split(/\s+/).map(Number);
    const vbWidth = parts[2] || 1000;
    const vbHeight = parts[3] || 500;

    const baseFontSizePt = 10.5 * scale;
    let widthPt = Math.max(4, (vbWidth / 1000) * baseFontSizePt);
    let heightPt = Math.max(4, (vbHeight / 1000) * baseFontSizePt);

    if (widthPt > maxPrintableWidthPt) {
      const ratio = maxPrintableWidthPt / widthPt;
      widthPt = maxPrintableWidthPt;
      heightPt *= ratio;
    }

    const widthPx = Math.max(1, Math.ceil(widthPt * (96 / 72)));
    const heightPx = Math.max(1, Math.ceil(heightPt * (96 / 72)));

    adaptor.setAttribute(element, 'width', `${widthPx}px`);
    adaptor.setAttribute(element, 'height', `${heightPx}px`);
    adaptor.setAttribute(element, 'color', '#202428');
    adaptor.setAttribute(element, 'xmlns', 'http://www.w3.org/2000/svg');

    const cleanSvg = adaptor.outerHTML(element);
    const blob = new Blob([cleanSvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();

      const renderScale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(widthPx * renderScale);
      canvas.height = Math.ceil(heightPx * renderScale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/png');
      canvas.width = 1;
      canvas.height = 1;
      return {
        dataUrl,
        widthPt: Math.round(widthPt),
        heightPt: Math.round(heightPt),
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    console.warn('Math image render error:', source, error);
    return null;
  }
}
