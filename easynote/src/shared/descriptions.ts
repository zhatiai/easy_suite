// A leading Markdown blockquote is the note description; the body remains authoritative.
function leadingQuote(content: string): string {
  return content.match(/^(?:>[^\n]*(?:\n|$))+/)?.[0] ?? '';
}

export function noteDescription(content: string): string {
  return leadingQuote(content).trimEnd().split('\n').map((line) => line.replace(/^> ?/, '').replace(/\r$/, '')).join('\n').trim();
}

export function withNoteDescription(content: string, description: string): string {
  const quote = leadingQuote(content);
  const body = quote ? content.slice(quote.length).replace(/^\r?\n/, '') : content;
  const text = description.trim().replace(/\r\n?/g, '\n');
  return text ? `${text.split('\n').map((line) => `> ${line}`).join('\n')}\n\n${body}` : body;
}
