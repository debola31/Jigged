import { describe, it, expect } from 'vitest';
import {
  extractDxfText,
  classifyTitleBlock,
  decodeMText,
  BinaryDxfError,
} from '@/lib/dxfTextExtract';

/** Build an ASCII DXF body from (code, value) pairs. */
const dxf = (...pairs: Array<[string, string]>): string =>
  pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';

describe('dxfTextExtract', () => {
  describe('decodeMText', () => {
    it('strips the alignment code that hides a caption', () => {
      // Seen verbatim on a real drawing: the raw string is "\LTOLERANCES:".
      // Left undecoded, every dictionary lookup for this caption fails.
      expect(decodeMText('\\LTOLERANCES:')).toBe('TOLERANCES:');
    });

    it('turns \\P into a line break and \\~ into a space', () => {
      expect(decodeMText('LINE ONE\\PLINE TWO')).toBe('LINE ONE\nLINE TWO');
      expect(decodeMText('NO\\~BREAK')).toBe('NO BREAK');
    });

    it('decodes the %% codes that predate MTEXT markup', () => {
      expect(decodeMText('%%c14.0 THRU ALL')).toBe('⌀14.0 THRU ALL');
      expect(decodeMText('0%%d30\'')).toBe("0°30'");
      expect(decodeMText('%%p0.10')).toBe('±0.10');
    });

    it('drops font and height codes but keeps their text', () => {
      expect(decodeMText('\\fArial|b0|i0;\\H1.5x;spacer plate')).toBe('spacer plate');
    });

    it('keeps both halves of a stacked fraction', () => {
      expect(decodeMText('\\S1^2;')).toBe('1/2');
    });

    it('unescapes literal braces and backslashes', () => {
      expect(decodeMText('\\{not a group\\}')).toBe('{not a group}');
    });
  });

  describe('extractDxfText', () => {
    it('reads text, position, height and layer', () => {
      const src = dxf(
        ['0', 'TEXT'], ['8', 'TITLE'], ['1', 'spacer plate'],
        ['10', '323.38'], ['20', '43.12'], ['40', '2.5'],
        ['0', 'ENDSEC'],
      );
      expect(extractDxfText(src)).toEqual([
        { text: 'spacer plate', x: 323.38, y: 43.12, height: 2.5, layer: 'TITLE', kind: 'TEXT' },
      ]);
    });

    it('joins MTEXT continuations — group 3 chunks then the group 1 remainder', () => {
      // THE classic hand-rolled-DXF bug. MTEXT over ~250 chars splits across
      // multiple group-3 chunks with the tail in group 1; reading only group 1
      // silently truncates every long description.
      const src = dxf(
        ['0', 'MTEXT'], ['8', '0'],
        ['3', 'FIRST CHUNK '], ['3', 'SECOND CHUNK '], ['1', 'FINAL TAIL'],
        ['10', '0'], ['20', '0'], ['40', '2'],
        ['0', 'ENDSEC'],
      );
      expect(extractDxfText(src)[0].text).toBe('FIRST CHUNK SECOND CHUNK FINAL TAIL');
    });

    it('treats group 3 on an ATTDEF as a PROMPT, not a continuation', () => {
      // Group 3 is overloaded: continuation on MTEXT, but the fill-in prompt on
      // ATTDEF. Folding the prompt into the text prefixes the template's own
      // label onto its value. Measured on 18 drawings: TITLE_3's prompt is the
      // literal "3rd Title", so seven sheets with an EMPTY title reported their
      // description as "3rd Title", and a Japanese block fused its caption
      // "タイトル" onto "図番：RT-CRANE-X7-8-2".
      const src = dxf(
        ['0', 'ATTDEF'], ['8', '0'], ['2', 'TITLE_3'], ['3', '3rd Title'], ['1', ''],
        ['10', '0'], ['20', '0'], ['40', '2'],
        ['0', 'ATTRIB'], ['8', '0'], ['2', 'TITLE_1'], ['1', 'Base_Rev6_Fold'],
        ['10', '0'], ['20', '0'], ['40', '2'],
        ['0', 'ENDSEC'],
      );
      const ents = extractDxfText(src);
      // The empty ATTDEF must not materialise as a text entity carrying its prompt.
      expect(ents.map((e) => e.text)).toEqual(['Base_Rev6_Fold']);
    });

    it('keeps a non-empty ATTDEF value but exposes its prompt separately', () => {
      const src = dxf(
        ['0', 'ATTDEF'], ['8', '0'], ['2', 'タイトル_001'], ['3', 'タイトル'],
        ['1', '図番：RT-CRANE-X7-8-2'],
        ['10', '0'], ['20', '0'], ['40', '2'],
        ['0', 'ENDSEC'],
      );
      const [e] = extractDxfText(src);
      expect(e.text).toBe('図番：RT-CRANE-X7-8-2');
      expect(e.prompt).toBe('タイトル');
    });

    it('parses CRLF and bare-CR files', () => {
      const body = ['0', 'TEXT', '8', 'L', '1', 'CRLF OK', '10', '1', '20', '2', '40', '3'];
      expect(extractDxfText(body.join('\r\n') + '\r\n')[0].text).toBe('CRLF OK');
      expect(extractDxfText(body.join('\r') + '\r')[0].text).toBe('CRLF OK');
    });

    it('keeps the attribute tag on ATTDEF and ATTRIB', () => {
      const src = dxf(
        ['0', 'ATTRIB'], ['8', '0'], ['2', 'DRAWING_NUMBER'], ['1', '314-092-56133-10'],
        ['10', '0'], ['20', '0'], ['40', '2'],
        ['0', 'ENDSEC'],
      );
      const [e] = extractDxfText(src);
      expect(e.tag).toBe('DRAWING_NUMBER');
      expect(e.kind).toBe('ATTRIB');
    });

    it('defaults a missing height to 2.5 rather than 0', () => {
      // Height is the local scale for every geometry decision downstream, so a
      // zero here would make the search window collapse.
      const src = dxf(['0', 'TEXT'], ['8', '0'], ['1', 'NO HEIGHT'], ['10', '0'], ['20', '0']);
      expect(extractDxfText(src)[0].height).toBe(2.5);
    });

    it('drops entities with no text instead of emitting blanks', () => {
      const src = dxf(['0', 'TEXT'], ['8', '0'], ['1', '   '], ['10', '0'], ['20', '0']);
      expect(extractDxfText(src)).toEqual([]);
    });

    it('rejects a binary DXF with a message that says what to do', () => {
      expect(() => extractDxfText('AutoCAD Binary DXF\r\n\u001a\u0000')).toThrow(BinaryDxfError);
      expect(() => extractDxfText('AutoCAD Binary DXF\r\n')).toThrow(/ASCII DXF/);
    });

    it('survives a truncated final line', () => {
      expect(() => extractDxfText('0\nTEXT\n8\n0\n1\nHALF')).not.toThrow();
    });
  });

  describe('classifyTitleBlock', () => {
    const at = (tag: string) => ({
      text: 'v', x: 0, y: 0, height: 2, layer: '0', kind: 'ATTRIB' as const, tag,
    });

    it('named tags mean extraction is a lookup, no geometry needed', () => {
      expect(classifyTitleBlock([at('DRAWING_NUMBER'), at('REV')])).toBe('named_tags');
    });

    it('AUTOATTR means values without meaning', () => {
      // SolidWorks title blocks are notes linked to custom properties; a note has
      // no name, so the DXF translator invents one. Found in the wild, not one
      // customer's quirk.
      expect(classifyTitleBlock([at('AUTOATTR0'), at('AUTOATTR1')])).toBe('auto_tags');
    });

    it('no attributes at all means the block was exploded into loose text', () => {
      expect(
        classifyTitleBlock([
          { text: 'TITLE:', x: 0, y: 0, height: 1.5, layer: '0', kind: 'TEXT' },
        ]),
      ).toBe('exploded');
    });
  });
});
