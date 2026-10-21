import { headings, type Heading } from './knowledge';

export const TOC_REGEX = /<!--\s*toc\s*-->[\s\S]*?<!--\s*(?:\/toc|tocstop)\s*-->\r?\n*/i;

export function slugify(text: string): string {
  const cleaned = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
    .toLowerCase();

  const slug = cleaned
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

  return slug || 'section';
}

export function hasToc(content: string): boolean {
  return TOC_REGEX.test(content);
}

export function generateToc(content: string): string | null {
  const noteHeadings = headings(content);
  if (!noteHeadings.length) return null;

  const minLevel = Math.min(...noteHeadings.map((h) => h.level));
  const slugCounts = new Map<string, number>();

  const lines = ['<!-- toc -->'];
  for (const heading of noteHeadings) {
    const indent = '  '.repeat(Math.max(0, heading.level - minLevel));
    const baseSlug = slugify(heading.text);
    const count = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, count + 1);
    const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;

    const displayTitle = heading.text
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .trim();

    lines.push(`${indent}- [${displayTitle}](#${slug})`);
  }
  lines.push('<!-- /toc -->');

  return lines.join('\n');
}

export function insertToc(content: string): { content: string; inserted: boolean } {
  const toc = generateToc(content);
  if (!toc) return { content, inserted: false };

  const baseContent = hasToc(content) ? removeToc(content).content : content;
  const frontmatterMatch = /^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|$)/.exec(baseContent);

  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[0].replace(/\r?\n+$/, '');
    const body = baseContent.slice(frontmatterMatch[0].length).replace(/^\r?\n+/, '');
    const newContent = body
      ? `${frontmatter}\n\n${toc}\n\n${body}`
      : `${frontmatter}\n\n${toc}\n`;
    return { content: newContent, inserted: true };
  }

  const trimmedBody = baseContent.replace(/^\r?\n+/, '');
  const newContent = trimmedBody
    ? `${toc}\n\n${trimmedBody}`
    : `${toc}\n`;

  return { content: newContent, inserted: true };
}

export function removeToc(content: string): { content: string; removed: boolean } {
  if (!hasToc(content)) return { content, removed: false };

  const frontmatterMatch = /^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|$)/.exec(content);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[0].replace(/\r?\n+$/, '');
    const body = content.slice(frontmatterMatch[0].length);
    const cleanedBody = body.replace(TOC_REGEX, '').replace(/^\r?\n+/, '');
    const newContent = cleanedBody ? `${frontmatter}\n\n${cleanedBody}` : `${frontmatter}\n`;
    return { content: newContent, removed: true };
  }

  const cleaned = content.replace(TOC_REGEX, '').replace(/^\r?\n+/, '');
  return { content: cleaned, removed: true };
}

export function updateToc(content: string): { content: string; changed: boolean } {
  if (!hasToc(content)) return { content, changed: false };

  const newToc = generateToc(content);
  if (!newToc) return { content, changed: false };

  const match = TOC_REGEX.exec(content);
  if (!match) return { content, changed: false };

  const currentToc = match[0].trimEnd();
  if (currentToc === newToc.trimEnd()) {
    return { content, changed: false };
  }

  const trailingNewlines = match[0].slice(currentToc.length) || '\n\n';
  const newContent = content.slice(0, match.index) + newToc + trailingNewlines + content.slice(match.index + match[0].length);
  return { content: newContent, changed: true };
}

export function toggleToc(content: string): { content: string; action: 'inserted' | 'removed' | 'no_headings' } {
  if (hasToc(content)) {
    const { content: newContent, removed } = removeToc(content);
    return { content: newContent, action: removed ? 'removed' : 'no_headings' };
  }
  const { content: newContent, inserted } = insertToc(content);
  if (!inserted) {
    return { content, action: 'no_headings' };
  }
  return { content: newContent, action: 'inserted' };
}
