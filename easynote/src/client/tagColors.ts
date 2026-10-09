export const TAG_COLOR_COUNT = 8;

export function defaultTagColorIndex(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash % TAG_COLOR_COUNT;
}

export function tagColorIndex(value: string, colors: Record<string, number>) {
  const saved = colors[value];
  return Number.isInteger(saved) && saved >= 0 && saved < TAG_COLOR_COUNT ? saved : defaultTagColorIndex(value);
}
