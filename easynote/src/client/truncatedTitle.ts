export function isTitleTruncated(label: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(label);
  return label.scrollWidth > label.clientWidth
    || range.getBoundingClientRect().width > label.getBoundingClientRect().width + 0.5;
}
