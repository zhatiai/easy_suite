export type ColumnAlignment = 'left' | 'center' | 'right' | null;

export interface ParsedTable {
  headers: string[];
  alignments: ColumnAlignment[];
  rows: string[][];
}

export function splitRowCells(line: string): string[] {
  const trimmed = line.trim();
  const content = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      current += ch;
      escaped = true;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parseDelimiterCell(cell: string): ColumnAlignment | false {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  const dashes = trimmed.replace(/:/g, '');
  if (!/^---+$/.test(dashes)) return false;
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

export function isDelimiterLine(line: string): boolean {
  const cells = splitRowCells(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => parseDelimiterCell(cell) !== false);
}

export function parseMarkdownTable(lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const delimLine = lines[1];
  if (!headerLine.includes('|') || !isDelimiterLine(delimLine)) return null;

  const rawHeaders = splitRowCells(headerLine);
  const delimAlignments = splitRowCells(delimLine).map(parseDelimiterCell);
  if (rawHeaders.length === 0 || delimAlignments.length === 0) return null;

  const colCount = Math.max(rawHeaders.length, delimAlignments.length);
  const headers = Array.from({ length: colCount }, (_, i) => rawHeaders[i] ?? '');
  const alignments = Array.from({ length: colCount }, (_, i) => {
    const a = delimAlignments[i];
    return a === false ? null : a;
  });

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const rawCells = splitRowCells(lines[i]);
    const row = Array.from({ length: colCount }, (_, j) => rawCells[j] ?? '');
    rows.push(row);
  }

  return { headers, alignments, rows };
}

export function serializeMarkdownTable(table: ParsedTable): string {
  const colCount = Math.max(
    table.headers.length,
    table.alignments.length,
    ...table.rows.map((r) => r.length),
    1,
  );

  const headers = Array.from({ length: colCount }, (_, i) => table.headers[i] ?? '');
  const alignments = Array.from({ length: colCount }, (_, i) => table.alignments[i] ?? null);
  const rows = table.rows.map((r) => Array.from({ length: colCount }, (_, i) => r[i] ?? ''));

  const formatDelim = (align: ColumnAlignment) => {
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    if (align === 'left') return ':---';
    return '---';
  };

  const escapeCell = (c: string) => c.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  const headerLine = `| ${headers.map(escapeCell).join(' | ')} |`;
  const delimLine = `| ${alignments.map(formatDelim).join(' | ')} |`;
  const rowLines = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);

  return [headerLine, delimLine, ...rowLines].join('\n');
}

export function insertRow(table: ParsedTable, atIndex?: number): ParsedTable {
  const colCount = Math.max(table.headers.length, 1);
  const newRow = new Array(colCount).fill('');
  const rows = [...table.rows];
  if (atIndex === undefined || atIndex >= rows.length || atIndex < 0) {
    rows.push(newRow);
  } else {
    rows.splice(atIndex, 0, newRow);
  }
  return { ...table, rows };
}

export function deleteRow(table: ParsedTable, atIndex: number): ParsedTable {
  if (atIndex < 0 || atIndex >= table.rows.length) return table;
  const rows = table.rows.filter((_, i) => i !== atIndex);
  return { ...table, rows };
}

export function insertColumn(table: ParsedTable, atIndex?: number): ParsedTable {
  const headers = [...table.headers];
  const alignments = [...table.alignments];
  const idx = atIndex === undefined || atIndex >= headers.length || atIndex < 0 ? headers.length : atIndex;

  headers.splice(idx, 0, '');
  alignments.splice(idx, 0, null);
  const rows = table.rows.map((r) => {
    const nextRow = [...r];
    nextRow.splice(idx, 0, '');
    return nextRow;
  });
  return { headers, alignments, rows };
}

export function deleteColumn(table: ParsedTable, atIndex: number): ParsedTable {
  if (table.headers.length <= 1) return table;
  if (atIndex < 0 || atIndex >= table.headers.length) return table;

  const headers = table.headers.filter((_, i) => i !== atIndex);
  const alignments = table.alignments.filter((_, i) => i !== atIndex);
  const rows = table.rows.map((r) => r.filter((_, i) => i !== atIndex));
  return { headers, alignments, rows };
}

export function setCell(
  table: ParsedTable,
  rowIndex: number,
  colIndex: number,
  value: string,
): ParsedTable {
  if (rowIndex === -1) {
    if (colIndex < 0 || colIndex >= table.headers.length) return table;
    const headers = [...table.headers];
    headers[colIndex] = value;
    return { ...table, headers };
  }
  if (rowIndex < 0 || rowIndex >= table.rows.length) return table;
  const rows = table.rows.map((r, i) => {
    if (i !== rowIndex) return r;
    const next = [...r];
    next[colIndex] = value;
    return next;
  });
  return { ...table, rows };
}
