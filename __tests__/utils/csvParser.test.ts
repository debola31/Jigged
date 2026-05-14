import { describe, it, expect } from 'vitest';
import { parseCSV } from '@/utils/csvParser';

describe('csvParser', () => {
  describe('parseCSV', () => {
    // ============== Basic Parsing ==============

    it('parses simple CSV without quotes', () => {
      const csv = `name,code,city
John,ABC,New York
Jane,DEF,Chicago`;

      const result = parseCSV(csv);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(['name', 'code', 'city']);
      expect(result[1]).toEqual(['John', 'ABC', 'New York']);
      expect(result[2]).toEqual(['Jane', 'DEF', 'Chicago']);
    });

    it('trims whitespace from values', () => {
      const csv = `name , code , city
  John  ,  ABC  ,  New York  `;

      const result = parseCSV(csv);

      expect(result[0]).toEqual(['name', 'code', 'city']);
      expect(result[1]).toEqual(['John', 'ABC', 'New York']);
    });

    it('handles empty values', () => {
      const csv = `name,code,city
John,,New York
,DEF,`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['John', '', 'New York']);
      expect(result[2]).toEqual(['', 'DEF', '']);
    });

    it('filters out empty lines', () => {
      const csv = `name,code

John,ABC

Jane,DEF

`;

      const result = parseCSV(csv);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(['name', 'code']);
      expect(result[1]).toEqual(['John', 'ABC']);
      expect(result[2]).toEqual(['Jane', 'DEF']);
    });

    // ============== Line Ending Handling ==============

    it('handles LF line endings (Unix)', () => {
      const csv = 'name,code\nJohn,ABC\nJane,DEF';

      const result = parseCSV(csv);

      expect(result).toHaveLength(3);
      expect(result[1]).toEqual(['John', 'ABC']);
    });

    it('handles CRLF line endings (Windows)', () => {
      const csv = 'name,code\r\nJohn,ABC\r\nJane,DEF';

      const result = parseCSV(csv);

      expect(result).toHaveLength(3);
      expect(result[1]).toEqual(['John', 'ABC']);
    });

    it('handles mixed line endings', () => {
      const csv = 'name,code\r\nJohn,ABC\nJane,DEF\r\n';

      const result = parseCSV(csv);

      expect(result).toHaveLength(3);
    });

    // ============== Quoted Fields ==============

    it('handles quoted fields with commas inside', () => {
      const csv = `name,address,city
"Smith, John","123 Main St, Apt 4",Chicago`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['Smith, John', '123 Main St, Apt 4', 'Chicago']);
    });

    it('handles quoted fields without special characters', () => {
      const csv = `name,code
"John","ABC"`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['John', 'ABC']);
    });

    it('handles mixed quoted and unquoted fields', () => {
      const csv = `name,address,code
John,"123 Main St",ABC`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['John', '123 Main St', 'ABC']);
    });

    // ============== Escaped Quotes ==============

    it('handles escaped quotes ("") inside quoted fields', () => {
      const csv = `name,description
"John","He said ""Hello"" to me"`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['John', 'He said "Hello" to me']);
    });

    it('handles multiple escaped quotes', () => {
      const csv = `name,description
"Test","A ""quoted"" word and ""another"""`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['Test', 'A "quoted" word and "another"']);
    });

    it('handles escaped quote at the end of field', () => {
      const csv = `name,description
"Test","Ends with quote"""`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['Test', 'Ends with quote"']);
    });

    // ============== Malformed CSV Handling ==============

    it('falls back to simple split for unclosed quotes', () => {
      const csv = `name,code,city
"John,ABC,New York`;

      const result = parseCSV(csv);

      // Should fall back to simple comma split
      expect(result[1]).toHaveLength(3);
      // Values will be trimmed and quotes stripped
      expect(result[1][0]).toBe('John');
    });

    it('handles rows with different column counts by falling back', () => {
      const csv = `name,code,city
"Unclosed quote,field2`;

      const result = parseCSV(csv);

      // Fallback should produce a result
      expect(result[1]).toBeDefined();
    });

    // ============== Edge Cases ==============

    it('handles single column CSV', () => {
      const csv = `name
John
Jane`;

      const result = parseCSV(csv);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(['name']);
      expect(result[1]).toEqual(['John']);
    });

    it('handles single row CSV', () => {
      const csv = 'name,code,city';

      const result = parseCSV(csv);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(['name', 'code', 'city']);
    });

    it('handles empty CSV', () => {
      const csv = '';

      const result = parseCSV(csv);

      expect(result).toHaveLength(0);
    });

    it('handles CSV with only whitespace lines', () => {
      const csv = `

   `;

      const result = parseCSV(csv);

      expect(result).toHaveLength(0);
    });

    it('handles quoted field spanning entire value', () => {
      const csv = `col1,col2
"entire value is quoted","another quoted"`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['entire value is quoted', 'another quoted']);
    });

    // ============== RFC 4180: Newlines Inside Quoted Fields ==============

    it('preserves LF inside a quoted field as part of the value', () => {
      const csv = `name,description
"Widget","line one\nline two"`;

      const result = parseCSV(csv);

      expect(result).toHaveLength(2);
      expect(result[1]).toEqual(['Widget', 'line one\nline two']);
    });

    it('preserves CRLF inside a quoted field as part of the value', () => {
      const csv = `name,description\r\n"Widget","line one\r\nline two"`;

      const result = parseCSV(csv);

      expect(result).toHaveLength(2);
      expect(result[1]).toEqual(['Widget', 'line one\r\nline two']);
    });

    it('does not shift columns on the row after a multi-line quoted field', () => {
      // Regression for parts-import bug: a quoted multi-line description
      // followed by a numeric legacy_id column must not push the legacy_id
      // into the vendor column of the *next* row.
      const csv = `name,description,legacy_id,vendor
"Part A","2in. x 7in.\nForce measurement system",15354,
"Part B","Single line",15355,Acme`;

      const result = parseCSV(csv);

      expect(result).toHaveLength(3);
      expect(result[1]).toEqual([
        'Part A',
        '2in. x 7in.\nForce measurement system',
        '15354',
        '',
      ]);
      expect(result[2]).toEqual(['Part B', 'Single line', '15355', 'Acme']);
    });

    it('decodes both embedded newlines and escaped quotes in the same field', () => {
      const csv = `name,description
"Widget","line one\nhe said ""hi""\nline three"`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual([
        'Widget',
        'line one\nhe said "hi"\nline three',
      ]);
    });

    it('handles a multi-line quoted field followed by a normal row', () => {
      const csv = `name,description
"A","x\ny"
"B","z"`;

      const result = parseCSV(csv);

      expect(result).toHaveLength(3);
      expect(result[1]).toEqual(['A', 'x\ny']);
      expect(result[2]).toEqual(['B', 'z']);
    });

    it('handles special characters in unquoted fields', () => {
      const csv = `name,email,phone
John,john@example.com,(555) 123-4567`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['John', 'john@example.com', '(555) 123-4567']);
    });

    it('handles unicode characters', () => {
      const csv = `name,city
José,São Paulo
田中,東京`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['José', 'São Paulo']);
      expect(result[2]).toEqual(['田中', '東京']);
    });

    it('handles numbers as strings', () => {
      const csv = `id,amount,rate
1,1000.50,0.15`;

      const result = parseCSV(csv);

      expect(result[1]).toEqual(['1', '1000.50', '0.15']);
    });
  });
});
