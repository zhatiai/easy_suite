import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isTitleTruncated } from './truncatedTitle';

function positionTooltip(tooltip: HTMLElement, owner: HTMLElement, label: HTMLElement) {
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
  const left = Math.max(viewportLeft + 8, Math.min(label.getBoundingClientRect().left, viewportRight - 8));
  tooltip.style.maxWidth = `${Math.max(0, viewportRight - left - 8)}px`;
  tooltip.style.maxHeight = `${Math.max(0, viewportBottom - viewportTop - 16)}px`;
  const height = tooltip.getBoundingClientRect().height;
  const row = owner.getBoundingClientRect();
  const above = row.top - height - 4;
  const top = above >= viewportTop + 8 ? above : row.bottom + 4;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(viewportTop + 8, Math.min(top, viewportBottom - height - 8))}px`;
}

export function FullNameTooltip() {
  const id = useId();
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tooltip = tooltipRef.current;
    const text = tooltip?.firstElementChild;
    if (!tooltip || !text) return;
    let owner: HTMLElement | null = null;
    let label: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ready = false;

    const hide = () => {
      tooltip.hidePopover();
      if (owner) {
        const descriptions = (owner.getAttribute('aria-describedby') ?? '').split(' ').filter((value) => value && value !== id);
        if (descriptions.length) owner.setAttribute('aria-describedby', descriptions.join(' '));
        else owner.removeAttribute('aria-describedby');
      }
    };
    const update = () => {
      const content = owner?.dataset.fullNameContent;
      if (!ready || !owner?.isConnected || !label || (!content && !isTitleTruncated(label))) {
        hide();
        return;
      }
      text.textContent = content || label.textContent;
      tooltip.showPopover();
      positionTooltip(tooltip, owner, label);
      const descriptions = new Set((owner.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean));
      descriptions.add(id);
      owner.setAttribute('aria-describedby', [...descriptions].join(' '));
    };
    const resizeObserver = new ResizeObserver(update);
    const textObserver = new MutationObserver(update);
    const dismiss = () => {
      clearTimeout(timer);
      resizeObserver.disconnect();
      textObserver.disconnect();
      hide();
      owner = null;
      label = null;
      ready = false;
    };
    const findOwner = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLElement>('[data-full-name]') : null;
    const show = (target: EventTarget | null, immediate = false) => {
      const next = findOwner(target);
      if (next === owner) return;
      dismiss();
      if (!next) return;
      owner = next;
      label = next.querySelector<HTMLElement>('[data-full-name-label]') ?? next;
      resizeObserver.observe(label);
      textObserver.observe(next, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-full-name-content'] });
      timer = setTimeout(() => { ready = true; update(); }, immediate ? 0 : 200);
    };
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.buttons === 0) show(event.target);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (owner && !(event.relatedTarget instanceof Node && owner.contains(event.relatedTarget))) dismiss();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.matches(':focus-visible')) show(event.target, true);
    };
    const onScroll = () => {
      if (!owner) return;
      clearTimeout(timer);
      hide();
      ready = false;
      timer = setTimeout(() => {
        if (owner?.matches(':hover') || owner?.contains(document.activeElement)) {
          ready = true;
          update();
        } else dismiss();
      }, 200);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointermove', onPointerOver, { passive: true });
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', dismiss);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      dismiss();
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointermove', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', dismiss);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [id]);

  return createPortal(<div ref={tooltipRef} id={id} className="full-name-tooltip" role="tooltip" popover="manual"><span /></div>, document.body);
}
