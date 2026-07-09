import { describe, it, expect } from 'vitest';
import { escapeIlikePattern, orIlikeValue } from '@/utils/searchFilter';

describe('escapeIlikePattern', () => {
  it('leaves a plain term unchanged', () => {
    expect(escapeIlikePattern('PART001')).toBe('PART001');
  });

  it('escapes ILIKE wildcards % and _ so they match literally', () => {
    expect(escapeIlikePattern('50%_off')).toBe('50\\%\\_off');
  });

  it('escapes backslashes first', () => {
    expect(escapeIlikePattern('a\\b')).toBe('a\\\\b');
  });

  it('caps length at 100 chars', () => {
    expect(escapeIlikePattern('a'.repeat(150))).toHaveLength(100);
  });
});

describe('orIlikeValue', () => {
  it('double-quotes a plain term as a %substring% pattern', () => {
    expect(orIlikeValue('PART001')).toBe('"%PART001%"');
  });

  it('keeps parentheses literal inside the quoted value (the reported bug)', () => {
    // Without the double-quoting, the `)` terminated the PostgREST `.or()`
    // group early and the part returned zero rows.
    expect(orIlikeValue('F40750-1 (REX-76)')).toBe('"%F40750-1 (REX-76)%"');
  });

  it('keeps commas literal inside the quoted value (no filter injection)', () => {
    expect(orIlikeValue('a,b')).toBe('"%a,b%"');
  });

  it('escapes an embedded double-quote', () => {
    expect(orIlikeValue('a"b')).toBe('"%a\\"b%"');
  });

  it('double-escapes wildcards for the quoted-value layer', () => {
    expect(orIlikeValue('50%')).toBe('"%50\\\\%%"');
  });

  it('caps length at 100 chars before wrapping', () => {
    // 100 chars + leading/trailing % + two surrounding quotes = 104.
    expect(orIlikeValue('a'.repeat(150))).toHaveLength(104);
  });
});
