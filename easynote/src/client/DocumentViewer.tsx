import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  Fragment,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Download,
  Upload,
  X,
  FileText,
  MessageSquareText,
  PenLine,
  Copy,
  Pencil,
  Trash2,
  Search,
  Hash,
  WrapText,
  Highlighter,
  Crop,
  Check,
  LoaderCircle,
  Plus,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { t } from './i18n';
import {
  type AnnotationColor,
  type PdfAnnotation,
  type PdfAnnotationRect,
  ANNOTATION_COLORS,
  loadPdfAnnotations,
  savePdfAnnotations,
  formatAnnotationsAsMarkdown,
  formatSingleAnnotationAsMarkdown,
  formatTxtQuoteAsMarkdown,
} from './annotations';
import { loadPDFDocument } from './pdfjs';
import {
  PdfContinuousViewer,
  type PdfContinuousViewerHandle,
} from './PdfContinuousViewer';

export interface DocumentViewerFile {
  id?: string;
  url: string;
  filename: string;
  type: 'pdf' | 'txt';
  blob?: Blob;
}

interface DocumentViewerProps {
  file: DocumentViewerFile;
  userId: string;
  onClose?(): void;
  onExpandFullscreen?(): void;
  embedded?: boolean;
  onInsertToNote?(markdown: string): void;
  onCreateNoteFromContent?(title: string, markdown: string): void;
  onUploadNewDocument?(file: File): Promise<{ id: string; url: string; filename: string; mime: string }>;
  resolveFile?(id: string): Promise<string | null>;
}

export function DocumentViewer({
  file: initialFile,
  userId,
  onClose,
  onExpandFullscreen,
  embedded = false,
  onInsertToNote,
  onCreateNoteFromContent,
  onUploadNewDocument,
  resolveFile,
}: DocumentViewerProps) {
  const [currentFile, setCurrentFile] = useState<DocumentViewerFile>(initialFile);
  const [toastMessage, setToastMessage] = useState<string>('');

  // Toast helper
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? '' : prev));
    }, 2400);
  }, []);

  // PDF specific state
  const continuousRef = useRef<PdfContinuousViewerHandle>(null);
  const pdfViewportRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.2);
  const [pdfLoading, setPdfLoading] = useState<boolean>(false);
  const [pdfError, setPdfError] = useState<string>('');
  const [annotationMode, setAnnotationMode] = useState<'select' | 'area'>('select');
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(!embedded);
  const [annotationSearch, setAnnotationSearch] = useState<string>('');

  // Dynamically calculate scale to fit current reading viewport width
  const handleFitWidth = useCallback(() => {
    if (pdfViewportRef.current) {
      const containerW = pdfViewportRef.current.clientWidth;
      if (containerW > 160) {
        // Standard A4 width is 595. Leave 36px breathing room for scrollbar and padding
        const optimalScale = Math.min(2.5, Math.max(0.6, Number(((containerW - 36) / 595).toFixed(2))));
        setScale(optimalScale);
        return;
      }
    }
    setScale(1.5);
  }, []);

  // Auto-fit scale to available container width when PDF is loaded in embedded viewer
  useEffect(() => {
    if (!pdfDoc) return;
    const timer = setTimeout(() => {
      if (pdfViewportRef.current) {
        const containerW = pdfViewportRef.current.clientWidth;
        if (containerW > 240) {
          const optimalScale = Math.min(2.2, Math.max(0.8, Number(((containerW - 36) / 595).toFixed(2))));
          setScale(optimalScale);
        }
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [pdfDoc]);

  // Comment edit dialog state
  const [commentDialog, setCommentDialog] = useState<{
    open: boolean;
    annotationId?: string;
    page?: number;
    text?: string;
    comment: string;
    color: AnnotationColor;
    isNew?: boolean;
    rects?: PdfAnnotationRect[];
    type?: 'highlight' | 'area';
  } | null>(null);

  // TXT specific state
  const [textContent, setTextContent] = useState<string>('');
  const [txtLoading, setTxtLoading] = useState<boolean>(false);
  const [txtError, setTxtError] = useState<string>('');
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(true);
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [txtSearchQuery, setTxtSearchQuery] = useState<string>('');
  const [txtSelectedText, setTxtSelectedText] = useState<string>('');

  // File switching/uploading
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingDoc, setUploadingDoc] = useState<boolean>(false);

  // Load annotations when PDF file changes
  useEffect(() => {
    if (currentFile.type === 'pdf') {
      const fileKey = currentFile.id || currentFile.filename;
      if (fileKey && userId) {
        void loadPdfAnnotations(userId, fileKey).then((loaded) => {
          setAnnotations(loaded);
        });
      }
    }
  }, [currentFile, userId]);

  // Load PDF document
  useEffect(() => {
    if (currentFile.type !== 'pdf') return;

    let cancelled = false;
    setPdfLoading(true);
    setPdfError('');

    const loadDoc = async () => {
      try {
        const doc = await loadPDFDocument({
          url: currentFile.url,
          blob: currentFile.blob,
          id: currentFile.id,
          resolveFile,
        });
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setCurrentPage(1);
        setPdfLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setPdfError(t('文档加载失败：{0}', err?.message || String(err)));
          setPdfLoading(false);
        }
      }
    };

    void loadDoc();

    return () => {
      cancelled = true;
    };
  }, [currentFile, resolveFile]);

  // Load TXT document
  useEffect(() => {
    if (currentFile.type !== 'txt') return;

    let cancelled = false;
    setTxtLoading(true);
    setTxtError('');

    const loadTxt = async () => {
      try {
        let text = '';
        if (currentFile.blob) {
          text = await currentFile.blob.text();
        } else if (currentFile.id && resolveFile) {
          const cachedUrl = await resolveFile(currentFile.id);
          if (cachedUrl) {
            const resp = await fetch(cachedUrl);
            text = await resp.text();
          }
        }

        if (!text && currentFile.url) {
          const resp = await fetch(currentFile.url, { credentials: 'same-origin' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          text = await resp.text();
        }

        if (cancelled) return;
        setTextContent(text);
        setTxtLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setTxtError(t('文档加载失败：{0}', err?.message || String(err)));
          setTxtLoading(false);
        }
      }
    };

    void loadTxt();

    return () => {
      cancelled = true;
    };
  }, [currentFile, resolveFile]);

  // PDF Continuous Handlers
  const handleAddContinuousHighlight = (
    page: number,
    color: AnnotationColor,
    text: string,
    rects: PdfAnnotationRect[]
  ) => {
    const newAnn: PdfAnnotation = {
      id: crypto.randomUUID(),
      page,
      type: 'highlight',
      color,
      text,
      rects,
      createdAt: Date.now(),
    };
    const next = [...annotations, newAnn];
    setAnnotations(next);
    const fileKey = currentFile.id || currentFile.filename;
    if (fileKey) void savePdfAnnotations(userId, fileKey, next);
    showToast(t('已添加高亮标记'));
  };

  const handleOpenContinuousComment = (
    page: number,
    text: string,
    rects: PdfAnnotationRect[],
    type: 'highlight' | 'area'
  ) => {
    setCommentDialog({
      open: true,
      isNew: true,
      page,
      text: text || (type === 'area' ? t('区域框选批注') : ''),
      comment: '',
      color: 'yellow',
      rects,
      type,
    });
    setCurrentPage(page);
  };

  // Scroll to page helper
  const scrollToPage = (pageNum: number) => {
    const target = Math.max(1, Math.min(numPages || 1, pageNum));
    setCurrentPage(target);
    continuousRef.current?.scrollToPage(target);
  };

  // Save comment from dialog
  const saveCommentDialog = () => {
    if (!commentDialog) return;
    const fileKey = currentFile.id || currentFile.filename;
    const targetPage = commentDialog.page ?? currentPage;

    if (commentDialog.isNew && commentDialog.rects) {
      const newAnn: PdfAnnotation = {
        id: crypto.randomUUID(),
        page: targetPage,
        type: commentDialog.type || 'highlight',
        color: commentDialog.color,
        text: commentDialog.text,
        comment: commentDialog.comment.trim(),
        rects: commentDialog.rects,
        createdAt: Date.now(),
      };
      const next = [...annotations, newAnn];
      setAnnotations(next);
      if (fileKey) void savePdfAnnotations(userId, fileKey, next);
      showToast(t('已添加批注与笔记'));
    } else if (commentDialog.annotationId) {
      const next = annotations.map((ann) =>
        ann.id === commentDialog.annotationId
          ? { ...ann, comment: commentDialog.comment.trim(), color: commentDialog.color }
          : ann
      );
      setAnnotations(next);
      if (fileKey) void savePdfAnnotations(userId, fileKey, next);
      showToast(t('批注已更新'));
    }

    setCommentDialog(null);
  };

  // Delete annotation
  const deleteAnnotation = (id: string) => {
    const next = annotations.filter((ann) => ann.id !== id);
    setAnnotations(next);
    const fileKey = currentFile.id || currentFile.filename;
    if (fileKey) void savePdfAnnotations(userId, fileKey, next);
    if (activeAnnotationId === id) setActiveAnnotationId(null);
    showToast(t('批注已删除'));
  };

  // Insert single annotation to note
  const insertAnnotationToNote = (ann: PdfAnnotation) => {
    if (!onInsertToNote) return;
    const md = formatSingleAnnotationAsMarkdown(ann, currentFile.filename);
    onInsertToNote(md);
    showToast(t('已将批注添加到当前笔记'));
  };

  // Export all annotations to note
  const exportAllAnnotations = () => {
    if (!onInsertToNote || !annotations.length) return;
    const md = formatAnnotationsAsMarkdown(currentFile.filename, annotations);
    onInsertToNote(md);
    showToast(t('已将批注添加到当前笔记'));
  };

  // Upload or open another document
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isPdf = file.name.endsWith('.pdf') || file.type === 'application/pdf';
    const isTxt = file.name.endsWith('.txt') || file.type === 'text/plain';

    if (!isPdf && !isTxt) {
      showToast(t('只支持 PDF 或 TXT 格式文档。'));
      return;
    }

    const nextFile: DocumentViewerFile = {
      filename: file.name,
      type: isPdf ? 'pdf' : 'txt',
      blob: file,
      url: URL.createObjectURL(file),
    };

    setCurrentFile(nextFile);

    // If upload callback exists, upload in background
    if (onUploadNewDocument) {
      setUploadingDoc(true);
      try {
        const stored = await onUploadNewDocument(file);
        setCurrentFile((prev) => ({
          ...prev,
          id: stored.id,
          url: stored.url,
        }));
        showToast(t('文档已上传并关联到当前笔记'));
      } catch (err: any) {
        showToast(t('上传失败：{0}', err?.message || String(err)));
      } finally {
        setUploadingDoc(false);
      }
    }
  };

  // Download action
  const downloadCurrentDoc = () => {
    let dlUrl = currentFile.url;
    if (currentFile.blob) {
      dlUrl = URL.createObjectURL(currentFile.blob);
    }
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = currentFile.filename;
    a.click();
    if (currentFile.blob) {
      setTimeout(() => URL.revokeObjectURL(dlUrl), 5000);
    }
  };

  // Filtered annotations in sidebar
  const filteredAnnotations = useMemo(() => {
    if (!annotationSearch.trim()) return annotations;
    const q = annotationSearch.toLowerCase();
    return annotations.filter(
      (a) =>
        (a.text && a.text.toLowerCase().includes(q)) ||
        (a.comment && a.comment.toLowerCase().includes(q))
    );
  }, [annotations, annotationSearch]);

  // TXT lines & search
  const txtLines = useMemo(() => textContent.split(/\r?\n/), [textContent]);

  const txtHighlightedLines = useMemo(() => {
    if (!txtSearchQuery.trim()) return null;
    const q = txtSearchQuery.toLowerCase();
    return txtLines.map((line) => {
      if (!line.toLowerCase().includes(q)) return null;
      const parts: { text: string; match: boolean }[] = [];
      let idx = 0;
      let matchIdx = line.toLowerCase().indexOf(q, idx);
      while (matchIdx !== -1) {
        if (matchIdx > idx) parts.push({ text: line.slice(idx, matchIdx), match: false });
        parts.push({ text: line.slice(matchIdx, matchIdx + q.length), match: true });
        idx = matchIdx + q.length;
        matchIdx = line.toLowerCase().indexOf(q, idx);
      }
      if (idx < line.length) parts.push({ text: line.slice(idx), match: false });
      return parts;
    });
  }, [txtLines, txtSearchQuery]);

  const shell = (
    <div className={`doc-viewer-shell ${embedded ? 'doc-viewer-embedded' : ''}`}>
      {/* Top Header Toolbar */}
      <header className="doc-viewer-header">
        <div className="doc-viewer-title-group">
          <span className={`doc-viewer-badge doc-badge-${currentFile.type}`}>
            {currentFile.type.toUpperCase()}
          </span>
          <strong className="doc-viewer-filename" title={currentFile.filename}>
            {currentFile.filename}
          </strong>
          {uploadingDoc && (
              <span className="doc-viewer-uploading-tag">
                <LoaderCircle className="spin" size={13} />
                {t('上传中…')}
              </span>
            )}
          </div>

          {/* Navigation Controls (PDF) */}
          {currentFile.type === 'pdf' && (
            <div className="doc-viewer-controls">
              <button
                className="doc-tool-btn"
                disabled={currentPage <= 1 || pdfLoading}
                onClick={() => scrollToPage(currentPage - 1)}
                title={t('上一页')}
                data-tooltip={t('上一页')}
                aria-label={t('上一页')}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="doc-page-counter">
                <input
                  type="number"
                  min={1}
                  max={numPages || 1}
                  value={currentPage}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (val >= 1 && val <= numPages) scrollToPage(val);
                  }}
                  className="doc-page-input"
                  aria-label={t('跳转到页码')}
                />
                <span className="doc-page-total">/ {numPages || 1}</span>
              </span>
              <button
                className="doc-tool-btn"
                disabled={currentPage >= numPages || pdfLoading}
                onClick={() => scrollToPage(currentPage + 1)}
                title={t('下一页')}
                data-tooltip={t('下一页')}
                aria-label={t('下一页')}
              >
                <ChevronRight size={16} />
              </button>

              <span className="doc-tool-divider" />

              <button
                className="doc-tool-btn"
                disabled={scale <= 0.6}
                onClick={() => setScale((s) => Math.max(0.6, Number((s - 0.2).toFixed(1))))}
                title={t('缩小')}
                data-tooltip={t('缩小')}
                aria-label={t('缩小')}
              >
                <ZoomOut size={16} />
              </button>
              <button
                className="doc-tool-btn doc-scale-label"
                onClick={() => setScale(1.0)}
                title={t('重置缩放')}
                data-tooltip={t('重置缩放')}
                aria-label={t('重置缩放')}
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                className="doc-tool-btn"
                disabled={scale >= 2.5}
                onClick={() => setScale((s) => Math.min(2.5, Number((s + 0.2).toFixed(1))))}
                title={t('放大')}
                data-tooltip={t('放大')}
                aria-label={t('放大')}
              >
                <ZoomIn size={16} />
              </button>
              <button
                className="doc-tool-btn"
                onClick={handleFitWidth}
                title={t('适应宽度')}
                data-tooltip={t('适应宽度')}
                aria-label={t('适应宽度')}
              >
                <Maximize2 size={15} />
              </button>

              <span className="doc-tool-divider" />

              <div className="doc-mode-toggle" role="group" aria-label={t('批注模式')}>
                <button
                  className={`doc-mode-btn ${annotationMode === 'select' ? 'active' : ''}`}
                  onClick={() => setAnnotationMode('select')}
                  title={t('划选模式')}
                  data-tooltip={t('划选模式')}
                  aria-label={t('划选模式')}
                >
                  <Highlighter size={14} />
                  <span className="doc-btn-label">{t('划选模式')}</span>
                </button>
                <button
                  className={`doc-mode-btn ${annotationMode === 'area' ? 'active' : ''}`}
                  onClick={() => setAnnotationMode('area')}
                  title={t('区域框选')}
                  data-tooltip={t('区域框选')}
                  aria-label={t('区域框选')}
                >
                  <Crop size={14} />
                  <span className="doc-btn-label">{t('区域框选')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Navigation Controls (TXT) */}
          {currentFile.type === 'txt' && (
            <div className="doc-viewer-controls">
              <button
                className={`doc-tool-btn ${showLineNumbers ? 'active' : ''}`}
                onClick={() => setShowLineNumbers((v) => !v)}
                title={t('行号')}
                data-tooltip={t('行号')}
                aria-label={t('行号')}
              >
                <Hash size={15} />
                <span className="doc-btn-label">{t('行号')}</span>
              </button>
              <button
                className={`doc-tool-btn ${wordWrap ? 'active' : ''}`}
                onClick={() => setWordWrap((v) => !v)}
                title={t('自动换行')}
                data-tooltip={t('自动换行')}
                aria-label={t('自动换行')}
              >
                <WrapText size={15} />
                <span className="doc-btn-label">{t('自动换行')}</span>
              </button>
              <span className="doc-tool-divider" />
              <label className="doc-txt-search-field">
                <Search size={14} />
                <input
                  type="text"
                  placeholder={t('在文档中搜索')}
                  value={txtSearchQuery}
                  onChange={(e) => setTxtSearchQuery(e.target.value)}
                />
              </label>
            </div>
          )}

          {/* Right Action Buttons */}
          <div className="doc-viewer-actions">
            {currentFile.type === 'pdf' && (
              <button
                className={`doc-action-btn ${sidebarOpen ? 'active' : ''}`}
                onClick={() => setSidebarOpen((v) => !v)}
                title={t('批注与笔记')}
                data-tooltip={t('批注与笔记')}
                aria-label={t('批注与笔记')}
              >
                <MessageSquareText size={16} />
                <span className="doc-btn-label">{t('批注与笔记')}</span>
                {annotations.length > 0 && <span className="doc-badge-count">{annotations.length}</span>}
              </button>
            )}

            {currentFile.type === 'txt' && onInsertToNote && (
              <button
                className="doc-action-btn"
                onClick={() => {
                  onInsertToNote(formatTxtQuoteAsMarkdown(textContent, currentFile.filename));
                  showToast(t('已将内容追加到当前笔记'));
                }}
                title={t('插入全文到笔记')}
                data-tooltip={t('插入全文到笔记')}
                aria-label={t('插入全文到笔记')}
              >
                <PenLine size={16} />
                <span className="doc-btn-label">{t('插入全文到笔记')}</span>
              </button>
            )}

            {currentFile.type === 'txt' && onCreateNoteFromContent && (
              <button
                className="doc-action-btn"
                onClick={() => {
                  const title = currentFile.filename.replace(/\.txt$/i, '');
                  onCreateNoteFromContent(title, textContent);
                  showToast(t('已基于文档创建新笔记'));
                }}
                title={t('以此创建新笔记')}
                data-tooltip={t('以此创建新笔记')}
                aria-label={t('以此创建新笔记')}
              >
                <Plus size={16} />
                <span className="doc-btn-label">{t('以此创建新笔记')}</span>
              </button>
            )}

            <button className="doc-action-btn" onClick={downloadCurrentDoc} title={t('下载')} data-tooltip={t('下载')} aria-label={t('下载')}>
              <Download size={16} />
            </button>

            <button
              className="doc-action-btn"
              onClick={() => fileInputRef.current?.click()}
              title={t('打开其他文档')}
              data-tooltip={t('打开其他文档')}
              aria-label={t('打开其他文档')}
            >
              <Upload size={16} />
            </button>

            {onExpandFullscreen && (
              <button
                className="doc-action-btn"
                onClick={onExpandFullscreen}
                title={t('全屏阅读')}
                data-tooltip={t('全屏阅读')}
                aria-label={t('全屏阅读')}
              >
                <Maximize2 size={16} />
              </button>
            )}

            {onClose && (
              <button className="doc-action-btn doc-close-btn" onClick={onClose} title={t('关闭')} data-tooltip={t('关闭')} aria-label={t('关闭')}>
                <X size={18} />
              </button>
            )}
          </div>
        </header>

        {/* Hidden File Input for Switching/Uploading Documents */}
        <input
          hidden
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,application/pdf,text/plain"
          onChange={handleFileSelect}
        />

        {/* Main Work Area */}
        <div className="doc-viewer-body">
          {/* Main Stage (PDF or TXT) */}
          <main className="doc-viewer-stage">
            {toastMessage && (
              <div className="doc-floating-toast" role="status">
                <Check size={14} />
                <span>{toastMessage}</span>
              </div>
            )}

            {/* PDF Viewport */}
            {currentFile.type === 'pdf' && (
              <div className="doc-pdf-viewport" ref={pdfViewportRef}>
                {pdfLoading && (
                  <div className="doc-loading-state">
                    <LoaderCircle className="spin" size={28} />
                    <p>{t('文档加载中...')}</p>
                  </div>
                )}

                {pdfError && (
                  <div className="doc-error-state" role="alert">
                    <p>{pdfError}</p>
                    <button className="primary" onClick={() => fileInputRef.current?.click()}>
                      {t('打开其他文档')}
                    </button>
                  </div>
                )}

                {!pdfError && !pdfLoading && pdfDoc && (
                  <PdfContinuousViewer
                    ref={continuousRef}
                    pdfDoc={pdfDoc}
                    numPages={numPages}
                    scale={scale}
                    annotations={annotations}
                    activeAnnotationId={activeAnnotationId}
                    annotationMode={annotationMode}
                    filename={currentFile.filename}
                    onVisiblePageChange={(p) => setCurrentPage(p)}
                    onAddHighlight={handleAddContinuousHighlight}
                    onOpenComment={handleOpenContinuousComment}
                    onInsertToNote={onInsertToNote}
                    onCopyQuote={() => showToast(t('引用已复制到剪贴板'))}
                    onAnnotationClick={(id) => setActiveAnnotationId(id)}
                  />
                )}
              </div>
            )}

            {/* TXT Viewport */}
            {currentFile.type === 'txt' && (
              <div
                className="doc-txt-viewport"
                onMouseUp={() => {
                  const sel = window.getSelection();
                  if (sel && !sel.isCollapsed) {
                    setTxtSelectedText(sel.toString().trim());
                  } else {
                    setTxtSelectedText('');
                  }
                }}
              >
                {txtLoading && (
                  <div className="doc-loading-state">
                    <LoaderCircle className="spin" size={28} />
                    <p>{t('文档加载中...')}</p>
                  </div>
                )}

                {txtError && (
                  <div className="doc-error-state" role="alert">
                    <p>{txtError}</p>
                    <button className="primary" onClick={() => fileInputRef.current?.click()}>
                      {t('打开其他文档')}
                    </button>
                  </div>
                )}

                {!txtError && !txtLoading && (
                  <div className={`doc-txt-content ${wordWrap ? 'wrap' : 'nowrap'}`}>
                    {txtLines.map((line, idx) => {
                      const highlighted = txtHighlightedLines?.[idx];
                      return (
                        <div key={idx} className="doc-txt-line">
                          {showLineNumbers && <span className="doc-txt-line-number">{idx + 1}</span>}
                          <span className="doc-txt-line-text">
                            {highlighted ? (
                              highlighted.map((part, pIdx) =>
                                part.match ? (
                                  <mark key={pIdx} className="search-highlight">
                                    {part.text}
                                  </mark>
                                ) : (
                                  <span key={pIdx}>{part.text}</span>
                                )
                              )
                            ) : (
                              line || '\u00A0'
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Floating TXT Selection Pill */}
                {txtSelectedText && onInsertToNote && (
                  <div className="doc-txt-floating-pill">
                    <button
                      className="primary small"
                      onClick={() => {
                        onInsertToNote(formatTxtQuoteAsMarkdown(txtSelectedText, currentFile.filename));
                        setTxtSelectedText('');
                        window.getSelection()?.removeAllRanges();
                        showToast(t('已将内容追加到当前笔记'));
                      }}
                    >
                      <PenLine size={13} />
                      <span>{t('引用到笔记')}</span>
                    </button>
                    <button
                      className="secondary small"
                      onClick={() => {
                        void navigator.clipboard.writeText(txtSelectedText);
                        setTxtSelectedText('');
                        window.getSelection()?.removeAllRanges();
                        showToast(t('已复制'));
                      }}
                    >
                      <Copy size={13} />
                      <span>{t('复制')}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </main>

          {/* PDF Annotations & Notes Sidebar */}
          {currentFile.type === 'pdf' && sidebarOpen && (
            <aside className="doc-viewer-sidebar" aria-label={t('批注与笔记')}>
              <div className="doc-sidebar-header">
                <h3>
                  <MessageSquareText size={16} />
                  <span>{t('批注与笔记')}</span>
                  <span className="doc-badge-pill">{filteredAnnotations.length}</span>
                </h3>
                {onInsertToNote && annotations.length > 0 && (
                  <button
                    className="doc-sidebar-export-btn"
                    onClick={exportAllAnnotations}
                    title={t('全部添加到当前笔记')}
                  >
                    <PenLine size={14} />
                    <span>{t('全部添加到当前笔记')}</span>
                  </button>
                )}
              </div>

              <div className="doc-sidebar-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder={t('搜索')}
                  value={annotationSearch}
                  onChange={(e) => setAnnotationSearch(e.target.value)}
                />
              </div>

              <div className="doc-sidebar-list">
                {filteredAnnotations.length === 0 ? (
                  <div className="doc-sidebar-empty">
                    <Highlighter size={28} />
                    <p>{t('暂无批注')}</p>
                    <small>{t('在 PDF 中划选文字或框选区域即可添加高亮与笔记。')}</small>
                  </div>
                ) : (
                  filteredAnnotations.map((ann) => (
                    <div
                      key={ann.id}
                      className={`doc-ann-card color-${ann.color} ${activeAnnotationId === ann.id ? 'active' : ''}`}
                      onClick={() => {
                        scrollToPage(ann.page);
                        setActiveAnnotationId(ann.id);
                      }}
                    >
                      <div className="doc-ann-card-header">
                        <span
                          className="doc-ann-color-dot"
                          style={{ backgroundColor: ANNOTATION_COLORS[ann.color].hex }}
                        />
                        <span className="doc-ann-page-tag">{t('第 {0} 页', ann.page)}</span>
                        <span className="doc-ann-type-tag">
                          {ann.type === 'area' ? t('区域框选') : t('文本高亮')}
                        </span>
                        <div className="doc-ann-card-actions">
                          {onInsertToNote && (
                            <button
                              className="doc-mini-icon-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                insertAnnotationToNote(ann);
                              }}
                              title={t('引用到笔记')}
                            >
                              <PenLine size={13} />
                            </button>
                          )}
                          <button
                            className="doc-mini-icon-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCommentDialog({
                                open: true,
                                annotationId: ann.id,
                                text: ann.text,
                                comment: ann.comment || '',
                                color: ann.color,
                                isNew: false,
                              });
                            }}
                            title={t('编辑批注')}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="doc-mini-icon-btn danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteAnnotation(ann.id);
                            }}
                            title={t('删除批注')}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {ann.text && <blockquote className="doc-ann-quote">{ann.text}</blockquote>}
                      {ann.comment && <div className="doc-ann-comment">{ann.comment}</div>}
                    </div>
                  ))
                )}
              </div>
            </aside>
          )}
        </div>

        {/* Comment Dialog Modal */}
        {commentDialog?.open && (
          <div className="doc-comment-modal-backdrop" onClick={() => setCommentDialog(null)}>
            <div className="doc-comment-modal" onClick={(e) => e.stopPropagation()}>
              <header className="doc-comment-modal-header">
                <h4>{commentDialog.isNew ? t('添加批注') : t('编辑批注')}</h4>
                <button className="doc-mini-icon-btn" onClick={() => setCommentDialog(null)}>
                  <X size={16} />
                </button>
              </header>

              {commentDialog.text && (
                <blockquote className="doc-comment-preview-quote">{commentDialog.text}</blockquote>
              )}

              <div className="doc-comment-form">
                <label className="doc-form-label">{t('写下你的批注与想法...')}</label>
                <textarea
                  autoFocus
                  rows={4}
                  value={commentDialog.comment}
                  onChange={(e) =>
                    setCommentDialog((prev) => (prev ? { ...prev, comment: e.target.value } : null))
                  }
                  placeholder={t('写下你的批注与想法...')}
                />

                <div className="doc-comment-color-picker">
                  <span className="doc-form-label">{t('高亮颜色')}：</span>
                  {(['yellow', 'green', 'blue', 'coral', 'purple'] as AnnotationColor[]).map((c) => (
                    <button
                      key={c}
                      className={`doc-color-chip ${commentDialog.color === c ? 'active' : ''}`}
                      style={{ backgroundColor: ANNOTATION_COLORS[c].hex }}
                      onClick={() =>
                        setCommentDialog((prev) => (prev ? { ...prev, color: c } : null))
                      }
                      title={t(ANNOTATION_COLORS[c].name)}
                    />
                  ))}
                </div>
              </div>

              <div className="doc-comment-modal-footer">
                <button className="secondary" onClick={() => setCommentDialog(null)}>
                  {t('cancel')}
                </button>
                <button className="primary" onClick={saveCommentDialog}>
                  {t('保存批注')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );

  if (embedded) {
    return shell;
  }

  return (
    <div
      className="doc-viewer-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('文档阅读与批注')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          if (commentDialog) setCommentDialog(null);
          else onClose?.();
        }
      }}
    >
      {shell}
    </div>
  );
}
