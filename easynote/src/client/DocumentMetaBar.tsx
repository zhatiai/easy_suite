import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { Check, ChevronDown, Folder as FolderIcon, FolderOpen, Plus, Search, Tag, X } from 'lucide-react';
import type { Folder, Note } from '../shared/types';
import { dateLocale, t, uiLanguage } from './i18n';
import { tagColorIndex } from './tagColors';

interface DocumentMetaBarProps {
  note: Note;
  folders: Folder[];
  allTags: string[];
  tagColors: Record<string, number>;
  tagCounts: Record<string, number>;
  query: string;
  pickerRef: RefObject<HTMLDetailsElement | null>;
  disabled: boolean;
  setQuery(value: string): void;
  setFolder(folderId: string | null): void;
  setTags(tags: string[]): void;
  reportError(message: string): void;
}

export function DocumentMetaBar(props: DocumentMetaBarProps) {
  const folderPickerRef = useRef<HTMLDetailsElement>(null);
  const foldersByParent = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const folder of props.folders) {
      const siblings = map.get(folder.parentId) ?? [];
      siblings.push(folder);
      map.set(folder.parentId, siblings);
    }
    for (const siblings of map.values()) siblings.sort((left, right) => left.name.localeCompare(right.name, dateLocale()));
    return map;
  }, [props.folders]);
  const selectedFolder = props.note.folderId ? props.folders.find((folder) => folder.id === props.note.folderId) : null;

  useEffect(() => {
    const closeFolderPicker = (focusTrigger = false) => {
      const picker = folderPickerRef.current;
      if (!picker?.open) return;
      picker.open = false;
      if (focusTrigger) picker.querySelector<HTMLElement>('summary')?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const picker = folderPickerRef.current;
      if (picker?.open && !picker.contains(event.target as Node)) closeFolderPicker();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !folderPickerRef.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      closeFolderPicker(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const availableTags = [...new Set([...props.allTags, ...props.note.tags])]
    .sort((left, right) => left.localeCompare(right, dateLocale()))
    .filter((tag) => !props.query.trim() || tag.toLocaleLowerCase().includes(props.query.trim().toLocaleLowerCase()));
  const createTag = () => {
    const value = props.query.trim();
    if (!value) return;
    if (value.length > 40 || value.includes(',') || value.includes('，')) { props.reportError(t('标签必须为 1-40 个字符，且不能包含逗号。')); return; }
    if (!props.note.tags.includes(value) && props.note.tags.length >= 20) { props.reportError(t('最多 20 个标签。')); return; }
    if (!props.note.tags.includes(value)) props.setTags([...props.note.tags, value]);
    props.setQuery('');
  };
  const closePicker = () => {
    if (!props.pickerRef.current) return;
    props.pickerRef.current.open = false;
    props.pickerRef.current.querySelector<HTMLElement>('summary')?.focus();
  };
  const chooseFolder = (folderId: string | null) => {
    props.setFolder(folderId);
    if (folderPickerRef.current) folderPickerRef.current.open = false;
    folderPickerRef.current?.querySelector<HTMLElement>('summary')?.focus();
  };
  const folderOptions = (parentId: string | null, depth = 0): ReactNode => (foldersByParent.get(parentId) ?? []).map((folder) => <div key={folder.id}>
    <button type="button" className="folder-picker-option" role="menuitemradio" aria-checked={props.note.folderId === folder.id} disabled={props.disabled}
      style={{ '--folder-option-depth': depth } as React.CSSProperties} onClick={() => chooseFolder(folder.id)}>
      <FolderIcon size={16} aria-hidden="true" /><span>{folder.name}</span>{props.note.folderId === folder.id && <Check size={15} className="folder-picker-check" aria-hidden="true" />}
    </button>
    {folderOptions(folder.id, depth + 1)}
  </div>);
  return <div className="document-meta document-meta-bar">
    <details className="note-folder-picker" ref={folderPickerRef} onToggle={(event) => {
      if (!event.currentTarget.open) return;
      if (props.disabled) { event.currentTarget.open = false; return; }
      if (props.pickerRef.current) props.pickerRef.current.open = false;
    }}>
      <summary className="meta-control folder-picker-summary" aria-label={t('所属文件夹')} aria-disabled={props.disabled}>
        <FolderOpen size={16} aria-hidden="true" /><span>{selectedFolder?.name ?? t('根目录')}</span><ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="folder-picker-popover" role="menu" aria-label={t('所属文件夹')}>
        <button type="button" className="folder-picker-option" role="menuitemradio" aria-checked={!props.note.folderId} disabled={props.disabled} onClick={() => chooseFolder(null)}>
          <FolderOpen size={16} aria-hidden="true" /><span>{t('根目录')}</span>{!props.note.folderId && <Check size={15} className="folder-picker-check" aria-hidden="true" />}
        </button>
        <div className="folder-picker-divider" aria-hidden="true" />
        <div className="folder-picker-options">{folderOptions(null)}</div>
      </div>
    </details>
    <details className="tag-picker meta-tag-picker" ref={props.pickerRef} onToggle={(event) => {
      if (!event.currentTarget.open) return;
      if (folderPickerRef.current) folderPickerRef.current.open = false;
      event.currentTarget.querySelector('input')?.focus();
    }}>
      <summary className="tag-picker-summary" aria-label={t('添加标签')}><Tag size={16} /><span>{props.note.tags.length ? props.note.tags.length === 1 ? props.note.tags[0] : t('{0} 个标签', props.note.tags.length) : t('添加标签')}</span><ChevronDown size={14} /></summary>
      <div className="tag-picker-popover" role="group" aria-label={t('选择或创建标签')}>
        <div className="tag-picker-search"><Search size={17} /><input aria-label={t('搜索或回车新建标签…')} placeholder={t('搜索或回车新建标签…')} value={props.query}
          onChange={(event) => props.setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closePicker(); } else if (event.key === 'Enter') { event.preventDefault(); createTag(); } }} />
          <button type="button" className="tag-picker-close-btn" aria-label={t('close')} onClick={closePicker}><X size={14} /></button>
        </div>
        <div className="tag-picker-options">
          {availableTags.map((tag) => <label key={tag} className="tag-picker-option"><input type="checkbox" checked={props.note.tags.includes(tag)} disabled={props.disabled || (!props.note.tags.includes(tag) && props.note.tags.length >= 20)}
            onChange={(event) => props.setTags(event.target.checked ? [...props.note.tags, tag] : props.note.tags.filter((value) => value !== tag))} />
            <span className={`tag-color-dot tag-color-${tagColorIndex(tag, props.tagColors)}`} aria-hidden="true" /><span>{tag}</span><small>{props.tagCounts[tag] || ''}</small></label>)}
          {!availableTags.length && <span className="tag-picker-empty">{props.query.trim() ? t('按回车创建新标签') : t('no_tags')}</span>}
        </div>
        {props.query.trim() && !availableTags.some((tag) => tag === props.query.trim()) && <button className="tag-picker-create" onClick={createTag}><Plus size={16} />{t('新建标签')}</button>}
      </div>
    </details>
    <span className="meta-separator" aria-hidden="true" />
    <span className="meta-timestamp"><time>{new Date(props.note.updatedAt).toLocaleString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span>{uiLanguage() === 'en' ? `Rev ${props.note.revision}` : `修订 ${props.note.revision}`}</span></span>
  </div>;
}
