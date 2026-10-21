import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  Highlighter,
  MessageSquareText,
  PenLine,
  Copy,
  Check,
} from 'lucide-react';
import { t } from './i18n';
import {
  type AnnotationColor,
  type PdfAnnotation,
  type PdfAnnotationRect,
  ANNOTATION_COLORS,
} from './annotations';
import { getPDFJS } from './pdfjs';

export interface PdfContinuousViewerHandle {
  scrollToPage(pageNumber: number): void;
}

interface PdfContinuousViewerProps {
  pdfDoc: any;
  numPages: number;
  scale: number;
  annotations: PdfAnnotation[];
  activeAnnotationId: string | null;
  annotationMode: 'select' | 'area';
  filename: string;
  onVisiblePageChange(pageNumber: number): void;
  onAddHighlight(page: number, color: AnnotationColor, text: string, rects: PdfAnnotationRect[]): void;
  onOpenComment(page: number, text: string, rects: PdfAnnotationRect[], type: 'highlight' | 'area'): void;
  onInsertToNote?(markdown: string): void;
  onCopyQuote?(markdown: string): void;
  onAnnotationClick?(id: string): void;
}

export const PdfContinuousViewer = forwardRef<PdfContinuousViewerHandle, PdfContinuousViewerProps>(
  function PdfContinuousViewer(
    {
      pdfDoc,
      numPages,
      scale,
      annotations,
      activeAnnotationId,
      annotationMode,
      filename,
      onVisiblePageChange,
      onAddHighlight,
      onOpenComment,
      onInsertToNote,
      onCopyQuote,
      onAnnotationClick,
    },
    ref
  ) {
    const pageRefs = useRef<{ [page: number]: HTMLDivElement | null }>({});
    const containerRef = useRef<HTMLDivElement>(null);

    // Global selected text state across pages
    const [selectedRange, setSelectedRange] = useState<{
      page: number;
      text: string;
      rects: PdfAnnotationRect[];
      toolbarPos: { x: number; y: number };
    } | null>(null);

    // Area drag state
    const [areaDrag, setAreaDrag] = useState<{
      page: number;
      start: { x: number; y: number };
      currentRect: PdfAnnotationRect;
    } | null>(null);

    // Default page dimensions (measured from page 1)
    const [baseDimensions, setBaseDimensions] = useState<{ width: number; height: number }>({
      width: 595,
      height: 842,
    });

    useEffect(() => {
      if (!pdfDoc) return;
      void pdfDoc.getPage(1).then((firstPage: any) => {
        const vp = firstPage.getViewport({ scale: 1 });
        setBaseDimensions({ width: vp.width, height: vp.height });
      });
    }, [pdfDoc]);

    useImperativeHandle(ref, () => ({
      scrollToPage(pageNumber: number) {
        const el = pageRefs.current[pageNumber];
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      },
    }));

    // Clear selection on global mouse click outside
    useEffect(() => {
      const handleGlobalClick = (e: MouseEvent) => {
        if ((e.target as HTMLElement)?.closest('.pdf-floating-selection-toolbar')) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          setSelectedRange(null);
        }
      };
      window.addEventListener('mousedown', handleGlobalClick);
      return () => window.removeEventListener('mousedown', handleGlobalClick);
    }, []);

    const handleTextSelectionOnPage = (pageNumber: number, pageEl: HTMLElement) => {
      if (annotationMode === 'area') return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSelectedRange(null);
        return;
      }
      const text = selection.toString().trim();
      if (!text) {
        setSelectedRange(null);
        return;
      }

      const pageRect = pageEl.getBoundingClientRect();
      const range = selection.getRangeAt(0);
      const clientRects = Array.from(range.getClientRects());
      if (!clientRects.length) return;

      const relativeRects: PdfAnnotationRect[] = clientRects
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({
          x: Math.max(0, Math.min(100, ((r.left - pageRect.left) / pageRect.width) * 100)),
          y: Math.max(0, Math.min(100, ((r.top - pageRect.top) / pageRect.height) * 100)),
          width: Math.max(0, Math.min(100, (r.width / pageRect.width) * 100)),
          height: Math.max(0, Math.min(100, (r.height / pageRect.height) * 100)),
        }));

      if (!relativeRects.length) return;

      const firstRect = clientRects[0];
      const toolbarX = Math.max(
        10,
        Math.min(pageRect.width - 240, (firstRect.left + firstRect.right) / 2 - pageRect.left - 100)
      );
      const toolbarY = Math.max(10, firstRect.top - pageRect.top - 46);

      setSelectedRange({
        page: pageNumber,
        text,
        rects: relativeRects,
        toolbarPos: { x: toolbarX, y: toolbarY },
      });
    };

    // Area drag handlers
    const handleAreaMouseDown = (e: React.MouseEvent, pageNumber: number, pageEl: HTMLElement) => {
      if (annotationMode !== 'area' || e.button !== 0) return;
      e.preventDefault();
      const rect = pageEl.getBoundingClientRect();
      const startX = ((e.clientX - rect.left) / rect.width) * 100;
      const startY = ((e.clientY - rect.top) / rect.height) * 100;
      setAreaDrag({
        page: pageNumber,
        start: { x: startX, y: startY },
        currentRect: { x: startX, y: startY, width: 0, height: 0 },
      });
    };

    const handleAreaMouseMove = (e: React.MouseEvent, pageEl: HTMLElement) => {
      if (!areaDrag) return;
      const rect = pageEl.getBoundingClientRect();
      const currentX = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const currentY = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
      const x = Math.min(areaDrag.start.x, currentX);
      const y = Math.min(areaDrag.start.y, currentY);
      const width = Math.abs(currentX - areaDrag.start.x);
      const height = Math.abs(currentY - areaDrag.start.y);

      setAreaDrag((prev) => (prev ? { ...prev, currentRect: { x, y, width, height } } : null));
    };

    const handleAreaMouseUp = (pageNumber: number) => {
      if (!areaDrag || areaDrag.page !== pageNumber) return;
      const { currentRect } = areaDrag;
      setAreaDrag(null);
      if (currentRect.width > 2 && currentRect.height > 2) {
        onOpenComment(pageNumber, '', [currentRect], 'area');
      }
    };

    return (
      <div className="pdf-continuous-scroll-viewport" ref={containerRef}>
        <div className="pdf-pages-column">
          {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
            <PdfContinuousPageItem
              key={pageNum}
              pageNumber={pageNum}
              pdfDoc={pdfDoc}
              scale={scale}
              baseDimensions={baseDimensions}
              annotations={annotations.filter((a) => a.page === pageNum)}
              activeAnnotationId={activeAnnotationId}
              annotationMode={annotationMode}
              filename={filename}
              selectedRange={selectedRange?.page === pageNum ? selectedRange : null}
              areaRect={areaDrag?.page === pageNum ? areaDrag.currentRect : null}
              onVisible={onVisiblePageChange}
              onTextSelection={handleTextSelectionOnPage}
              onAreaMouseDown={handleAreaMouseDown}
              onAreaMouseMove={handleAreaMouseMove}
              onAreaMouseUp={handleAreaMouseUp}
              onAnnotationClick={onAnnotationClick}
              onAddHighlight={(color, text, rects) => {
                onAddHighlight(pageNum, color, text, rects);
                setSelectedRange(null);
              }}
              onOpenComment={(text, rects, type) => {
                onOpenComment(pageNum, text, rects, type);
                setSelectedRange(null);
              }}
              onInsertToNote={(md) => {
                onInsertToNote?.(md);
                setSelectedRange(null);
              }}
              onCopyQuote={(md) => {
                onCopyQuote?.(md);
                setSelectedRange(null);
              }}
              ref={(el) => {
                pageRefs.current[pageNum] = el;
              }}
            />
          ))}
        </div>
      </div>
    );
  }
);

interface PdfContinuousPageItemProps {
  pageNumber: number;
  pdfDoc: any;
  scale: number;
  baseDimensions: { width: number; height: number };
  annotations: PdfAnnotation[];
  activeAnnotationId: string | null;
  annotationMode: 'select' | 'area';
  filename: string;
  selectedRange: {
    page: number;
    text: string;
    rects: PdfAnnotationRect[];
    toolbarPos: { x: number; y: number };
  } | null;
  areaRect: PdfAnnotationRect | null;
  onVisible(pageNumber: number): void;
  onTextSelection(pageNumber: number, el: HTMLElement): void;
  onAreaMouseDown(e: React.MouseEvent, pageNumber: number, el: HTMLElement): void;
  onAreaMouseMove(e: React.MouseEvent, el: HTMLElement): void;
  onAreaMouseUp(pageNumber: number): void;
  onAnnotationClick?(id: string): void;
  onAddHighlight(color: AnnotationColor, text: string, rects: PdfAnnotationRect[]): void;
  onOpenComment(text: string, rects: PdfAnnotationRect[], type: 'highlight' | 'area'): void;
  onInsertToNote?(markdown: string): void;
  onCopyQuote?(markdown: string): void;
}

const PdfContinuousPageItem = forwardRef<HTMLDivElement, PdfContinuousPageItemProps>(
  function PdfContinuousPageItem(
    {
      pageNumber,
      pdfDoc,
      scale,
      baseDimensions,
      annotations,
      activeAnnotationId,
      annotationMode,
      filename,
      selectedRange,
      areaRect,
      onVisible,
      onTextSelection,
      onAreaMouseDown,
      onAreaMouseMove,
      onAreaMouseUp,
      onAnnotationClick,
      onAddHighlight,
      onOpenComment,
      onInsertToNote,
      onCopyQuote,
    },
    ref
  ) {
    const itemRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textLayerRef = useRef<HTMLDivElement>(null);
    const renderTaskRef = useRef<any>(null);

    const [shouldRender, setShouldRender] = useState<boolean>(pageNumber <= 2);
    const [pageRendered, setPageRendered] = useState<boolean>(false);
    const [copyFeedback, setCopyFeedback] = useState<boolean>(false);

    // Merge forwarded ref and local ref
    useImperativeHandle(ref, () => itemRef.current!);

    // Lazy load observer: triggers rendering when page is near viewport
    useEffect(() => {
      const el = itemRef.current;
      if (!el) return;

      const renderObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setShouldRender(true);
            }
          }
        },
        { rootMargin: '600px 0px 600px 0px' }
      );

      const visibilityObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.4) {
              onVisible(pageNumber);
            }
          }
        },
        { threshold: [0.4] }
      );

      renderObserver.observe(el);
      visibilityObserver.observe(el);

      return () => {
        renderObserver.disconnect();
        visibilityObserver.disconnect();
      };
    }, [pageNumber, onVisible]);

    // Render Canvas & TextLayer when shouldRender becomes true or scale changes
    useEffect(() => {
      if (!shouldRender || !pdfDoc) return;
      let cancelled = false;

      const renderPage = async () => {
        try {
          if (renderTaskRef.current) {
            try {
              renderTaskRef.current.cancel();
            } catch {}
          }

          const page = await pdfDoc.getPage(pageNumber);
          if (cancelled) return;

          const viewport = page.getViewport({ scale });
          const canvas = canvasRef.current;
          if (!canvas) return;

          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;

          const ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
          if (!ctx) return;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

          const renderTask = page.render({ canvasContext: ctx, viewport });
          renderTaskRef.current = renderTask;

          const textLayerDiv = textLayerRef.current;
          const textContentPromise = textLayerDiv ? page.getTextContent() : null;

          await renderTask.promise;
          if (cancelled) return;
          setPageRendered(true);

          if (textLayerDiv && textContentPromise) {
            textLayerDiv.innerHTML = '';
            textLayerDiv.style.width = `${Math.floor(viewport.width)}px`;
            textLayerDiv.style.height = `${Math.floor(viewport.height)}px`;

            const [{ TextLayer }, textContent] = await Promise.all([
              getPDFJS(),
              textContentPromise,
            ]);
            if (cancelled) return;

            const textLayer = new TextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            });
            await textLayer.render();
          }
        } catch (err: any) {
          if (err?.name !== 'RenderingCancelledException' && !cancelled) {
            console.error(`Page ${pageNumber} render error:`, err);
          }
        }
      };

      void renderPage();

      return () => {
        cancelled = true;
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch {}
        }
      };
    }, [shouldRender, pdfDoc, pageNumber, scale]);

    const estimatedWidth = Math.floor(baseDimensions.width * scale);
    const estimatedHeight = Math.floor(baseDimensions.height * scale);

    return (
      <div
        ref={itemRef}
        className={`pdf-page-sheet ${annotationMode === 'area' ? 'mode-area' : ''}`}
        style={{
          width: `${estimatedWidth}px`,
          minHeight: `${estimatedHeight}px`,
        }}
        onMouseUp={() => {
          if (annotationMode === 'select' && itemRef.current) {
            onTextSelection(pageNumber, itemRef.current);
          } else if (annotationMode === 'area') {
            onAreaMouseUp(pageNumber);
          }
        }}
        onMouseDown={(e) => {
          if (annotationMode === 'area' && itemRef.current) {
            onAreaMouseDown(e, pageNumber, itemRef.current);
          }
        }}
        onMouseMove={(e) => {
          if (annotationMode === 'area' && itemRef.current) {
            onAreaMouseMove(e, itemRef.current);
          }
        }}
      >
        {/* Canvas for PDF visual rendering */}
        <canvas ref={canvasRef} className="pdf-canvas" />

        {/* TextLayer for browser native text selection */}
        <div ref={textLayerRef} className="pdf-text-layer textLayer" />

        {/* Existing Annotations Overlay on this page */}
        {pageRendered && (
          <div className="pdf-annotations-overlay" aria-hidden="true">
            {annotations.map((ann) => {
              const colorDef = ANNOTATION_COLORS[ann.color] || ANNOTATION_COLORS.yellow;
              const isActive = ann.id === activeAnnotationId;
              return ann.rects.map((rect, idx) => (
                <div
                  key={`${ann.id}-${idx}`}
                  className={`pdf-annotation-highlight ${isActive ? 'active' : ''} ${
                    ann.type === 'area' ? 'type-area' : ''
                  }`}
                  style={{
                    left: `${rect.x}%`,
                    top: `${rect.y}%`,
                    width: `${rect.width}%`,
                    height: `${rect.height}%`,
                    backgroundColor: ann.type === 'area' ? 'transparent' : colorDef.bg,
                    borderColor: colorDef.border,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAnnotationClick?.(ann.id);
                  }}
                  title={ann.comment ? `💬 ${ann.comment}` : ann.text}
                />
              ));
            })}
          </div>
        )}

        {/* Current Area Selection Drag Box */}
        {areaRect && (
          <div
            className="pdf-area-selection-box"
            style={{
              left: `${areaRect.x}%`,
              top: `${areaRect.y}%`,
              width: `${areaRect.width}%`,
              height: `${areaRect.height}%`,
            }}
          />
        )}

        {/* Floating Selection Toolbar for Selected Text */}
        {selectedRange && (
          <div
            className="pdf-floating-selection-toolbar"
            style={{
              left: `${selectedRange.toolbarPos.x}px`,
              top: `${selectedRange.toolbarPos.y}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 5 Colors for Highlighting */}
            <div className="pdf-floating-color-picker" role="toolbar" aria-label={t('高亮颜色')}>
              {(['yellow', 'green', 'blue', 'coral', 'purple'] as AnnotationColor[]).map((c) => (
                <button
                  key={c}
                  className="pdf-color-dot"
                  style={{ backgroundColor: ANNOTATION_COLORS[c].hex }}
                  onClick={() =>
                    onAddHighlight(c, selectedRange.text, selectedRange.rects)
                  }
                  title={t(ANNOTATION_COLORS[c].name)}
                  aria-label={t(ANNOTATION_COLORS[c].name)}
                />
              ))}
            </div>

            <span className="pdf-floating-divider" />

            {/* Comment button */}
            <button
              className="pdf-floating-btn"
              onClick={() =>
                onOpenComment(selectedRange.text, selectedRange.rects, 'highlight')
              }
              title={t('添加批注')}
            >
              <MessageSquareText size={14} />
              <span>{t('批注')}</span>
            </button>

            {/* Insert Quote to Current Note */}
            {onInsertToNote && (
              <button
                className="pdf-floating-btn"
                onClick={() => {
                  onInsertToNote(
                    `> ${selectedRange.text}\n\n*(《${filename}》第 ${pageNumber} 页)*\n`
                  );
                }}
                title={t('引用到笔记')}
              >
                <PenLine size={14} />
                <span>{t('引用')}</span>
              </button>
            )}

            {/* Copy Quote Markdown */}
            <button
              className="pdf-floating-btn"
              onClick={() => {
                const quote = `> ${selectedRange.text}\n\n*(《${filename}》第 ${pageNumber} 页)*`;
                if (onCopyQuote) onCopyQuote(quote);
                else void navigator.clipboard?.writeText(quote);
                setCopyFeedback(true);
                setTimeout(() => setCopyFeedback(false), 1600);
              }}
              title={t('复制引用')}
            >
              {copyFeedback ? <Check size={14} /> : <Copy size={14} />}
              <span>{copyFeedback ? t('已复制') : t('复制')}</span>
            </button>
          </div>
        )}

        {/* Page Footer Label */}
        <div className="pdf-page-sheet-footer">
          <span>{pageNumber}</span>
        </div>
      </div>
    );
  }
);
