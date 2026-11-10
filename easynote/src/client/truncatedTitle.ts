export function updateTruncatedTitle(owner: HTMLElement, label: HTMLElement | null = owner): void {
  if (label && label.scrollWidth > label.clientWidth && label.textContent) {
    owner.title = label.textContent;
  } else {
    owner.removeAttribute('title');
  }
}
