import { openDB } from 'idb';

export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'coral' | 'purple';

export interface PdfAnnotationRect {
  x: number; // percentage of page width (0 - 100)
  y: number; // percentage of page height (0 - 100)
  width: number; // percentage of page width (0 - 100)
  height: number; // percentage of page height (0 - 100)
}

export interface PdfAnnotation {
  id: string;
  page: number; // 1-indexed
  type: 'highlight' | 'area';
  color: AnnotationColor;
  text?: string;
  comment?: string;
  rects: PdfAnnotationRect[];
  createdAt: number;
}

export const ANNOTATION_COLORS: Record<AnnotationColor, { name: string; hex: string; bg: string; border: string }> = {
  yellow: { name: '黄色', hex: '#ffd54f', bg: 'rgba(255, 213, 79, 0.38)', border: '#fbc02d' },
  green: { name: '绿色', hex: '#81c784', bg: 'rgba(129, 199, 132, 0.38)', border: '#66bb6a' },
  blue: { name: '蓝色', hex: '#64b5f6', bg: 'rgba(100, 181, 246, 0.38)', border: '#42a5f5' },
  coral: { name: '珊瑚红', hex: '#e57373', bg: 'rgba(229, 115, 115, 0.38)', border: '#ef5350' },
  purple: { name: '紫色', hex: '#ba68c8', bg: 'rgba(186, 104, 200, 0.38)', border: '#ab47bc' },
};

const ANNOTATION_PREFIX = 'pdf_annotations:';

const database = () => openDB('easynote', 1, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
    if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes');
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  },
});

function storageKey(userId: string, fileId: string): string {
  return `${ANNOTATION_PREFIX}${userId}:${fileId}`;
}

export async function loadPdfAnnotations(userId: string, fileId: string): Promise<PdfAnnotation[]> {
  const key = storageKey(userId, fileId);
  try {
    const db = await database();
    const stored = await db.get('meta', key);
    if (Array.isArray(stored)) return stored as PdfAnnotation[];
  } catch {
    // fallback to localStorage
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      }
    } catch {}
  }
  return [];
}

export async function savePdfAnnotations(userId: string, fileId: string, annotations: PdfAnnotation[]): Promise<void> {
  const key = storageKey(userId, fileId);
  try {
    const db = await database();
    await db.put('meta', annotations, key);
  } catch {}
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(annotations));
    }
  } catch {}
}

export function formatAnnotationsAsMarkdown(filename: string, annotations: PdfAnnotation[]): string {
  if (!annotations.length) return '';
  const sorted = [...annotations].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
  const lines: string[] = [
    `### 《${filename}》阅读笔记与批注`,
    '',
  ];
  let currentPage = -1;
  for (const ann of sorted) {
    if (ann.page !== currentPage) {
      currentPage = ann.page;
      lines.push(`#### 第 ${currentPage} 页`);
      lines.push('');
    }
    if (ann.text) {
      lines.push(`> ${ann.text.replace(/\r?\n/g, ' ')}`);
      lines.push('');
    }
    if (ann.comment) {
      lines.push(`**批注**：${ann.comment}`);
      lines.push('');
    }
    const colorLabel = ANNOTATION_COLORS[ann.color]?.name || ann.color;
    lines.push(`*(标记: ${colorLabel} · ${ann.type === 'area' ? '区域框选' : '文本高亮'})*`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatSingleAnnotationAsMarkdown(ann: PdfAnnotation, filename?: string): string {
  const parts: string[] = [];
  if (ann.text) {
    parts.push(`> ${ann.text.replace(/\r?\n/g, ' ')}`);
  }
  if (ann.comment) {
    parts.push(`**批注**：${ann.comment}`);
  }
  const source = filename ? `《${filename}》` : '';
  const colorLabel = ANNOTATION_COLORS[ann.color]?.name || ann.color;
  parts.push(`*(${source}第 ${ann.page} 页 · ${colorLabel})*`);
  return parts.join('\n\n') + '\n';
}

export function formatTxtQuoteAsMarkdown(text: string, filename?: string): string {
  const source = filename ? ` *(来源: 《${filename}》)*` : '';
  return `> ${text.replace(/\r?\n/g, '\n> ')}\n${source}\n`;
}
