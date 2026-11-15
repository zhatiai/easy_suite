import MarkdownIt from 'markdown-it';
import { idPattern, type LinkedFile } from './types';

const parser = new MarkdownIt({ html: true });

export function noteLink(id: string, title: string): string {
  const label = (title || 'Untitled note').replace(/[\[\]|\r\n]/g, ' ').trim().slice(0, 256) || 'Untitled note';
  return `[[${id}|${label.replace(/[\\`*_<>]/g, '\\$&')}]]`;
}

export function noteLinkOccurrences(content: string): string[] {
  if (!content.includes('[[')) return [];
  const ids: string[] = [];
  for (const block of parser.parse(content, {})) {
    for (const token of block.children ?? []) {
      if (token.type !== 'text') continue;
      for (const match of token.content.matchAll(/\[\[([0-9a-f-]{36})\|[^\]\r\n]{1,256}\]\]/gi)) {
        if (idPattern.test(match[1])) ids.push(match[1].toLowerCase());
      }
    }
  }
  return ids;
}

export function noteLinkIds(content: string): string[] {
  return [...new Set(noteLinkOccurrences(content))];
}

export function appendNoteLinks(content: string, targets: ReadonlyArray<{ id: string; title: string }>): string {
  const existing = new Set(noteLinkIds(content));
  const links = targets.filter((target) => !existing.has(target.id.toLowerCase())).map((target) => noteLink(target.id, target.title));
  const markdown = links.length > 1 ? links.map((link) => `- ${link}`).join('\n') : links[0];
  return links.length ? `${content}${content ? '\n\n' : ''}${markdown}` : content;
}

export function fileLinks(content: string): LinkedFile[] {
  const files = new Map<string, LinkedFile>();
  for (const block of parser.parse(content, {})) {
    const children = block.children ?? [];
    for (let index = 0; index < children.length; index++) {
      const token = children[index];
      if (token.type !== 'link_open') continue;
      const url = token.attrGet('href') ?? '';
      const id = /^\/api\/files\/([0-9a-f-]{36})$/i.exec(url)?.[1];
      if (!id || !idPattern.test(id)) continue;
      let filename = '';
      for (let next = index + 1; next < children.length && children[next].type !== 'link_close'; next++) {
        filename += children[next].content;
      }
      files.set(id.toLowerCase(), { id, filename: filename || id, url });
    }
  }
  return [...files.values()];
}
