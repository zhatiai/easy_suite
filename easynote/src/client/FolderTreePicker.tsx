import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  Check,
} from 'lucide-react';
import type { Folder } from '../shared/types';
import { dateLocale, t } from './i18n';

function moveButtonFocus(event: ReactKeyboardEvent<HTMLElement>, selector: string) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)]
    .filter((button) => !button.disabled);
  if (!buttons.length) return;
  const current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(selector) : null;
  const index = current ? buttons.indexOf(current) : -1;
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1)
        : Math.max(index < 0 ? buttons.length - 1 : index - 1, 0);
  event.preventDefault();
  buttons[next].focus();
}

export interface FolderTreePickerProps {
  folders: Folder[];
  value?: string | null;
  onChange?(id: string | null): void;
  onSelect?(folder: Folder): void;
  allowRoot?: boolean;
  rootLabel?: string;
  onConfirm?(): void;
  itemRole?: string;
  className?: string;
}

export function FolderTreePicker({
  folders,
  value,
  onChange,
  onSelect,
  allowRoot = true,
  rootLabel,
  onConfirm,
  itemRole,
  className = '',
}: FolderTreePickerProps) {
  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const parentId = f.parentId && folderIds.has(f.parentId) ? f.parentId : null;
      const list = map.get(parentId) ?? [];
      list.push(f);
      map.set(parentId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, dateLocale()));
    }
    return map;
  }, [folders, folderIds]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleChoose = (folder: Folder) => {
    onChange?.(folder.id);
    onSelect?.(folder);
  };

  const handleChooseRoot = () => {
    onChange?.(null);
  };

  const renderTree = (parentId: string | null, depth: number): ReactNode => {
    const children = childrenByParent.get(parentId) ?? [];
    return children.map((folder) => {
      const subChildren = childrenByParent.get(folder.id) ?? [];
      const hasChildren = subChildren.length > 0;
      const isOpen = expanded.has(folder.id);
      const isSelected = value !== undefined && value === folder.id;

      return (
        <div key={folder.id} className="folder-picker-branch">
          <div
            className={`folder-tree-row folder-picker-row ${isSelected ? 'active' : ''}`}
            style={{ '--tree-depth': depth } as CSSProperties}
            onClick={() => handleChoose(folder)}
            onDoubleClick={() => {
              handleChoose(folder);
              onConfirm?.();
            }}
          >
            {hasChildren ? (
              <button
                type="button"
                className="folder-disclosure"
                aria-label={isOpen ? t('折叠文件夹') : t('展开文件夹')}
                aria-expanded={isOpen}
                onClick={(e) => toggleExpand(folder.id, e)}
              >
                {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
            ) : (
              <span className="folder-disclosure-spacer" aria-hidden="true" />
            )}
            <button
              type="button"
              role={itemRole}
              className="folder-tree-select folder-picker-select"
              aria-pressed={isSelected}
              autoFocus={isSelected}
              onClick={(e) => {
                e.stopPropagation();
                handleChoose(folder);
              }}
            >
              {isOpen ? <FolderOpen size={18} /> : <FolderIcon size={18} />}
              <span>{folder.name}</span>
              {folder.noteCount !== undefined && folder.noteCount > 0 && (
                <small>{folder.noteCount}</small>
              )}
            </button>
            {isSelected && <Check size={16} className="folder-picker-check" aria-hidden="true" />}
          </div>
          {hasChildren && isOpen && renderTree(folder.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      className={`folder-picker-tree ${className}`.trim()}
      role="region"
      aria-label={t('目标文件夹')}
      onKeyDown={(e) => moveButtonFocus(e, '.folder-picker-select')}
    >
      {allowRoot && (
        <div
          className={`folder-tree-row folder-picker-row ${value === null ? 'active' : ''}`}
          style={{ '--tree-depth': 0 } as CSSProperties}
          onClick={handleChooseRoot}
          onDoubleClick={() => {
            handleChooseRoot();
            onConfirm?.();
          }}
        >
          <span className="folder-disclosure-spacer" aria-hidden="true" />
          <button
            type="button"
            role={itemRole}
            className="folder-tree-select folder-picker-select"
            aria-pressed={value === null}
            autoFocus={value === null}
            onClick={(e) => {
              e.stopPropagation();
              handleChooseRoot();
            }}
          >
            <FolderIcon size={18} />
            <span>{rootLabel ?? t('根目录')}</span>
          </button>
          {value === null && <Check size={16} className="folder-picker-check" aria-hidden="true" />}
        </div>
      )}
      {renderTree(null, 0)}
      {!allowRoot && !folders.length && (
        <span className="folder-picker-empty">{t('暂无文件夹')}</span>
      )}
    </div>
  );
}
