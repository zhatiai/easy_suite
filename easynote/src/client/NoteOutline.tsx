import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Heading } from './knowledge';
import { t } from './i18n';

interface OutlineNode {
  heading: Heading;
  children: OutlineNode[];
}

interface Props {
  headings: Heading[];
  activeOffset: number | null;
  onNavigate(offset: number): void;
}

export function NoteOutline({ headings, activeOffset, onNavigate }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { roots, branches } = useMemo(() => {
    const roots: OutlineNode[] = [];
    const stack: OutlineNode[] = [];
    const branches: string[] = [];
    for (const heading of headings) {
      const node: OutlineNode = { heading, children: [] };
      while (stack.length && stack[stack.length - 1].heading.level >= heading.level) stack.pop();
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
    }
    const collectBranches = (nodes: OutlineNode[]) => {
      for (const node of nodes) {
        if (node.children.length) {
          branches.push(`${node.heading.offset}-${node.heading.text}`);
          collectBranches(node.children);
        }
      }
    };
    collectBranches(roots);
    return { roots, branches };
  }, [headings]);
  const allCollapsed = branches.length > 0 && branches.every((key) => collapsed.has(key));

  const renderNodes = (nodes: OutlineNode[]) => <ul>{nodes.map(({ heading, children }) => {
    const key = `${heading.offset}-${heading.text}`;
    const isCollapsed = collapsed.has(key);
    const isActive = heading.offset === activeOffset;
    return <li key={key}>
      <div className={`outline-row${isActive ? ' is-current' : ''}`}>
        {children.length ? <button className="outline-toggle" aria-label={t(isCollapsed ? '展开章节 {0}' : '折叠章节 {0}', heading.text)}
          aria-expanded={!isCollapsed} onClick={() => setCollapsed((previous) => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })}><ChevronRight size={12} /></button> : <span className="outline-leaf" aria-hidden="true" />}
        <button className="outline-heading" aria-current={isActive ? 'location' : undefined}
          onClick={() => onNavigate(heading.offset)}>{heading.text}</button>
      </div>
      {children.length > 0 && <div className="outline-children" hidden={isCollapsed}>{renderNodes(children)}</div>}
    </li>;
  })}</ul>;

  return <section className="outline-section">
    <div className="outline-section-header"><h3>{t('outline')}</h3>
      {branches.length > 0 && <button className="outline-fold-all" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(branches))}>
        {t(allCollapsed ? '全部展开' : '全部收起')}
      </button>}
    </div>
    {headings.length ? <nav className="note-outline" aria-label={t('outline')}>{renderNodes(roots)}</nav>
      : <div className="panel-empty">{t('no_headings')}</div>}
  </section>;
}
