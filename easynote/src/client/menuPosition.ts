export function placeMenu(menu: HTMLElement, anchor: { left: number; bottom: number }): void {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
  menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(left + 8, Math.min(anchor.left - 8, left + width - box.width - 8))}px`;
  menu.style.top = `${Math.max(top + 8, Math.min(anchor.bottom + 4, top + height - box.height - 8))}px`;
}
