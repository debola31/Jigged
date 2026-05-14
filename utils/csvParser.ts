/**
 * Shared CSV parsing utility for all import modules.
 *
 * RFC 4180-compliant: newlines inside double-quoted fields are preserved as
 * part of the field value, rather than terminating the row. Falls back to a
 * naive comma split for any row whose column count diverges from the header
 * row (e.g. an unclosed quote that swallowed the rest of the file).
 */

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushRow = () => {
    row.push(field.trim());
    field = '';
    const isEmptyRow = row.length === 1 && row[0] === '';
    if (!isEmptyRow) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field.trim());
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) pushRow();

  // Per-row fallback: if a row's column count diverges from the header,
  // re-parse that row with a naive split. Preserves the legacy resilience
  // for malformed input (e.g. unclosed quotes) without abandoning the
  // whole parse.
  const expectedColumns = rows[0]?.length ?? 0;
  if (expectedColumns > 0) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length !== expectedColumns) {
        rows[i] = rows[i]
          .join(',')
          .split(',')
          .map((s) => s.trim().replace(/^"|"$/g, ''));
      }
    }
  }

  return rows;
}
